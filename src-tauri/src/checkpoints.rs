//! File checkpoints of the project folder, taken before each agent task.
//!
//! A checkpoint is a commit object kept under `refs/octopus/checkpoints/`. Its tree is the
//! repository state: HEAD plus every non-ignored working-tree file. The tree is built with a
//! temporary index, so creating or comparing a checkpoint never touches the user's real index,
//! HEAD, branches, stash or working tree.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const CHECKPOINT_MESSAGE: &str = "octopus checkpoint";
const CHECKPOINT_REF_PREFIX: &str = "refs/octopus/checkpoints/";
/// Identity for checkpoint commits, so they work without any git user config.
const AUTHOR_ENV: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "Octopus"),
    ("GIT_AUTHOR_EMAIL", "octopus@localhost"),
    ("GIT_COMMITTER_NAME", "Octopus"),
    ("GIT_COMMITTER_EMAIL", "octopus@localhost"),
];

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointChange {
    pub path: String,
    /// "modified" | "added" | "deleted"
    pub kind: String,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Snapshots the repository of `cwd`. Returns None when `cwd` is not inside a git work tree.
#[tauri::command]
pub async fn checkpoint_create(cwd: String) -> Result<Option<String>, String> {
    blocking(move || create_sync(&cwd)).await
}

/// Files whose current state differs from the checkpoint.
#[tauri::command]
pub async fn checkpoint_changes(cwd: String, id: String) -> Result<Vec<CheckpointChange>, String> {
    blocking(move || changes_sync(&cwd, &id)).await
}

/// Makes the working tree match the checkpoint. Returns the number of files restored.
#[tauri::command]
pub async fn checkpoint_restore(cwd: String, id: String) -> Result<u32, String> {
    blocking(move || restore_sync(&cwd, &id)).await
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

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

/// Runs `git -C cwd args` with extra env. On failure returns a short message with the first
/// stderr line.
fn git_env(cwd: &str, args: &[&str], env: &[(&str, &str)]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Paths given after `--` are file names, never globs.
        .env("GIT_LITERAL_PATHSPECS", "1")
        // An inherited index must never replace the temporary one passed per command.
        .env_remove("GIT_INDEX_FILE")
        .envs(env.iter().copied())
        .stdin(Stdio::null());
    let out = cmd
        .output()
        .map_err(|_| "Не удалось запустить git".to_string())?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let first = stderr.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        Err("Ошибка git".to_string())
    } else {
        Err(format!("Ошибка git: {first}"))
    }
}

fn git(cwd: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    git_env(cwd, args, &[])
}

/// Like `git`, but returns trimmed stdout as text, or None on failure or empty output.
fn git_text(cwd: &str, args: &[&str]) -> Option<String> {
    git(cwd, args)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn is_repo(cwd: &str) -> bool {
    git_text(cwd, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true")
}

/// Root of the work tree that contains `cwd`. Errors when `cwd` is not in a repository.
fn require_repo(cwd: &str) -> Result<String, String> {
    if !is_repo(cwd) {
        return Err("Папка проекта не находится в git-репозитории".to_string());
    }
    git_text(cwd, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| "Не удалось прочитать папку проекта".to_string())
}

/// Commit hash of HEAD, or None in a repository without commits.
fn head_commit(root: &str) -> Option<String> {
    git_text(root, &["rev-parse", "--verify", "-q", "HEAD^{commit}"])
}

static INDEX_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A temporary git index file, deleted when dropped.
struct TempIndex(PathBuf);

impl TempIndex {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let seq = INDEX_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            "octopus-checkpoint-{}-{nanos}-{seq}.index",
            std::process::id()
        );
        Self(std::env::temp_dir().join(name))
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = fs::remove_file(lock);
    }
}

/// Writes the whole repository state (HEAD plus non-ignored files) as a tree object.
/// Only a temporary index is used, so the real index stays as it is.
fn snapshot_tree(root: &str, has_head: bool) -> Result<String, String> {
    let index = TempIndex::new();
    let index_path = index.path();
    let env = [("GIT_INDEX_FILE", index_path.as_str())];
    if has_head {
        git_env(root, &["read-tree", "HEAD"], &env)?;
    }
    git_env(root, &["add", "-A", "--", "."], &env)?;
    let tree = git_env(root, &["write-tree"], &env)?;
    Ok(String::from_utf8_lossy(&tree).trim().to_string())
}

/// Tree of the current state of the repository.
fn current_tree(root: &str) -> Result<String, String> {
    snapshot_tree(root, head_commit(root).is_some())
}

/// Accepts a full object id (40 or 64 hex digits) and returns it in lower case.
fn normalize_id(id: &str) -> Result<String, String> {
    let ok = (id.len() == 40 || id.len() == 64) && id.bytes().all(|b| b.is_ascii_hexdigit());
    if !ok {
        return Err("Некорректный идентификатор точки сохранения".to_string());
    }
    Ok(id.to_ascii_lowercase())
}

/// Tree of an existing checkpoint commit.
fn checkpoint_tree(root: &str, id: &str) -> Result<String, String> {
    let missing = || "Точка сохранения не найдена".to_string();
    let commit = format!("{id}^{{commit}}");
    git(root, &["cat-file", "-e", commit.as_str()]).map_err(|_| missing())?;
    let tree = format!("{id}^{{tree}}");
    git_text(root, &["rev-parse", tree.as_str()]).ok_or_else(missing)
}

/// Parses `git diff-tree --name-status -z`: `<status>NUL<path>NUL` records.
fn parse_name_status(output: &[u8]) -> Vec<CheckpointChange> {
    let text = String::from_utf8_lossy(output);
    let mut changes = Vec::new();
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    while let Some(status) = tokens.next() {
        let Some(path) = tokens.next() else {
            break;
        };
        let kind = match status.as_bytes().first() {
            Some(b'A') => "added",
            Some(b'D') => "deleted",
            _ => "modified",
        };
        changes.push(CheckpointChange {
            path: path.to_string(),
            kind: kind.to_string(),
        });
    }
    changes
}

/// `from` is the checkpoint tree and `to` the current one: "added" exists only in `to`,
/// "deleted" exists only in `from`.
fn diff_trees(root: &str, from: &str, to: &str) -> Result<Vec<CheckpointChange>, String> {
    let out = git(
        root,
        &[
            "diff-tree",
            "-r",
            "--no-renames",
            "--name-status",
            "-z",
            from,
            to,
        ],
    )?;
    Ok(parse_name_status(&out))
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/// Accepts only relative paths made of normal components (and "."), with no "..".
/// Rejects "" and "." so that a restore can never target the whole tree.
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

/// Joins a checked relative path onto the canonical root and verifies that the nearest
/// existing ancestor (after resolving symlinks) is still inside the root.
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
// Create / changes
// ---------------------------------------------------------------------------

fn create_sync(cwd: &str) -> Result<Option<String>, String> {
    if !is_repo(cwd) {
        return Ok(None);
    }
    let root = require_repo(cwd)?;
    let head = head_commit(&root);
    let tree = snapshot_tree(&root, head.is_some())?;

    let mut args = vec!["-c", "commit.gpgSign=false", "commit-tree", tree.as_str()];
    if let Some(parent) = head.as_deref() {
        args.extend(["-p", parent]);
    }
    args.extend(["-m", CHECKPOINT_MESSAGE]);
    let commit = String::from_utf8_lossy(&git_env(&root, &args, &AUTHOR_ENV)?)
        .trim()
        .to_string();

    // Keeps the commit (and its tree) alive through `git gc`.
    let reference = format!("{CHECKPOINT_REF_PREFIX}{commit}");
    git(&root, &["update-ref", reference.as_str(), commit.as_str()])?;
    Ok(Some(commit))
}

fn changes_sync(cwd: &str, id: &str) -> Result<Vec<CheckpointChange>, String> {
    let id = normalize_id(id)?;
    let root = require_repo(cwd)?;
    let base = checkpoint_tree(&root, &id)?;
    let current = current_tree(&root)?;
    Ok(within_project(cwd, diff_trees(&root, &base, &current)?))
}

/// Only changes inside the project folder: when it is a subfolder of a larger
/// repository, files elsewhere in that repository are never touched.
fn within_project(cwd: &str, changes: Vec<CheckpointChange>) -> Vec<CheckpointChange> {
    let prefix = git_text(cwd, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    if prefix.is_empty() {
        return changes;
    }
    changes.into_iter().filter(|c| c.path.starts_with(&prefix)).collect()
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/// Blob entries of a checkpoint tree: path -> (mode, object id).
fn checkpoint_entries(root: &str, tree: &str) -> Result<HashMap<String, (String, String)>, String> {
    let out = git(root, &["ls-tree", "-r", "-z", tree])?;
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

enum Step {
    /// A file that the checkpoint does not have.
    Remove(PathBuf),
    /// A file from the checkpoint; `mode` is the git mode (100644, 100755, 120000).
    Write {
        target: PathBuf,
        mode: String,
        bytes: Vec<u8>,
    },
}

fn restore_sync(cwd: &str, id: &str) -> Result<u32, String> {
    let id = normalize_id(id)?;
    let root = require_repo(cwd)?;
    let base = checkpoint_tree(&root, &id)?;
    let changes = within_project(cwd, diff_trees(&root, &base, &current_tree(&root)?)?);
    let root_real = fs::canonicalize(&root).map_err(|_| "Папка проекта не найдена".to_string())?;
    let entries = checkpoint_entries(&root, &base)?;

    // Read everything and validate every path before the first write.
    let mut steps = Vec::with_capacity(changes.len());
    for change in &changes {
        check_rel_path(&change.path)?;
        let target = resolve_inside(&root_real, &change.path)?;
        if change.kind == "added" {
            steps.push(Step::Remove(target));
            continue;
        }
        let (mode, oid) = entries
            .get(&change.path)
            .ok_or_else(|| "Не удалось прочитать файл из точки сохранения".to_string())?;
        if mode.as_str() == "160000" {
            // Submodule: its content is not part of the checkpoint.
            continue;
        }
        let bytes = git(&root, &["cat-file", "blob", oid.as_str()])?;
        steps.push(Step::Write {
            target,
            mode: mode.clone(),
            bytes,
        });
    }

    // Removals go first, so that a file replaced by a directory (or the reverse) can be written.
    let mut restored = 0u32;
    for step in &steps {
        if let Step::Remove(target) = step {
            remove_entry(&root_real, target)?;
            restored += 1;
        }
    }
    for step in &steps {
        if let Step::Write {
            target,
            mode,
            bytes,
        } = step
        {
            write_entry(target, mode, bytes)?;
            restored += 1;
        }
    }
    Ok(restored)
}

/// Deletes a file the checkpoint does not have, then prunes directories left empty
/// inside the project. Never follows symlinks and never removes the project root.
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

/// Writes one file from the checkpoint, creating parent directories.
fn write_entry(target: &Path, mode: &str, bytes: &[u8]) -> Result<(), String> {
    let fail = || "Не удалось записать файл".to_string();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|_| fail())?;
    }
    if let Ok(meta) = fs::symlink_metadata(target) {
        if meta.is_dir() {
            return Err(fail());
        }
        // Replaces a symlink itself instead of writing through it.
        fs::remove_file(target).map_err(|_| fail())?;
    }
    write_bytes(target, mode, bytes).map_err(|_| fail())
}

#[cfg(unix)]
fn write_bytes(target: &Path, mode: &str, bytes: &[u8]) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{PermissionsExt, symlink};

    if mode == "120000" {
        return symlink(std::ffi::OsStr::from_bytes(bytes), target);
    }
    fs::write(target, bytes)?;
    let perm = if mode == "100755" { 0o755 } else { 0o644 };
    fs::set_permissions(target, fs::Permissions::from_mode(perm))
}

#[cfg(not(unix))]
fn write_bytes(target: &Path, _mode: &str, bytes: &[u8]) -> io::Result<()> {
    fs::write(target, bytes)
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
                "octopus-cp-test-{label}-{}-{nanos}-{seq}",
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

    /// Runs git in a test repository and returns stdout; panics on failure.
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
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    /// A repository with a local identity and no commits yet.
    fn init_repo(label: &str) -> Scratch {
        let scratch = Scratch::new(label);
        let dir = scratch.path();
        git_out(dir, &["init", "-q"]);
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

    /// Path/kind pairs, sorted, for comparison.
    fn pairs(changes: Vec<CheckpointChange>) -> Vec<(String, String)> {
        let mut v: Vec<_> = changes.into_iter().map(|c| (c.path, c.kind)).collect();
        v.sort();
        v
    }

    fn expected(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(p, k)| (p.to_string(), k.to_string()))
            .collect()
    }

    #[test]
    fn path_checks_reject_escapes() {
        assert!(check_rel_path("a/b.txt").is_ok());
        assert!(check_rel_path("../x").is_err());
        assert!(check_rel_path("a/../../x").is_err());
        assert!(check_rel_path("/etc/passwd").is_err());
        assert!(check_rel_path("").is_err());
        assert!(check_rel_path(".").is_err());
    }

    #[test]
    fn non_repository_gives_no_checkpoint() {
        if !git_available() {
            return;
        }
        let dir = Scratch::new("plain");
        write_file(dir.path(), "a.txt", "a");
        assert_eq!(create_sync(&dir.str()).unwrap(), None);
    }

    #[test]
    fn checkpoint_roundtrip_restores_working_tree_and_keeps_git_state() {
        if !git_available() {
            return;
        }
        let repo = init_repo("roundtrip");
        let dir = repo.path();
        write_file(dir, ".gitignore", "*.log\n");
        write_file(dir, "tracked.txt", "one");
        write_file(dir, "gone.txt", "bye");
        write_file(dir, "keep.txt", "keep");
        commit_all(dir, "initial");

        // Staged by the user before the task starts.
        write_file(dir, "staged.txt", "staged v1");
        git_out(dir, &["add", "staged.txt"]);
        write_file(dir, "debug.log", "log v1");

        let index_before = git_out(dir, &["ls-files", "--stage"]);
        let head_before = git_out(dir, &["rev-parse", "HEAD"]);

        let id = create_sync(&repo.str())
            .unwrap()
            .expect("inside a repository");
        assert_eq!(
            git_out(dir, &["ls-files", "--stage"]),
            index_before,
            "create must not touch the index"
        );
        assert_eq!(git_out(dir, &["rev-parse", "HEAD"]), head_before);

        // Changes made after the checkpoint.
        write_file(dir, "tracked.txt", "two");
        write_file(dir, "new.txt", "new");
        fs::remove_file(dir.join("gone.txt")).unwrap();
        write_file(dir, "debug.log", "log v2");

        let changes = changes_sync(&repo.str(), &id).unwrap();
        assert_eq!(
            pairs(changes),
            expected(&[
                ("gone.txt", "deleted"),
                ("new.txt", "added"),
                ("tracked.txt", "modified"),
            ])
        );

        let index_before_restore = git_out(dir, &["ls-files", "--stage"]);
        assert_eq!(restore_sync(&repo.str(), &id).unwrap(), 3);

        assert_eq!(read_file(dir, "tracked.txt").as_deref(), Some("one"));
        assert_eq!(read_file(dir, "gone.txt").as_deref(), Some("bye"));
        assert_eq!(read_file(dir, "new.txt"), None);
        assert_eq!(read_file(dir, "keep.txt").as_deref(), Some("keep"));
        assert_eq!(read_file(dir, "staged.txt").as_deref(), Some("staged v1"));
        assert_eq!(
            read_file(dir, "debug.log").as_deref(),
            Some("log v2"),
            "ignored files are not touched"
        );

        assert_eq!(
            git_out(dir, &["ls-files", "--stage"]),
            index_before_restore,
            "restore must not touch the index"
        );
        assert_eq!(git_out(dir, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            git_out(dir, &["diff", "--cached", "--name-only"]),
            "staged.txt",
            "staged changes stay staged"
        );

        // The working tree now equals the checkpoint again.
        assert!(changes_sync(&repo.str(), &id).unwrap().is_empty());
    }

    #[test]
    fn repository_without_commits_is_supported() {
        if !git_available() {
            return;
        }
        let repo = init_repo("nocommits");
        let dir = repo.path();
        write_file(dir, "a.txt", "a");

        let id = create_sync(&repo.str()).unwrap().expect("checkpoint");
        assert!(head_commit(&repo.str()).is_none(), "no commit is created");

        write_file(dir, "a.txt", "a2");
        write_file(dir, "b.txt", "b");
        assert_eq!(
            pairs(changes_sync(&repo.str(), &id).unwrap()),
            expected(&[("a.txt", "modified"), ("b.txt", "added")])
        );

        assert_eq!(restore_sync(&repo.str(), &id).unwrap(), 2);
        assert_eq!(read_file(dir, "a.txt").as_deref(), Some("a"));
        assert_eq!(read_file(dir, "b.txt"), None);
        assert!(head_commit(&repo.str()).is_none());
    }

    #[test]
    fn checkpoint_survives_garbage_collection() {
        if !git_available() {
            return;
        }
        let repo = init_repo("gc");
        let dir = repo.path();
        write_file(dir, "a.txt", "a");
        commit_all(dir, "initial");
        write_file(dir, "a.txt", "a2");

        let id = create_sync(&repo.str()).unwrap().expect("checkpoint");
        write_file(dir, "a.txt", "a3");

        git_out(dir, &["gc", "--prune=now", "-q"]);

        let reference = format!("{CHECKPOINT_REF_PREFIX}{id}");
        assert_eq!(
            git_out(dir, &["rev-parse", "--verify", reference.as_str()]),
            id
        );
        assert_eq!(
            pairs(changes_sync(&repo.str(), &id).unwrap()),
            expected(&[("a.txt", "modified")])
        );
        assert_eq!(restore_sync(&repo.str(), &id).unwrap(), 1);
        assert_eq!(read_file(dir, "a.txt").as_deref(), Some("a2"));
    }

    #[test]
    fn invalid_or_unknown_ids_are_rejected() {
        if !git_available() {
            return;
        }
        let repo = init_repo("badid");
        write_file(repo.path(), "a.txt", "a");
        commit_all(repo.path(), "initial");
        let dir = repo.str();

        assert!(restore_sync(&dir, "not-a-hash").is_err());
        assert!(restore_sync(&dir, "../../etc/passwd").is_err());
        assert!(changes_sync(&dir, "--all").is_err());
        assert!(restore_sync(&dir, &"0".repeat(40)).is_err());
        assert!(changes_sync(&dir, &"a".repeat(64)).is_err());
    }

    #[test]
    fn restore_never_writes_through_a_symlink_out_of_the_project() {
        if !git_available() {
            return;
        }
        let repo = init_repo("symlink");
        let outside = Scratch::new("outside");
        let dir = repo.path();
        write_file(dir, "sub/f.txt", "inside");
        commit_all(dir, "initial");
        // `sub` is ignored, so the agent's symlink there is not part of any tree.
        write_file(dir, ".gitignore", "sub\n");
        commit_all(dir, "ignore sub");

        let id = create_sync(&repo.str()).unwrap().expect("checkpoint");

        fs::remove_dir_all(dir.join("sub")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.join("sub")).unwrap();

        assert_eq!(
            restore_sync(&repo.str(), &id).unwrap_err(),
            "Путь выходит за папку проекта"
        );
        assert_eq!(
            fs::read_dir(outside.path()).unwrap().count(),
            0,
            "nothing is written outside the project"
        );
    }
}
