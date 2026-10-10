//! Git worktrees for parallel agent tasks.
//!
//! A task can run in its own worktree: `<root>/<repo-key>/<slug>` on branch `octopus/<slug>`,
//! where `root` is `~/.octopus/worktrees` and `repo-key` is the main folder name plus a hash of
//! its path. The worktree remembers the commit it started from in the repository config
//! (`branch.octopus/<slug>.octopusBase`), so that survives restarts.
//!
//! Applying a worktree writes its changes into the main folder as uncommitted changes. The main
//! index is never touched and the worktree itself is never modified.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const BRANCH_PREFIX: &str = "octopus/";
const BASE_KEY: &str = "octopusBase";
const MAX_NAME_CHARS: usize = 40;
/// Overrides the worktrees root (used for manual testing; tests pass the root explicitly).
const ROOT_ENV: &str = "OCTOPUS_WORKTREES_DIR";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Folder to work in: the worktree root, or the matching subfolder right after creation.
    pub path: String,
    /// Top folder of the worktree.
    pub root: String,
    pub branch: String,
    /// Commit the worktree started from.
    pub base: String,
    pub head: String,
    /// Files that differ from `base`: committed, uncommitted and untracked (not ignored).
    pub changed_files: u32,
    /// Creation time of the worktree folder, ms since the Unix epoch.
    pub created_at: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    /// Every path the worktree changed relative to its base.
    pub files: Vec<String>,
    /// Paths that could not be merged cleanly. Text conflicts keep markers in the file.
    pub conflicts: Vec<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Creates a worktree of the repository at `cwd` on a new `octopus/<slug>` branch.
#[tauri::command]
pub async fn worktree_create(cwd: String, name: Option<String>) -> Result<WorktreeInfo, String> {
    blocking(move || create_sync(&cwd, name.as_deref(), &default_root()?)).await
}

/// Worktrees Octopus created for the repository at `cwd`.
#[tauri::command]
pub async fn worktree_list(cwd: String) -> Result<Vec<WorktreeInfo>, String> {
    blocking(move || list_sync(&cwd, &default_root()?)).await
}

/// Brings the changes of the worktree at `path` into the main folder as uncommitted changes.
#[tauri::command]
pub async fn worktree_apply(cwd: String, path: String) -> Result<ApplyResult, String> {
    blocking(move || apply_sync(&cwd, &path, &default_root()?)).await
}

/// Removes the worktree at `path`, and its branch when `delete_branch` is set.
#[tauri::command]
pub async fn worktree_remove(cwd: String, path: String, delete_branch: bool) -> Result<(), String> {
    blocking(move || remove_sync(&cwd, &path, delete_branch, &default_root()?)).await
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Внутренняя ошибка: {e}"))?
}

/// `~/.octopus/worktrees`, or the folder named by `OCTOPUS_WORKTREES_DIR`.
fn default_root() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os(ROOT_ENV).filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "Не найдена домашняя папка".to_string())?;
    Ok(PathBuf::from(home).join(".octopus").join("worktrees"))
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

/// PATH of the user's login shell, so `git` resolves as in a terminal.
fn shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let from_shell = Command::new(shell)
            .args(["-lc", "printf %s \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            // The login shell may print banners before PATH; PATH is the last line.
            .and_then(|s| s.lines().last().map(str::to_string))
            .filter(|p| !p.trim().is_empty());
        from_shell.unwrap_or_else(|| {
            let h = std::env::var("HOME").unwrap_or_default();
            format!(
                "/opt/homebrew/bin:/usr/local/bin:{h}/.bun/bin:{h}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            )
        })
    })
}

struct GitOut {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

/// Runs `git -C dir args`, feeding `input` to stdin when given.
fn git_raw(dir: &Path, args: &[&str], input: Option<&[u8]>) -> Result<GitOut, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("PATH", shell_path())
        .env("LC_ALL", "C")
        // Never wait for a credential prompt; the app has no terminal.
        .env("GIT_TERMINAL_PROMPT", "0")
        // Paths given after `--` are file names, never globs.
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Не удалось запустить git".to_string())?;
    if let (Some(data), Some(mut stdin)) = (input, child.stdin.take()) {
        let data = data.to_vec();
        // Written from a thread so that a large input cannot block the output reads.
        thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    let out = child
        .wait_with_output()
        .map_err(|_| "Не удалось запустить git".to_string())?;
    Ok(GitOut {
        success: out.status.success(),
        code: out.status.code(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

/// Trimmed stdout of a successful git call. On failure: the first useful line of git's output.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_raw(dir, args, None)?;
    if out.success {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(first_error_line(&out.stderr))
    }
}

/// Raw stdout of a successful git call.
fn git_bytes(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git_raw(dir, args, None)?;
    if out.success {
        Ok(out.stdout)
    } else {
        Err(first_error_line(&out.stderr))
    }
}

/// Trimmed stdout of a successful git call; None on failure or empty output.
fn git_opt(dir: &Path, args: &[&str]) -> Option<String> {
    let out = git_raw(dir, args, None).ok()?;
    if !out.success {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The line that explains a failure: a "fatal:" or "error:" line when there is one.
fn first_error_line(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let picked = lines
        .iter()
        .find(|l| l.starts_with("fatal:") || l.starts_with("error:"))
        .or(lines.first());
    match picked {
        Some(line) => line
            .trim_start_matches("fatal:")
            .trim_start_matches("error:")
            .trim()
            .to_string(),
        None => "Ошибка git".to_string(),
    }
}

fn ref_exists(dir: &Path, full_ref: &str) -> bool {
    git_raw(dir, &["show-ref", "--verify", "--quiet", full_ref], None).is_ok_and(|o| o.success)
}

/// Splits NUL-separated git output into paths.
fn nul_list(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn real(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|_| "Папка проекта не найдена".to_string())
}

fn real_or(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

// ---------------------------------------------------------------------------
// Repository and worktree discovery
// ---------------------------------------------------------------------------

/// Top folder of the main worktree of the repository that contains `cwd`.
fn main_worktree(cwd: &Path) -> Result<PathBuf, String> {
    if !cwd.is_dir() {
        return Err("Папка проекта не найдена".to_string());
    }
    if git_opt(cwd, &["rev-parse", "--is-inside-work-tree"]).as_deref() != Some("true") {
        return Err("Папка проекта не под git".to_string());
    }
    let list = git(cwd, &["worktree", "list", "--porcelain"])
        .map_err(|_| "Не удалось прочитать список рабочих копий".to_string())?;
    // The first entry of `worktree list` is always the main worktree.
    let first = list
        .lines()
        .find_map(|l| l.strip_prefix("worktree "))
        .ok_or_else(|| "Не удалось прочитать список рабочих копий".to_string())?;
    real(Path::new(first))
}

/// Folder name of the main worktree plus an 8-hex FNV-1a hash of its full path.
fn repo_key(main: &Path) -> String {
    let name = main
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let clean: String = name
        .chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let stem = if clean.is_empty() {
        "repo"
    } else {
        clean.as_str()
    };
    format!("{stem}-{:08x}", fnv1a32(main.to_string_lossy().as_bytes()))
}

fn fnv1a32(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5u32, |h, b| {
        (h ^ u32::from(*b)).wrapping_mul(0x0100_0193)
    })
}

/// A worktree Octopus created: under this repository's folder and on an `octopus/` branch.
struct Owned {
    path: PathBuf,
    branch: String,
    head: String,
}

/// Prunes stale worktree entries, then lists this repository's Octopus worktrees.
fn owned_worktrees(main: &Path, key_dir: &Path) -> Result<Vec<Owned>, String> {
    let _ = git_raw(main, &["worktree", "prune"], None);
    let text = git(main, &["worktree", "list", "--porcelain"])
        .map_err(|_| "Не удалось прочитать список рабочих копий".to_string())?;
    let keydir = real_or(key_dir);
    let mut owned = Vec::new();
    for block in text.split("\n\n") {
        let mut path = None;
        let mut head = String::new();
        let mut branch = None;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(p));
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = h.to_string();
            } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                branch = Some(b.to_string());
            }
        }
        if let (Some(path), Some(branch)) = (path, branch) {
            if branch.starts_with(BRANCH_PREFIX) && path.starts_with(&keydir) {
                owned.push(Owned { path, branch, head });
            }
        }
    }
    Ok(owned)
}

/// The worktree that `path` belongs to (it may be the worktree root or a folder inside it).
fn find_owned(main: &Path, key_dir: &Path, path: &str) -> Result<Owned, String> {
    if !Path::new(path).is_absolute() {
        return Err("Рабочая копия не найдена".to_string());
    }
    let target = fs::canonicalize(path).map_err(|_| "Рабочая копия не найдена".to_string())?;
    owned_worktrees(main, key_dir)?
        .into_iter()
        .filter(|o| target.starts_with(&o.path))
        .max_by_key(|o| o.path.components().count())
        .ok_or_else(|| "Это не рабочая копия Octopus".to_string())
}

/// Commit the worktree started from. Falls back to the merge base with the main HEAD when the
/// config entry is missing.
fn base_commit(main: &Path, branch: &str) -> Option<String> {
    git_opt(
        main,
        &["config", "--get", &format!("branch.{branch}.{BASE_KEY}")],
    )
    .or_else(|| git_opt(main, &["merge-base", branch, "HEAD"]))
}

fn info_of(main: &Path, owned: &Owned) -> WorktreeInfo {
    let base = base_commit(main, &owned.branch).unwrap_or_default();
    let changed_files = changed_paths(&owned.path, &base)
        .map(|set| set.len() as u32)
        .unwrap_or(0);
    let path = owned.path.to_string_lossy().into_owned();
    WorktreeInfo {
        path: path.clone(),
        root: path,
        branch: owned.branch.clone(),
        base,
        head: owned.head.clone(),
        changed_files,
        created_at: mtime_ms(&owned.path),
    }
}

/// Paths that differ from `base` in the worktree: tracked changes (committed or not) plus
/// untracked files that are not ignored.
fn changed_paths(wt: &Path, base: &str) -> Result<BTreeSet<String>, String> {
    let mut paths = BTreeSet::new();
    paths.extend(nul_list(&git_bytes(
        wt,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?));
    paths.extend(nul_list(&git_bytes(
        wt,
        &["diff", "--name-only", "--no-renames", "-z", base],
    )?));
    Ok(paths)
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

fn create_sync(cwd: &str, name: Option<&str>, root: &Path) -> Result<WorktreeInfo, String> {
    let cwd = Path::new(cwd);
    let main = main_worktree(cwd)?;
    let top = git(cwd, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "Не удалось прочитать папку проекта".to_string())?;
    // "apps/web/" when cwd is a subfolder of the worktree, empty at the top.
    let prefix = git_opt(cwd, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    let base = git_opt(cwd, &["rev-parse", "--verify", "-q", "HEAD^{commit}"])
        .ok_or_else(|| "Нужен хотя бы один коммит".to_string())?;

    let key_dir = root.join(repo_key(&main));
    fs::create_dir_all(&key_dir)
        .map_err(|_| "Не удалось создать папку рабочих копий".to_string())?;
    let key_dir = real(&key_dir)?;
    let (path, branch) = unused_slot(&main, &key_dir, name)?;
    let wt = path.to_string_lossy().into_owned();

    git(
        Path::new(&top),
        &[
            "worktree",
            "add",
            "-b",
            branch.as_str(),
            wt.as_str(),
            base.as_str(),
        ],
    )
    .map_err(|e| format!("Не удалось создать рабочую копию: {e}"))?;

    let config_key = format!("branch.{branch}.{BASE_KEY}");
    if let Err(e) = git(&main, &["config", config_key.as_str(), base.as_str()]) {
        discard(&main, &wt, &branch);
        return Err(format!("Не удалось сохранить базовый коммит: {e}"));
    }

    let sub = if prefix.is_empty() {
        path.clone()
    } else {
        path.join(prefix.trim_end_matches('/'))
    };
    // The matching folder may be untracked in the project; keep the agent's starting folder.
    let _ = fs::create_dir_all(&sub);

    Ok(WorktreeInfo {
        path: sub.to_string_lossy().into_owned(),
        root: wt,
        branch,
        base: base.clone(),
        head: base,
        changed_files: 0,
        created_at: mtime_ms(&path),
    })
}

/// Removes a worktree that failed halfway through creation.
fn discard(main: &Path, wt: &str, branch: &str) {
    let _ = git(main, &["worktree", "remove", "--force", wt]);
    let _ = git(main, &["branch", "-D", branch]);
}

/// A folder path and branch name that are not taken yet.
fn unused_slot(
    main: &Path,
    key_dir: &Path,
    name: Option<&str>,
) -> Result<(PathBuf, String), String> {
    for _ in 0..16 {
        let slug = new_slug(name, next_seed());
        let path = key_dir.join(&slug);
        let branch = format!("{BRANCH_PREFIX}{slug}");
        if !path.exists() && !ref_exists(main, &format!("refs/heads/{branch}")) {
            return Ok((path, branch));
        }
    }
    Err("Не удалось подобрать имя рабочей копии".to_string())
}

/// `<name>-<4 hex>`, or `task-<4 hex>` when there is no usable name.
fn new_slug(name: Option<&str>, seed: u64) -> String {
    let hex = format!("{:04x}", mix64(seed) & 0xffff);
    let stem = name.map(slug_stem).unwrap_or_default();
    if stem.is_empty() {
        format!("task-{hex}")
    } else {
        format!("{stem}-{hex}")
    }
}

/// Lowercase ASCII letters and digits, other characters become single dashes, at most
/// MAX_NAME_CHARS long.
fn slug_stem(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let cut: String = out.chars().take(MAX_NAME_CHARS).collect();
    cut.trim_end_matches('-').to_string()
}

static SEED_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Different on every call, so that names rarely repeat.
fn next_seed() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    nanos ^ (u64::from(std::process::id()) << 32) ^ SEED_COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// splitmix64 finalizer: spreads the seed over all bits.
fn mix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

fn list_sync(cwd: &str, root: &Path) -> Result<Vec<WorktreeInfo>, String> {
    let main = main_worktree(Path::new(cwd))?;
    let key_dir = root.join(repo_key(&main));
    let mut items: Vec<WorktreeInfo> = owned_worktrees(&main, &key_dir)?
        .iter()
        .map(|o| info_of(&main, o))
        .collect();
    items.sort_by_key(|i| i.created_at);
    Ok(items)
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/// One side of a file: missing, a regular file, or a symlink (its target as bytes).
#[derive(Debug, PartialEq)]
enum Content {
    Absent,
    File { exec: bool, bytes: Vec<u8> },
    Link(Vec<u8>),
}

enum Merged {
    Clean(Content),
    /// Text conflict with markers (Some) or a conflict that keeps the project file (None).
    Conflict(Option<Content>),
}

/// Writes the worktree's changes into the main folder, as uncommitted changes.
///
/// For each changed path, with `ours` the main folder's file, `ancestor` the file at the base
/// commit and `theirs` the worktree's file:
/// - ours == theirs: nothing to do;
/// - ours == ancestor: the main file is untouched locally, so it takes theirs;
/// - otherwise a three-way text merge (`git merge-file`), which leaves markers on conflict.
///
/// `git apply --3way` is not used: it refuses to run when a file has unstaged changes.
fn apply_sync(cwd: &str, path: &str, root: &Path) -> Result<ApplyResult, String> {
    let main = main_worktree(Path::new(cwd))?;
    let key_dir = root.join(repo_key(&main));
    let owned = find_owned(&main, &key_dir, path)?;
    let base = base_commit(&main, &owned.branch)
        .ok_or_else(|| "У рабочей копии нет базового коммита".to_string())?;
    let files: Vec<String> = changed_paths(&owned.path, &base)
        .map_err(|e| format!("Не удалось прочитать изменения рабочей копии: {e}"))?
        .into_iter()
        .collect();
    if files.is_empty() {
        return Ok(ApplyResult::default());
    }

    let wt_root = real(&owned.path)?;
    let main_root = real(&main)?;
    let base_tree = tree_entries(&main, &base)?;

    // Decide every path before the first write.
    let mut plan: Vec<(String, Content)> = Vec::new();
    let mut conflicts = Vec::new();
    for rel in &files {
        check_rel_path(rel)?;
        let theirs = read_content(&wt_root, rel)?;
        let ours = read_content(&main_root, rel)?;
        if ours == theirs {
            continue;
        }
        let ancestor = base_content(&main, &base_tree, rel)?;
        if ours == ancestor {
            plan.push((rel.clone(), theirs));
            continue;
        }
        match merge_contents(&ours, &ancestor, &theirs)? {
            Merged::Clean(content) => plan.push((rel.clone(), content)),
            Merged::Conflict(Some(content)) => {
                plan.push((rel.clone(), content));
                conflicts.push(rel.clone());
            }
            Merged::Conflict(None) => conflicts.push(rel.clone()),
        }
    }

    // Removals first, so that a file replaced by a folder (or the reverse) can be written.
    for (rel, content) in &plan {
        if *content == Content::Absent {
            write_or_remove(&main_root, rel, content)?;
        }
    }
    for (rel, content) in &plan {
        if *content != Content::Absent {
            write_or_remove(&main_root, rel, content)?;
        }
    }
    Ok(ApplyResult { files, conflicts })
}

/// Path -> (mode, object id) of every entry in `commit`.
fn tree_entries(main: &Path, commit: &str) -> Result<HashMap<String, (String, String)>, String> {
    let out = git_bytes(main, &["ls-tree", "-r", "-z", commit])
        .map_err(|e| format!("Не удалось прочитать базовый коммит: {e}"))?;
    let mut map = HashMap::new();
    for record in String::from_utf8_lossy(&out).split('\0') {
        // "<mode> SP <type> SP <object> TAB <path>"
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        let mut fields = meta.split(' ');
        if let (Some(mode), Some(_kind), Some(oid)) = (fields.next(), fields.next(), fields.next())
        {
            map.insert(path.to_string(), (mode.to_string(), oid.to_string()));
        }
    }
    Ok(map)
}

/// The file at `rel` in the base commit.
fn base_content(
    main: &Path,
    tree: &HashMap<String, (String, String)>,
    rel: &str,
) -> Result<Content, String> {
    let Some((mode, oid)) = tree.get(rel) else {
        return Ok(Content::Absent);
    };
    // Submodules are not part of the checkpoint-style content; treat them as absent.
    if mode == "160000" {
        return Ok(Content::Absent);
    }
    let bytes = git_bytes(main, &["cat-file", "blob", oid.as_str()])
        .map_err(|e| format!("Не удалось прочитать файл из базового коммита: {e}"))?;
    Ok(match mode.as_str() {
        "120000" => Content::Link(bytes),
        "100755" => Content::File { exec: true, bytes },
        _ => Content::File { exec: false, bytes },
    })
}

/// Reads the file at `rel` under `root` without following a symlink at the last component.
fn read_content(root: &Path, rel: &str) -> Result<Content, String> {
    let target = resolve_inside(root, rel)?;
    let Ok(meta) = fs::symlink_metadata(&target) else {
        return Ok(Content::Absent);
    };
    if meta.file_type().is_symlink() {
        let link = fs::read_link(&target).map_err(|_| "Не удалось прочитать файл".to_string())?;
        return Ok(Content::Link(
            link.to_string_lossy().into_owned().into_bytes(),
        ));
    }
    if !meta.is_file() {
        return Ok(Content::Absent);
    }
    let bytes = fs::read(&target).map_err(|_| "Не удалось прочитать файл".to_string())?;
    Ok(Content::File {
        exec: is_executable(&meta),
        bytes,
    })
}

fn merge_contents(ours: &Content, ancestor: &Content, theirs: &Content) -> Result<Merged, String> {
    let (Content::File { bytes: o, .. }, Content::File { exec, bytes: t }) = (ours, theirs) else {
        // Symlinks, and deletions on either side, are not merged: the project file is kept.
        return Ok(Merged::Conflict(None));
    };
    let base: &[u8] = match ancestor {
        Content::Absent => &[],
        Content::File { bytes, .. } => bytes,
        Content::Link(_) => return Ok(Merged::Conflict(None)),
    };
    if [o.as_slice(), base, t.as_slice()]
        .iter()
        .any(|b| b.contains(&0))
    {
        return Ok(Merged::Conflict(None));
    }
    let (bytes, conflicted) = run_merge_file(o, base, t)?;
    let content = Content::File { exec: *exec, bytes };
    Ok(if conflicted {
        Merged::Conflict(Some(content))
    } else {
        Merged::Clean(content)
    })
}

/// `git merge-file` on three texts. Returns the merged text and whether it has conflicts.
fn run_merge_file(ours: &[u8], base: &[u8], theirs: &[u8]) -> Result<(Vec<u8>, bool), String> {
    let fail = || "Не удалось объединить изменения".to_string();
    let dir = TempDir::new()?;
    let ours_path = dir.0.join("ours");
    let base_path = dir.0.join("base");
    let theirs_path = dir.0.join("theirs");
    fs::write(&ours_path, ours).map_err(|_| "Не удалось подготовить слияние".to_string())?;
    fs::write(&base_path, base).map_err(|_| "Не удалось подготовить слияние".to_string())?;
    fs::write(&theirs_path, theirs).map_err(|_| "Не удалось подготовить слияние".to_string())?;
    let ours_s = ours_path.to_string_lossy().into_owned();
    let base_s = base_path.to_string_lossy().into_owned();
    let theirs_s = theirs_path.to_string_lossy().into_owned();
    let out = git_raw(
        &dir.0,
        &[
            "merge-file",
            "-p",
            "-L",
            "project",
            "-L",
            "base",
            "-L",
            "task",
            ours_s.as_str(),
            base_s.as_str(),
            theirs_s.as_str(),
        ],
        None,
    )?;
    match out.code {
        Some(0) => Ok((out.stdout, false)),
        // Exit status is the number of conflicts (capped at 127); the text is still merged.
        Some(n) if n > 0 => Ok((out.stdout, true)),
        _ => Err(format!("{}: {}", fail(), first_error_line(&out.stderr))),
    }
}

/// Scratch folder for merge inputs, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!(
            "octopus-wt-merge-{}-{}",
            std::process::id(),
            next_seed()
        ));
        fs::create_dir_all(&dir).map_err(|_| "Не удалось подготовить слияние".to_string())?;
        Ok(Self(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_or_remove(root: &Path, rel: &str, content: &Content) -> Result<(), String> {
    let target = resolve_inside(root, rel)?;
    match content {
        Content::Absent => remove_entry(root, &target),
        _ => write_entry(&target, content),
    }
}

/// Deletes a file, then prunes folders left empty inside the project. Never removes the root.
fn remove_entry(root: &Path, target: &Path) -> Result<(), String> {
    if let Ok(meta) = fs::symlink_metadata(target) {
        if meta.is_dir() {
            return Err("Не удалось удалить файл".to_string());
        }
        fs::remove_file(target).map_err(|_| "Не удалось удалить файл".to_string())?;
    }
    let mut dir = target.parent();
    while let Some(d) = dir {
        if d == root || !d.starts_with(root) || fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
    Ok(())
}

/// Writes one file or symlink, creating parent folders. Replaces a symlink itself.
fn write_entry(target: &Path, content: &Content) -> Result<(), String> {
    let fail = || "Не удалось записать файл".to_string();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|_| fail())?;
    }
    if let Ok(meta) = fs::symlink_metadata(target) {
        if meta.is_dir() {
            return Err(fail());
        }
        fs::remove_file(target).map_err(|_| fail())?;
    }
    match content {
        Content::File { exec, bytes } => {
            fs::write(target, bytes).map_err(|_| fail())?;
            set_exec(target, *exec).map_err(|_| fail())?;
        }
        Content::Link(link) => make_link(target, link).map_err(|_| fail())?,
        Content::Absent => {}
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn set_exec(path: &Path, exec: bool) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 }),
    )
}

#[cfg(not(unix))]
fn set_exec(_path: &Path, _exec: bool) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn make_link(path: &Path, target: &[u8]) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(target), path)
}

#[cfg(not(unix))]
fn make_link(path: &Path, target: &[u8]) -> io::Result<()> {
    fs::write(path, target)
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

fn remove_sync(cwd: &str, path: &str, delete_branch: bool, root: &Path) -> Result<(), String> {
    let main = main_worktree(Path::new(cwd))?;
    let key_dir = root.join(repo_key(&main));
    let owned = find_owned(&main, &key_dir, path)?;
    let wt = owned.path.to_string_lossy().into_owned();

    git(&main, &["worktree", "remove", "--force", wt.as_str()])
        .map_err(|e| format!("Не удалось удалить рабочую копию: {e}"))?;
    // Removes the repository folder too, but only when it is now empty.
    let _ = fs::remove_dir(&key_dir);

    if delete_branch {
        let branch_ref = format!("refs/heads/{}", owned.branch);
        if ref_exists(&main, &branch_ref) {
            git(&main, &["branch", "-D", owned.branch.as_str()])
                .map_err(|e| format!("Не удалось удалить ветку: {e}"))?;
        }
        let _ = git_raw(
            &main,
            &[
                "config",
                "--unset",
                &format!("branch.{}.{BASE_KEY}", owned.branch),
            ],
            None,
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Path safety (same rules as gitops.rs and checkpoints.rs)
// ---------------------------------------------------------------------------

/// Accepts only relative paths made of normal components (and "."), with no "..".
fn check_rel_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("Не указан путь к файлу".to_string());
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return Err("Абсолютные пути запрещены".to_string());
    }
    let mut has_name = false;
    for component in p.components() {
        match component {
            Component::Normal(_) => has_name = true,
            Component::CurDir => {}
            _ => return Err("Путь выходит за папку проекта".to_string()),
        }
    }
    if !has_name {
        return Err("Некорректный путь".to_string());
    }
    Ok(())
}

/// Joins a checked relative path onto the canonical `root` and verifies that the nearest
/// existing ancestor (after resolving symlinks) is still inside `root`.
fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let outside = || "Путь выходит за папку проекта".to_string();
    let target = root.join(rel);
    let mut ancestor = target.parent();
    while let Some(dir) = ancestor {
        if let Ok(real) = fs::canonicalize(dir) {
            return if real.starts_with(root) {
                Ok(target)
            } else {
                Err(outside())
            };
        }
        ancestor = dir.parent();
    }
    Err(outside())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    static DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Unique scratch directory under the system temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let seq = DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "octopus-wt-test-{label}-{}-{nanos}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).expect("create scratch dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn str(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Runs git in a test repository and returns trimmed stdout; panics on failure.
    fn git_out(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("LC_ALL", "C")
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repository with a local identity and no commits yet.
    fn init_repo(label: &str) -> Scratch {
        let scratch = Scratch::new(label);
        let dir = scratch.path();
        git_out(dir, &["init", "-q"]);
        git_out(dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git_out(dir, &["config", "user.name", "Test"]);
        git_out(dir, &["config", "user.email", "test@example.com"]);
        git_out(dir, &["config", "commit.gpgsign", "false"]);
        scratch
    }

    fn write_file(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("create dirs");
        fs::write(path, content).expect("write file");
    }

    fn read_file(dir: &Path, rel: &str) -> Option<String> {
        fs::read_to_string(dir.join(rel)).ok()
    }

    fn commit_all(dir: &Path, message: &str) {
        git_out(dir, &["add", "-A"]);
        git_out(dir, &["commit", "-q", "-m", message]);
    }

    /// Repository on `main` with a.txt ("one") and b.txt committed.
    fn repo_with_commit(label: &str) -> Scratch {
        let repo = init_repo(label);
        write_file(repo.path(), "a.txt", "one\n");
        write_file(repo.path(), "b.txt", "bee\n");
        commit_all(repo.path(), "init");
        repo
    }

    /// Folder that `repo` keeps its Octopus worktrees in, under `roots`.
    fn key_dir_of(repo: &Scratch, roots: &Scratch) -> PathBuf {
        real(roots.path())
            .expect("roots")
            .join(repo_key(&real(repo.path()).expect("repo")))
    }

    #[test]
    fn slugs_are_lowercase_and_bounded() {
        assert_eq!(slug_stem("Pricing Page!"), "pricing-page");
        assert_eq!(slug_stem("  --Fix__login  "), "fix-login");
        assert_eq!(slug_stem("Привет"), "");
        assert_eq!(slug_stem(&"a".repeat(60)).len(), MAX_NAME_CHARS);
        let plain = new_slug(None, 7);
        assert!(
            plain.starts_with("task-") && plain.len() == "task-".len() + 4,
            "{plain}"
        );
        assert!(new_slug(Some("Ship it"), 7).starts_with("ship-it-"));
    }

    #[test]
    fn repo_key_is_stable_and_hash_matches_fnv() {
        assert_eq!(fnv1a32(b""), 0x811c_9dc5);
        assert_eq!(fnv1a32(b"a"), 0xe40c_292c);
        let key = repo_key(Path::new("/Users/x/My App"));
        assert_eq!(key, repo_key(Path::new("/Users/x/My App")));
        assert!(key.starts_with("My-App-"), "{key}");
        assert_eq!(key.len(), "My-App-".len() + 8);
        assert_ne!(key, repo_key(Path::new("/Users/y/My App")));
    }

    #[test]
    fn create_makes_branch_folder_and_records_base() {
        if !git_available() {
            return;
        }
        let repo = repo_with_commit("create");
        let roots = Scratch::new("roots-create");
        let head = git_out(repo.path(), &["rev-parse", "HEAD"]);

        let info = create_sync(&repo.str(), Some("Pricing Page"), roots.path()).unwrap();
        assert!(
            info.branch.starts_with("octopus/pricing-page-"),
            "{}",
            info.branch
        );
        assert_eq!(info.path, info.root);
        assert_eq!(info.base, head);
        assert_eq!(info.head, head);
        assert_eq!(info.changed_files, 0);
        assert!(Path::new(&info.root).starts_with(key_dir_of(&repo, &roots)));
        assert_eq!(
            read_file(Path::new(&info.root), "a.txt").as_deref(),
            Some("one\n")
        );
        assert_eq!(
            git_out(
                repo.path(),
                &[
                    "rev-parse",
                    "--verify",
                    &format!("refs/heads/{}", info.branch)
                ]
            ),
            head
        );
        assert_eq!(
            git_out(
                repo.path(),
                &[
                    "config",
                    "--get",
                    &format!("branch.{}.octopusBase", info.branch)
                ]
            ),
            head
        );
    }

    #[test]
    fn create_from_subfolder_returns_matching_folder() {
        if !git_available() {
            return;
        }
        let repo = repo_with_commit("sub");
        write_file(repo.path(), "apps/web/page.txt", "page\n");
        commit_all(repo.path(), "add page");
        let roots = Scratch::new("roots-sub");
        let sub = repo.path().join("apps/web").to_string_lossy().into_owned();

        let info = create_sync(&sub, None, roots.path()).unwrap();
        assert!(info.branch.starts_with("octopus/task-"), "{}", info.branch);
        assert_eq!(
            info.path,
            Path::new(&info.root)
                .join("apps/web")
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(
            read_file(Path::new(&info.path), "page.txt").as_deref(),
            Some("page\n")
        );
    }

    #[test]
    fn list_returns_only_our_worktrees_with_changed_files() {
        if !git_available() {
            return;
        }
        let repo = repo_with_commit("list");
        let roots = Scratch::new("roots-list");
        let one = create_sync(&repo.str(), Some("one"), roots.path()).unwrap();
        let two = create_sync(&repo.str(), Some("two"), roots.path()).unwrap();

        // A worktree made outside Octopus must not be listed.
        let outside = Scratch::new("outside-list");
        let foreign = outside.path().join("wt").to_string_lossy().into_owned();
        git_out(
            repo.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "other",
                foreign.as_str(),
                "HEAD",
            ],
        );

        let wt_one = PathBuf::from(&one.root);
        write_file(&wt_one, "c.txt", "committed\n");
        git_out(&wt_one, &["add", "c.txt"]);
        git_out(&wt_one, &["commit", "-q", "-m", "add c"]);
        write_file(&wt_one, "a.txt", "one\nlocal\n");
        write_file(&wt_one, "new.txt", "new\n");

        let listed = list_sync(&repo.str(), roots.path()).unwrap();
        assert_eq!(listed.len(), 2, "{listed:?}");
        let a = listed.iter().find(|i| i.branch == one.branch).expect("one");
        let b = listed.iter().find(|i| i.branch == two.branch).expect("two");
        // c.txt (committed), a.txt (uncommitted), new.txt (untracked).
        assert_eq!(a.changed_files, 3);
        assert_eq!(a.base, one.base);
        assert_eq!(b.changed_files, 0);
        assert!(listed.iter().all(|i| i.branch != "other"));
    }

    #[test]
    fn apply_brings_committed_uncommitted_and_untracked_changes_as_unstaged() {
        if !git_available() {
            return;
        }
        let repo = repo_with_commit("apply");
        let roots = Scratch::new("roots-apply");
        let info = create_sync(&repo.str(), Some("feat"), roots.path()).unwrap();
        let wt = PathBuf::from(&info.root);

        write_file(&wt, "c.txt", "committed\n");
        git_out(&wt, &["add", "c.txt"]);
        git_out(&wt, &["commit", "-q", "-m", "add c"]);
        write_file(&wt, "a.txt", "one\nuncommitted\n");
        write_file(&wt, "new.txt", "new\n");
        let wt_status = git_out(&wt, &["status", "--porcelain"]);

        let result = apply_sync(&repo.str(), &info.root, roots.path()).unwrap();
        let mut files = result.files.clone();
        files.sort();
        assert_eq!(files, ["a.txt", "c.txt", "new.txt"]);
        assert!(result.conflicts.is_empty(), "{:?}", result.conflicts);

        assert_eq!(
            read_file(repo.path(), "a.txt").as_deref(),
            Some("one\nuncommitted\n")
        );
        assert_eq!(
            read_file(repo.path(), "c.txt").as_deref(),
            Some("committed\n")
        );
        assert_eq!(read_file(repo.path(), "new.txt").as_deref(), Some("new\n"));
        assert_eq!(
            git_out(repo.path(), &["diff", "--cached", "--name-only"]),
            ""
        );
        // a.txt is an unstaged modification; c.txt and new.txt are untracked.
        assert_eq!(git_out(repo.path(), &["diff", "--name-only"]), "a.txt");
        assert_eq!(
            git_out(repo.path(), &["ls-files", "--others", "--exclude-standard"]),
            "c.txt\nnew.txt"
        );
        assert_eq!(git_out(repo.path(), &["rev-list", "--count", "HEAD"]), "1");

        // The worktree itself is unchanged.
        assert_eq!(git_out(&wt, &["status", "--porcelain"]), wt_status);
        assert_eq!(git_out(&wt, &["diff", "--cached", "--name-only"]), "");
    }

    #[test]
    fn apply_merges_edits_on_different_lines_even_when_main_moved() {
        if !git_available() {
            return;
        }
        let repo = init_repo("merge");
        write_file(repo.path(), "a.txt", "l1\nl2\nl3\nl4\nl5\n");
        commit_all(repo.path(), "init");
        let roots = Scratch::new("roots-merge");
        let info = create_sync(&repo.str(), Some("merge"), roots.path()).unwrap();

        // Main: line 1 committed after the worktree started, line 3 edited and not committed.
        write_file(repo.path(), "a.txt", "MAIN1\nl2\nl3\nl4\nl5\n");
        commit_all(repo.path(), "main line 1");
        write_file(repo.path(), "a.txt", "MAIN1\nl2\nMAIN3\nl4\nl5\n");
        // Worktree: line 5 edited, uncommitted.
        write_file(Path::new(&info.root), "a.txt", "l1\nl2\nl3\nl4\nWT5\n");

        let result = apply_sync(&repo.str(), &info.root, roots.path()).unwrap();
        assert!(result.conflicts.is_empty(), "{:?}", result.conflicts);
        assert_eq!(
            read_file(repo.path(), "a.txt").as_deref(),
            Some("MAIN1\nl2\nMAIN3\nl4\nWT5\n")
        );
    }

    #[test]
    fn apply_reports_conflicts_and_keeps_project_files_when_deleted() {
        if !git_available() {
            return;
        }
        let repo = repo_with_commit("conflict");
        let roots = Scratch::new("roots-conflict");
        let info = create_sync(&repo.str(), Some("clash"), roots.path()).unwrap();
        let wt = PathBuf::from(&info.root);

        // Both sides change a.txt; the worktree changes b.txt, which main deleted.
        write_file(&wt, "a.txt", "from worktree\n");
        write_file(&wt, "b.txt", "bee from worktree\n");
        write_file(repo.path(), "a.txt", "from main\n");
        fs::remove_file(repo.path().join("b.txt")).unwrap();

        let result = apply_sync(&repo.str(), &info.root, roots.path()).unwrap();
        let mut files = result.files.clone();
        files.sort();
        assert_eq!(files, ["a.txt", "b.txt"]);
        assert_eq!(result.conflicts, ["a.txt", "b.txt"]);

        let text = read_file(repo.path(), "a.txt").expect("a.txt exists");
        assert!(text.contains("<<<<<<<"), "{text}");
        assert!(
            text.contains("from main") && text.contains("from worktree"),
            "{text}"
        );
        assert_eq!(
            read_file(repo.path(), "b.txt"),
            None,
            "deleted by the user stays deleted"
        );
    }

    #[test]
    fn remove_deletes_worktree_and_branch() {
        if !git_available() {
            return;
        }
        let repo = repo_with_commit("remove");
        let roots = Scratch::new("roots-remove");
        let gone = create_sync(&repo.str(), Some("gone"), roots.path()).unwrap();
        let keep = create_sync(&repo.str(), Some("keep"), roots.path()).unwrap();

        remove_sync(&repo.str(), &gone.root, true, roots.path()).unwrap();
        assert!(!Path::new(&gone.root).exists());
        assert_eq!(
            git_out(repo.path(), &["branch", "--list", gone.branch.as_str()]),
            ""
        );
        assert!(
            git_opt(
                repo.path(),
                &[
                    "config",
                    "--get",
                    &format!("branch.{}.octopusBase", gone.branch)
                ]
            )
            .is_none()
        );

        remove_sync(&repo.str(), &keep.root, false, roots.path()).unwrap();
        assert!(!Path::new(&keep.root).exists());
        assert!(!git_out(repo.path(), &["branch", "--list", keep.branch.as_str()]).is_empty());
        assert!(list_sync(&repo.str(), roots.path()).unwrap().is_empty());
    }

    #[test]
    fn foreign_and_invalid_paths_are_refused() {
        if !git_available() {
            return;
        }
        let repo = repo_with_commit("foreign");
        let roots = Scratch::new("roots-foreign");
        let _mine = create_sync(&repo.str(), Some("mine"), roots.path()).unwrap();

        let outside = Scratch::new("outside-foreign");
        let other = outside.path().join("wt").to_string_lossy().into_owned();
        git_out(
            repo.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "other",
                other.as_str(),
                "HEAD",
            ],
        );

        let refused = "Это не рабочая копия Octopus";
        assert_eq!(
            apply_sync(&repo.str(), &other, roots.path()).unwrap_err(),
            refused
        );
        assert_eq!(
            remove_sync(&repo.str(), &other, true, roots.path()).unwrap_err(),
            refused
        );
        assert!(Path::new(&other).exists(), "foreign worktree is left alone");

        assert!(apply_sync(&repo.str(), &repo.str(), roots.path()).is_err());
        assert!(remove_sync(&repo.str(), "relative/path", false, roots.path()).is_err());
        assert!(apply_sync(&repo.str(), "/nonexistent-octopus-wt", roots.path()).is_err());
    }

    #[test]
    fn repository_without_commits_is_an_error() {
        if !git_available() {
            return;
        }
        let repo = init_repo("nocommit");
        write_file(repo.path(), "a.txt", "a\n");
        let roots = Scratch::new("roots-nocommit");
        assert_eq!(
            create_sync(&repo.str(), None, roots.path()).unwrap_err(),
            "Нужен хотя бы один коммит"
        );
        assert!(
            !roots
                .path()
                .join(repo_key(&real(repo.path()).unwrap()))
                .exists()
        );
    }
}
