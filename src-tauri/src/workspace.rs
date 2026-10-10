//! Git status/diff/restore and file search for the agent's project folder.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

const MAX_STATUS_FILES: usize = 500;
const MAX_TEXT_BYTES: u64 = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 400 * 1024;
const MAX_LIST_ENTRIES: usize = 20_000;
const MAX_WALK_DEPTH: usize = 8;
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;
/// Dot-directories (including .git) are skipped by the walker as well.
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build"];
/// Largest single-file hunk patch accepted by `git_apply_hunk`.
const MAX_PATCH_BYTES: usize = 1024 * 1024;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    /// "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict"
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub old_path: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub files: Vec<GitFile>,
    pub additions: u32,
    pub deletions: u32,
}

impl GitStatus {
    fn not_repo() -> Self {
        Self {
            is_repo: false,
            branch: None,
            files: Vec::new(),
            additions: 0,
            deletions: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatus, String> {
    blocking(move || status_sync(&cwd)).await
}

#[tauri::command]
pub async fn git_diff(cwd: String, path: String) -> Result<String, String> {
    blocking(move || diff_sync(&cwd, &path)).await
}

#[tauri::command]
pub async fn git_restore(cwd: String, path: String) -> Result<(), String> {
    blocking(move || restore_sync(&cwd, &path)).await
}

/// Applies one hunk of a single-file patch: `"stage"` to the index, `"revert"` to the worktree.
#[tauri::command]
pub async fn git_apply_hunk(
    cwd: String,
    path: String,
    patch: String,
    mode: String,
) -> Result<(), String> {
    blocking(move || apply_hunk_sync(&cwd, &path, &patch, &mode)).await
}

#[tauri::command]
pub async fn project_files(
    cwd: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let limit = limit.map_or(DEFAULT_LIMIT, |l| (l as usize).min(MAX_LIMIT));
    blocking(move || files_sync(&cwd, &query, limit)).await
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

fn git_command(cwd: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        // Paths given after `--` are file names, never globs.
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null());
    cmd
}

/// Runs git and returns stdout. On failure returns a short message with the first stderr line.
fn git(cwd: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git_command(cwd)
        .args(args)
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

/// Like `git`, but returns trimmed stdout as text, or None on failure.
fn git_text(cwd: &str, args: &[&str]) -> Option<String> {
    git(cwd, args)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
}

fn is_repo(cwd: &str) -> bool {
    git_text(cwd, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true")
}

fn has_head(cwd: &str) -> bool {
    git(cwd, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

/// A path is tracked when it is present in the index (even if deleted from disk).
fn is_tracked(cwd: &str, path: &str) -> bool {
    git(cwd, &["ls-files", "-z", "--", path])
        .map(|out| !out.is_empty())
        .unwrap_or(false)
}

/// Prefix of the cwd relative to the repository root ("" at the root, otherwise "sub/").
fn show_prefix(cwd: &str) -> String {
    git_text(cwd, &["rev-parse", "--show-prefix"]).unwrap_or_default()
}

/// Porcelain paths are relative to the repo root; keep only those under `prefix`
/// and return them relative to the cwd.
fn strip_root_prefix(path: &str, prefix: &str) -> Option<String> {
    if prefix.is_empty() {
        Some(path.to_string())
    } else {
        path.strip_prefix(prefix).map(str::to_string)
    }
}

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
struct PorcelainEntry {
    /// Repo-root-relative path (the new path for renames).
    path: String,
    status: &'static str,
    /// Repo-root-relative source path for renames and copies.
    old_path: Option<String>,
}

fn map_status(x: u8, y: u8) -> &'static str {
    if x == b'?' && y == b'?' {
        "untracked"
    } else if x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D') {
        "conflict"
    } else if x == b'R' || y == b'R' {
        "renamed"
    } else if x == b'D' || y == b'D' {
        "deleted"
    } else if x == b'A' || y == b'A' || x == b'C' {
        "added"
    } else {
        "modified"
    }
}

/// Parses `git status --porcelain=v1 -z`. Rename/copy entries are `XY new\0old\0`.
fn parse_porcelain(output: &str) -> Vec<PorcelainEntry> {
    let mut entries = Vec::new();
    let mut tokens = output.split('\0').filter(|t| !t.is_empty());
    while let Some(tok) = tokens.next() {
        let bytes = tok.as_bytes();
        if bytes.len() < 4 {
            continue;
        }
        let (x, y) = (bytes[0], bytes[1]);
        let Some(path) = tok.get(3..) else {
            continue;
        };
        let old_path = if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            tokens.next().map(str::to_string)
        } else {
            None
        };
        entries.push(PorcelainEntry {
            path: path.to_string(),
            status: map_status(x, y),
            old_path,
        });
    }
    entries
}

fn parse_count(s: &str) -> u32 {
    // Binary files report "-".
    s.parse().unwrap_or(0)
}

/// Parses `git diff --numstat -z`. Map key is the (new) repo-root-relative path.
/// Rename records are `added\tdeleted\t\0old\0new\0`.
fn parse_numstat(output: &str) -> HashMap<String, (u32, u32)> {
    let mut map = HashMap::new();
    let mut tokens = output.split('\0');
    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue;
        }
        let mut parts = tok.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let key = if path.is_empty() {
            let _old = tokens.next();
            match tokens.next() {
                Some(new) if !new.is_empty() => new.to_string(),
                _ => break,
            }
        } else {
            path.to_string()
        };
        map.insert(key, (parse_count(add), parse_count(del)));
    }
    map
}

/// Number of lines, counting a final line without a trailing newline.
fn line_count(text: &str) -> u32 {
    u32::try_from(text.split_inclusive('\n').count()).unwrap_or(u32::MAX)
}

/// Regular, non-symlink, text file under 1 MB. None otherwise.
fn read_text_file(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_TEXT_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn cap_output(mut text: String) -> String {
    if text.len() <= MAX_OUTPUT_BYTES {
        return text;
    }
    let mut end = MAX_OUTPUT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n… (обрезано)");
    text
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

/// Joins a checked relative path onto the canonical cwd and verifies that the nearest
/// existing ancestor (after resolving symlinks) is still inside the cwd.
fn resolve_inside(cwd: &str, rel: &str) -> Result<PathBuf, String> {
    let outside = || "Путь выходит за папку проекта".to_string();
    let root = fs::canonicalize(cwd).map_err(|_| "Папка проекта не найдена".to_string())?;
    let target = root.join(rel);
    let mut ancestor = target.parent();
    while let Some(dir) = ancestor {
        if let Ok(real) = fs::canonicalize(dir) {
            return if real.starts_with(&root) {
                Ok(target.clone())
            } else {
                Err(outside())
            };
        }
        ancestor = dir.parent();
    }
    Err(outside())
}

// ---------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------

fn status_sync(cwd: &str) -> Result<GitStatus, String> {
    if !is_repo(cwd) {
        return Ok(GitStatus::not_repo());
    }
    let prefix = show_prefix(cwd);
    let branch = git_text(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .filter(|b| !b.is_empty() && b != "HEAD");

    let porcelain = git(
        cwd,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let entries = parse_porcelain(&String::from_utf8_lossy(&porcelain));

    let numstat_args: &[&str] = if has_head(cwd) {
        &["diff", "--numstat", "-z", "HEAD"]
    } else {
        &["diff", "--numstat", "-z"]
    };
    let counts = git(cwd, numstat_args)
        .map(|out| parse_numstat(&String::from_utf8_lossy(&out)))
        .unwrap_or_default();

    let root = Path::new(cwd);
    let mut files = Vec::new();
    let mut additions = 0u32;
    let mut deletions = 0u32;

    for entry in entries {
        let Some(path) = strip_root_prefix(&entry.path, &prefix) else {
            continue;
        };
        let old_path = entry
            .old_path
            .as_deref()
            .and_then(|old| strip_root_prefix(old, &prefix));
        let (add, del) = if entry.status == "untracked" {
            let lines = read_text_file(&root.join(&path)).map_or(0, |t| line_count(&t));
            (lines, 0)
        } else {
            counts.get(&entry.path).copied().unwrap_or((0, 0))
        };
        additions = additions.saturating_add(add);
        deletions = deletions.saturating_add(del);
        files.push(GitFile {
            path,
            status: entry.status.to_string(),
            additions: add,
            deletions: del,
            old_path,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.truncate(MAX_STATUS_FILES);

    Ok(GitStatus {
        is_repo: true,
        branch,
        files,
        additions,
        deletions,
    })
}

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

fn diff_sync(cwd: &str, path: &str) -> Result<String, String> {
    check_rel_path(path)?;
    if is_tracked(cwd, path) {
        let first = if has_head(cwd) {
            git(cwd, &["diff", "HEAD", "--", path])
        } else {
            git(cwd, &["diff", "--", path])
        };
        let mut out = first?;
        if out.is_empty() {
            out = git(cwd, &["diff", "--cached", "--", path])?;
        }
        Ok(cap_output(String::from_utf8_lossy(&out).into_owned()))
    } else {
        let abs = resolve_inside(cwd, path)?;
        untracked_diff(&abs, path)
    }
}

/// Renders an untracked file as a diff that adds every line.
fn untracked_diff(abs: &Path, path: &str) -> Result<String, String> {
    let meta = fs::symlink_metadata(abs).map_err(|_| "Файл не найден".to_string())?;
    if meta.is_dir() {
        return Err("Это папка, а не файл".to_string());
    }
    let Some(text) = read_text_file(abs) else {
        return Ok("Бинарный или слишком большой файл".to_string());
    };

    let mut out = format!("--- /dev/null\n+++ b/{path}\n");
    if !text.is_empty() {
        out.push_str(&format!("@@ -0,0 +1,{} @@\n", line_count(&text)));
        for segment in text.split_inclusive('\n') {
            out.push('+');
            match segment.strip_suffix('\n') {
                Some(body) => {
                    out.push_str(body);
                    out.push('\n');
                }
                None => {
                    out.push_str(segment);
                    out.push_str("\n\\ No newline at end of file\n");
                }
            }
        }
    }
    Ok(cap_output(out))
}

// ---------------------------------------------------------------------------
// git_restore
// ---------------------------------------------------------------------------

fn restore_sync(cwd: &str, path: &str) -> Result<(), String> {
    check_rel_path(path)?;
    let abs = resolve_inside(cwd, path)?;
    if fs::symlink_metadata(&abs).is_ok_and(|m| m.is_dir()) {
        return Err("Откатывать можно только файлы, не папки".to_string());
    }

    if is_tracked(cwd, path) {
        if !has_head(cwd) {
            return Err("Нет коммитов — откатить нельзя".to_string());
        }
        git(
            cwd,
            &[
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                path,
            ],
        )
        .map(|_| ())
    } else {
        if fs::symlink_metadata(&abs).is_err() {
            return Err("Файл не найден".to_string());
        }
        fs::remove_file(&abs).map_err(|e| format!("Не удалось удалить файл: {e}"))
    }
}

// ---------------------------------------------------------------------------
// git_apply_hunk
// ---------------------------------------------------------------------------

fn apply_hunk_sync(cwd: &str, path: &str, patch: &str, mode: &str) -> Result<(), String> {
    let args: &[&str] = match mode {
        "stage" => &["apply", "--cached", "--recount", "-"],
        "revert" => &["apply", "-R", "--recount", "-"],
        _ => return Err("Неизвестный режим изменения".to_string()),
    };
    check_rel_path(path)?;
    resolve_inside(cwd, path)?;
    check_patch(path, patch)?;

    let mut child = git_command(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Не удалось запустить git".to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        // A write error means git already exited; its stderr explains why.
        let _ = stdin.write_all(patch.as_bytes());
    }
    let out = child
        .wait_with_output()
        .map_err(|_| "Не удалось запустить git".to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let first = stderr.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        Err("Не удалось применить изменение".to_string())
    } else {
        Err(format!("Не удалось применить изменение: {first}"))
    }
}

/// Checks that `patch` is one hunk-bearing patch for exactly `path`: its file header
/// names that path (and no other file), and every body line is a diff line.
fn check_patch(path: &str, patch: &str) -> Result<(), String> {
    if patch.len() >= MAX_PATCH_BYTES {
        return Err("Фрагмент слишком большой".to_string());
    }
    let want_diff = format!("diff --git a/{path} b/{path}");
    let want_old = format!("--- a/{path}");
    let want_new = format!("+++ b/{path}");
    let other = || "Патч относится к другому файлу".to_string();

    let mut saw_old = false;
    let mut saw_new = false;
    let mut saw_hunk = false;
    for line in patch.lines() {
        if line.starts_with("@@") {
            saw_hunk = true;
            break;
        }
        if line.starts_with("diff --git ") {
            if line != want_diff {
                return Err(other());
            }
        } else if line.starts_with("--- ") {
            if line != want_old {
                return Err(other());
            }
            saw_old = true;
        } else if line.starts_with("+++ ") {
            if line != want_new {
                return Err(other());
            }
            saw_new = true;
        }
    }
    if !saw_old || !saw_new {
        return Err(other());
    }
    if !saw_hunk {
        return Err("В патче нет фрагментов".to_string());
    }

    // Body: only hunk lines. A stray "diff --git" or "--- " from another file is rejected.
    let body = patch.split_once("\n@@").map_or("", |(_, rest)| rest);
    for line in format!("@@{body}").lines() {
        match line.as_bytes().first() {
            Some(b' ' | b'+' | b'-' | b'\\' | b'@') => {}
            _ => return Err("Некорректный патч".to_string()),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// project_files
// ---------------------------------------------------------------------------

fn files_sync(cwd: &str, query: &str, limit: usize) -> Result<Vec<String>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut candidates = if is_repo(cwd) {
        list_git_files(cwd)
    } else {
        list_walk_files(cwd)?
    };

    let query = query.trim();
    if query.is_empty() {
        candidates.sort_by(|a, b| {
            a.chars()
                .count()
                .cmp(&b.chars().count())
                .then_with(|| a.cmp(b))
        });
        candidates.truncate(limit);
        return Ok(candidates);
    }

    let mut scored: Vec<(i64, String)> = candidates
        .into_iter()
        .filter_map(|p| fuzzy_score(&p, query).map(|score| (score, p)))
        .collect();
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.chars().count().cmp(&b.1.chars().count()))
            .then_with(|| a.1.cmp(&b.1))
    });
    Ok(scored.into_iter().take(limit).map(|(_, p)| p).collect())
}

/// Tracked + untracked-but-not-ignored files, relative to cwd. Deleted files are dropped.
fn list_git_files(cwd: &str) -> Vec<String> {
    let Ok(out) = git(
        cwd,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    ) else {
        return Vec::new();
    };
    let root = Path::new(cwd);
    out.split(|b| *b == 0)
        .filter(|t| !t.is_empty())
        .map(|t| String::from_utf8_lossy(t).into_owned())
        .filter(|p| fs::symlink_metadata(root.join(p)).is_ok_and(|m| !m.is_dir()))
        .take(MAX_LIST_ENTRIES)
        .collect()
}

fn list_walk_files(cwd: &str) -> Result<Vec<String>, String> {
    let root = Path::new(cwd);
    fs::read_dir(root).map_err(|_| "Не удалось прочитать папку проекта".to_string())?;
    let mut out = Vec::new();
    let mut visited = 0usize;
    walk(root, "", 0, &mut out, &mut visited);
    Ok(out)
}

fn walk(dir: &Path, rel: &str, depth: usize, out: &mut Vec<String>, visited: &mut usize) {
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        if *visited >= MAX_LIST_ENTRIES {
            return;
        }
        *visited += 1;
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if file_type.is_dir() {
            let skipped = name.starts_with('.') || SKIP_DIRS.contains(&name.as_str());
            if !skipped && depth < MAX_WALK_DEPTH {
                walk(&entry.path(), &child, depth + 1, out, visited);
            }
        } else if file_type.is_file() {
            out.push(child);
        }
    }
}

/// Greedy leftmost positions of every needle char in order, or None if not a subsequence.
fn greedy_positions(hay: &[char], needle: &[char]) -> Option<Vec<usize>> {
    let mut out = Vec::with_capacity(needle.len());
    let mut from = 0usize;
    for &nc in needle {
        let rel = hay.get(from..)?.iter().position(|&c| c == nc)?;
        let idx = from + rel;
        out.push(idx);
        from = idx + 1;
    }
    Some(out)
}

/// Case-insensitive subsequence score; None when the query chars do not appear in order.
/// Higher is better. Prefers matches inside the file name, contiguous runs, word starts,
/// and shorter paths.
fn fuzzy_score(path: &str, query: &str) -> Option<i64> {
    let q: Vec<char> = query.trim().to_lowercase().chars().collect();
    if q.is_empty() {
        return Some(0);
    }
    let p: Vec<char> = path.to_lowercase().chars().collect();
    let name_start = p.iter().rposition(|&c| c == '/').map_or(0, |i| i + 1);

    // Prefer a match fully inside the file name; fall back to the whole path.
    let (positions, in_name) = match greedy_positions(&p[name_start..], &q) {
        Some(pos) => (
            pos.into_iter().map(|i| i + name_start).collect::<Vec<_>>(),
            true,
        ),
        None => (greedy_positions(&p, &q)?, false),
    };
    let first = *positions.first()?;
    let last = *positions.last()?;

    let mut score: i64 = 0;
    if in_name {
        score += 1000;
    }
    for pair in positions.windows(2) {
        if pair[1] == pair[0] + 1 {
            score += 15;
        }
    }
    for &i in &positions {
        let boundary = i == 0
            || p.get(i - 1)
                .is_some_and(|c| matches!(c, '/' | '.' | '-' | '_' | ' '));
        if boundary {
            score += 8;
        }
    }
    let span = (last - first) as i64;
    let gaps = span - (q.len() as i64 - 1);
    score -= 2 * gaps.max(0);

    let name: String = p[name_start..].iter().collect();
    let needle: String = q.iter().collect();
    if name.starts_with(&needle) {
        score += 300;
    } else if name.contains(&needle) {
        score += 150;
    }

    score -= p.len() as i64;
    Some(score)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn porcelain_parses_rename_and_untracked() {
        let raw =
            "R  new name.txt\0old.txt\0 M src/a.rs\0?? docs/new file.md\0A  added.rs\0 D gone.rs\0";
        let entries = parse_porcelain(raw);
        assert_eq!(entries.len(), 5);
        assert_eq!(
            entries[0],
            PorcelainEntry {
                path: "new name.txt".into(),
                status: "renamed",
                old_path: Some("old.txt".into()),
            }
        );
        assert_eq!(entries[1].path, "src/a.rs");
        assert_eq!(entries[1].status, "modified");
        assert_eq!(entries[1].old_path, None);
        assert_eq!(entries[2].status, "untracked");
        assert_eq!(entries[2].path, "docs/new file.md");
        assert_eq!(entries[3].status, "added");
        assert_eq!(entries[4].status, "deleted");
    }

    #[test]
    fn porcelain_maps_conflicts() {
        assert_eq!(map_status(b'U', b'U'), "conflict");
        assert_eq!(map_status(b'A', b'A'), "conflict");
        assert_eq!(map_status(b'D', b'D'), "conflict");
        assert_eq!(map_status(b'A', b'D'), "deleted");
        assert_eq!(map_status(b'A', b'M'), "added");
    }

    #[test]
    fn numstat_parses_binary_and_rename() {
        let raw = "3\t1\tsrc/a.rs\0-\t-\tlogo.png\02\t0\t\0old.txt\0new.txt\0";
        let map = parse_numstat(raw);
        assert_eq!(map.get("src/a.rs"), Some(&(3, 1)));
        assert_eq!(map.get("logo.png"), Some(&(0, 0)));
        assert_eq!(map.get("new.txt"), Some(&(2, 0)));
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn fuzzy_prefers_file_name_and_contiguous_runs() {
        let a = fuzzy_score("src/lib.rs", "lib").unwrap();
        let b = fuzzy_score("src/l/i/b.rs", "lib").unwrap();
        assert!(a > b, "name match should beat scattered match: {a} vs {b}");

        let short = fuzzy_score("a/foo.rs", "foo").unwrap();
        let long = fuzzy_score("a/bbb/ccc/foo.rs", "foo").unwrap();
        assert!(short > long, "shorter path should win: {short} vs {long}");
    }

    #[test]
    fn fuzzy_filters_and_ignores_case() {
        assert!(fuzzy_score("src/main.rs", "xyz").is_none());
        assert!(fuzzy_score("src/main.rs", "MAIN").is_some());
        assert!(fuzzy_score("src/main.rs", "mr").is_some());
        assert!(fuzzy_score("src/main.rs", "nm").is_none());
    }

    #[test]
    fn fuzzy_ranking_order() {
        let mut paths = vec!["docs/mail/index.ts", "src/domain/a/i/n.rs", "src/main.rs"];
        paths.sort_by_key(|p| std::cmp::Reverse(fuzzy_score(p, "main").unwrap_or(i64::MIN)));
        assert_eq!(paths[0], "src/main.rs");
    }

    #[test]
    fn rel_path_safety() {
        assert!(check_rel_path("src/a.rs").is_ok());
        assert!(check_rel_path("a/./b.txt").is_ok());
        assert!(check_rel_path("../etc/passwd").is_err());
        assert!(check_rel_path("a/../../x").is_err());
        assert!(check_rel_path("/etc/passwd").is_err());
        assert!(check_rel_path("").is_err());
        assert!(check_rel_path("  ").is_err());
        assert!(check_rel_path(".").is_err());
        assert!(check_rel_path("a\0b").is_err());
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("octopus-ws-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_test(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn repo_status_diff_restore_roundtrip() {
        let dir = temp_dir("roundtrip");
        let cwd = dir.to_string_lossy().into_owned();
        git_test(&dir, &["init", "-q"]);
        fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        git_test(&dir, &["add", "a.txt"]);
        git_test(&dir, &["commit", "-q", "-m", "init"]);

        // Tracked change: -two, +three, +four.
        fs::write(dir.join("a.txt"), "one\nthree\nfour\n").unwrap();
        // Untracked file without trailing newline.
        fs::write(dir.join("b.txt"), "x\ny\nz").unwrap();

        let st = status_sync(&cwd).unwrap();
        assert!(st.is_repo);
        assert!(st.branch.is_some());
        assert_eq!(st.files.len(), 2);
        let a = &st.files[0];
        assert_eq!(a.path, "a.txt");
        assert_eq!(a.status, "modified");
        assert_eq!((a.additions, a.deletions), (2, 1));
        let b = &st.files[1];
        assert_eq!(b.path, "b.txt");
        assert_eq!(b.status, "untracked");
        assert_eq!((b.additions, b.deletions), (3, 0));
        assert_eq!((st.additions, st.deletions), (5, 1));

        let diff_a = diff_sync(&cwd, "a.txt").unwrap();
        assert!(diff_a.contains("-two"), "{diff_a}");
        assert!(diff_a.contains("+three"), "{diff_a}");
        let diff_b = diff_sync(&cwd, "b.txt").unwrap();
        assert_eq!(
            diff_b,
            "--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1,3 @@\n+x\n+y\n+z\n\\ No newline at end of file\n"
        );

        assert!(restore_sync(&cwd, "../escape.txt").is_err());
        restore_sync(&cwd, "a.txt").unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "one\ntwo\n");
        restore_sync(&cwd, "b.txt").unwrap();
        assert!(!dir.join("b.txt").exists());

        let st = status_sync(&cwd).unwrap();
        assert!(st.files.is_empty());

        let files = files_sync(&cwd, "", 50).unwrap();
        assert_eq!(files, vec!["a.txt".to_string()]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_refuses_repo_without_commits() {
        let dir = temp_dir("nocommit");
        let cwd = dir.to_string_lossy().into_owned();
        git_test(&dir, &["init", "-q"]);
        fs::write(dir.join("s.txt"), "hi\n").unwrap();
        git_test(&dir, &["add", "s.txt"]);
        let err = restore_sync(&cwd, "s.txt").unwrap_err();
        assert!(err.contains("Нет коммитов"), "{err}");
        // Untracked files can still be removed.
        fs::write(dir.join("u.txt"), "x").unwrap();
        restore_sync(&cwd, "u.txt").unwrap();
        assert!(!dir.join("u.txt").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn non_repo_status_and_walk_skip_rules() {
        let dir = temp_dir("walk");
        let cwd = dir.to_string_lossy().into_owned();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::write(dir.join("src/main.rs"), "").unwrap();
        fs::write(dir.join("README.md"), "").unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "").unwrap();
        fs::write(dir.join(".hidden/secret.txt"), "").unwrap();

        let st = status_sync(&cwd).unwrap();
        if !st.is_repo {
            assert!(st.files.is_empty());
            let files = files_sync(&cwd, "", 50).unwrap();
            assert_eq!(
                files,
                vec!["README.md".to_string(), "src/main.rs".to_string()]
            );
            let found = files_sync(&cwd, "mn", 10).unwrap();
            assert_eq!(found, vec!["src/main.rs".to_string()]);
        }
        fs::remove_dir_all(&dir).ok();
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn git_stdout(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// Splits a unified diff of one file into its hunks (each starting at its "@@" line).
    fn split_hunks(diff: &str) -> Vec<String> {
        let mut hunks: Vec<String> = Vec::new();
        for line in diff.split_inclusive('\n') {
            if line.starts_with("@@") {
                hunks.push(String::new());
            }
            if let Some(h) = hunks.last_mut() {
                h.push_str(line);
            }
        }
        hunks
    }

    fn single_file_patch(path: &str, hunk: &str) -> String {
        format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n{hunk}")
    }

    /// Committed 20-line file with two edits far enough apart to form two hunks.
    fn two_hunk_repo(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        git_test(&dir, &["init", "-q"]);
        let original: String = (1..=20).map(|i| format!("line{i}\n")).collect();
        fs::write(dir.join("f.txt"), &original).unwrap();
        git_test(&dir, &["add", "f.txt"]);
        git_test(&dir, &["commit", "-q", "-m", "init"]);
        let edited = original
            .replace("line2\n", "line2 changed\n")
            .replace("line18\n", "line18 changed\n");
        fs::write(dir.join("f.txt"), edited).unwrap();
        dir
    }

    #[test]
    fn hunk_stage_and_revert_touch_only_one_hunk() {
        if !git_available() {
            return;
        }
        let dir = two_hunk_repo("hunks");
        let cwd = dir.to_string_lossy().into_owned();

        let diff = diff_sync(&cwd, "f.txt").unwrap();
        let hunks = split_hunks(&diff);
        assert_eq!(hunks.len(), 2, "{diff}");

        // Stage the first hunk only.
        apply_hunk_sync(&cwd, "f.txt", &single_file_patch("f.txt", &hunks[0]), "stage").unwrap();
        let cached = git_stdout(&dir, &["diff", "--cached"]);
        assert!(cached.contains("+line2 changed"), "{cached}");
        assert!(!cached.contains("line18 changed"), "{cached}");

        // Revert the second hunk in the worktree only.
        let diff = diff_sync(&cwd, "f.txt").unwrap();
        let hunks = split_hunks(&diff);
        assert_eq!(hunks.len(), 2, "{diff}");
        apply_hunk_sync(&cwd, "f.txt", &single_file_patch("f.txt", &hunks[1]), "revert").unwrap();

        let worktree = fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(worktree.contains("line2 changed\n"), "{worktree}");
        assert!(worktree.contains("line18\n"), "{worktree}");
        assert!(!worktree.contains("line18 changed"), "{worktree}");
        // The staged first hunk is still in the index.
        let cached = git_stdout(&dir, &["diff", "--cached"]);
        assert!(cached.contains("+line2 changed"), "{cached}");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hunk_rejects_bad_mode_and_foreign_patch() {
        if !git_available() {
            return;
        }
        let dir = two_hunk_repo("hunk-reject");
        let cwd = dir.to_string_lossy().into_owned();
        let hunks = split_hunks(&diff_sync(&cwd, "f.txt").unwrap());
        let good = single_file_patch("f.txt", &hunks[0]);

        let err = apply_hunk_sync(&cwd, "f.txt", &good, "bogus").unwrap_err();
        assert!(err.contains("режим"), "{err}");
        let err = apply_hunk_sync(&cwd, "f.txt", &good, "").unwrap_err();
        assert!(err.contains("режим"), "{err}");

        // Patch names another file.
        let foreign = single_file_patch("other.txt", &hunks[0]);
        let err = apply_hunk_sync(&cwd, "f.txt", &foreign, "stage").unwrap_err();
        assert!(err.contains("другому файлу"), "{err}");
        // Path escaping the repo.
        assert!(apply_hunk_sync(&cwd, "../f.txt", &good, "stage").is_err());

        // Nothing was staged by the rejected calls.
        assert_eq!(git_stdout(&dir, &["diff", "--cached", "--name-only"]), "");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn patch_check_rules() {
        let ok = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-x\n+y\n";
        assert!(check_patch("a.rs", ok).is_ok());
        // Hunk-less, mismatched, or non-diff body lines are refused.
        assert!(check_patch("a.rs", "--- a/a.rs\n+++ b/a.rs\n").is_err());
        assert!(check_patch("b.rs", ok).is_err());
        let smuggled = format!("{ok}diff --git a/b.rs b/b.rs\n");
        assert!(check_patch("a.rs", &smuggled).is_err());
        let huge = format!("{ok}{}", "+z\n".repeat(MAX_PATCH_BYTES / 3 + 1));
        assert!(check_patch("a.rs", &huge).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected() {
        let base = temp_dir("symlink");
        let cwd_dir = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&cwd_dir).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, cwd_dir.join("link")).unwrap();
        let cwd = cwd_dir.to_string_lossy().into_owned();
        assert!(resolve_inside(&cwd, "link/x.txt").is_err());
        assert!(resolve_inside(&cwd, "new/x.txt").is_ok());
        fs::remove_dir_all(&base).ok();
    }
}

#[cfg(test)]
mod real_data {
    use super::*;
    use std::time::Instant;

    fn home_path(rel: &str) -> String {
        let home = std::env::var("HOME").expect("HOME is set");
        format!("{home}/{rel}")
    }

    #[test]
    #[ignore] // reads the developer's real repos; run with --ignored
    fn smoke() {
        let repo_dir = home_path("Documents/GitHub/Chinadetect");
        let octo_dir = home_path("Documents/GitHub/Octopus-AI");

        // Real git repository (read-only: git_status never writes).
        let t = Instant::now();
        let repo = tauri::async_runtime::block_on(git_status(repo_dir.clone()))
            .expect("git_status on the real repo returns Ok");
        println!(
            "[git] git_status(Chinadetect): is_repo={} branch={:?} files={} +{} -{} ({} ms)",
            repo.is_repo,
            repo.branch,
            repo.files.len(),
            repo.additions,
            repo.deletions,
            t.elapsed().as_millis()
        );
        for f in repo.files.iter().take(3) {
            println!(
                "[git]   {} {} (+{} -{}) old={:?}",
                f.status, f.path, f.additions, f.deletions, f.old_path
            );
        }
        assert!(repo.is_repo);
        assert!(repo.files.len() <= MAX_STATUS_FILES);

        // Not a git repo: must be Ok with an empty, non-repo status, never a panic.
        let t = Instant::now();
        let plain = tauri::async_runtime::block_on(git_status(octo_dir.clone()))
            .expect("git_status on a non-repo returns Ok");
        println!(
            "[git] git_status(Octopus-AI): is_repo={} branch={:?} files={} ({} ms)",
            plain.is_repo,
            plain.branch,
            plain.files.len(),
            t.elapsed().as_millis()
        );
        assert_eq!(plain, GitStatus::not_repo());

        // Fuzzy file search, walk-based (no git).
        let t = Instant::now();
        let hits = tauri::async_runtime::block_on(project_files(octo_dir.clone(), "app".into(), Some(10)))
            .expect("project_files on Octopus-AI returns Ok");
        println!(
            "[search] project_files(Octopus-AI, \"app\", 10): {} hits ({} ms)",
            hits.len(),
            t.elapsed().as_millis()
        );
        for h in &hits {
            println!("[search]   {h}");
        }
        assert!(!hits.is_empty());
        assert!(hits.len() <= 10);
        assert!(hits.iter().all(|p| fuzzy_score(p, "app").is_some()));

        // Git-backed search on the real repo, default limit.
        let t = Instant::now();
        let repo_hits = tauri::async_runtime::block_on(project_files(repo_dir, "app".into(), None))
            .expect("project_files on the repo returns Ok");
        println!(
            "[search] project_files(Chinadetect, \"app\", default): {} hits ({} ms)",
            repo_hits.len(),
            t.elapsed().as_millis()
        );
        assert!(repo_hits.len() <= DEFAULT_LIMIT);

        // Zero limit returns nothing.
        let none = tauri::async_runtime::block_on(project_files(octo_dir, "app".into(), Some(0)))
            .expect("project_files with limit 0 returns Ok");
        assert!(none.is_empty());
    }
}
