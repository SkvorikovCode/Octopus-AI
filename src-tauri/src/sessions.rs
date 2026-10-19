//! Saved omp sessions: lists `$HOME/.omp/agent/sessions/<cwd-dir>/*.jsonl`
//! files with a title and a first-user-message preview, newest first. Only the
//! first lines of each file are read, so listing stays cheap for huge logs.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// Only the head of each session file is inspected.
const MAX_LINES: usize = 60;
/// Upper bound on the number of sessions returned.
const MAX_RESULTS: usize = 100;
const PREVIEW_CHARS: usize = 140;
pub(crate) const TITLE_PREVIEW_CHARS: usize = 60;
const UNTITLED: &str = "Без названия";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub(crate) path: String,
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) cwd: String,
    pub(crate) updated_at: u64,
    pub(crate) preview: Option<String>,
}

/// Lists saved sessions, optionally only those recorded for `cwd`.
#[tauri::command]
pub async fn sessions_list(cwd: Option<String>) -> Vec<SessionMeta> {
    tauri::async_runtime::spawn_blocking(move || {
        sessions_root().map_or_else(Vec::new, |root| list_in(&root, cwd.as_deref()))
    })
    .await
    .unwrap_or_default()
}

/// Sessions of each of `cwds`, one list per entry in the same order.
#[tauri::command]
pub async fn sessions_list_many(cwds: Vec<String>) -> Vec<Vec<SessionMeta>> {
    let n = cwds.len();
    tauri::async_runtime::spawn_blocking(move || match sessions_root() {
        Some(root) => list_many_in(&root, &cwds),
        None => vec![Vec::new(); cwds.len()],
    })
    .await
    .unwrap_or_else(|_| vec![Vec::new(); n])
}

pub(crate) fn list_in(root: &Path, cwd: Option<&str>) -> Vec<SessionMeta> {
    match cwd.filter(|s| !s.is_empty()) {
        Some(want) => list_many_in(root, &[want.to_string()]).pop().unwrap_or_default(),
        None => {
            let mut out = Vec::new();
            for_each_meta(root, |meta| out.push(meta));
            newest_first(out)
        }
    }
}

/// One walk of the sessions directory for all `cwds`. Each wanted folder is
/// canonicalized once per call and each session's folder once per file; an
/// empty entry matches every session, as `list_in(root, None)` does.
pub(crate) fn list_many_in(root: &Path, cwds: &[String]) -> Vec<Vec<SessionMeta>> {
    let wanted: Vec<Option<PathBuf>> = cwds.iter().map(|c| fs::canonicalize(c).ok()).collect();
    let mut out: Vec<Vec<SessionMeta>> = vec![Vec::new(); cwds.len()];
    for_each_meta(root, |meta| {
        let canon = fs::canonicalize(&meta.cwd).ok();
        for (i, want) in cwds.iter().enumerate() {
            if want.is_empty() || same_cwd_canon(&meta.cwd, canon.as_deref(), want, wanted[i].as_deref()) {
                out[i].push(meta.clone());
            }
        }
    });
    out.into_iter().map(newest_first).collect()
}

fn newest_first(mut list: Vec<SessionMeta>) -> Vec<SessionMeta> {
    list.sort_by_key(|m| std::cmp::Reverse(m.updated_at));
    list.truncate(MAX_RESULTS);
    list
}

/// Calls `f` with the head of every session file under `root` that has a user message.
fn for_each_meta(root: &Path, mut f: impl FnMut(SessionMeta)) {
    let mut cache = META_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let mut old = cache.take().unwrap_or_default();
    let mut fresh = HashMap::with_capacity(old.len());

    // Exactly one level of subdirectories, each holding *.jsonl files.
    for dir in fs::read_dir(root).into_iter().flatten().flatten() {
        for file in fs::read_dir(dir.path()).into_iter().flatten().flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(meta) = cached_meta(&path, &mut old, &mut fresh) {
                f(meta);
            }
        }
    }
    // Whatever is left of `root` was deleted; entries of other roots stay.
    old.retain(|p, _| !p.starts_with(root));
    fresh.extend(old);
    *cache = Some(fresh);
}

struct CachedMeta {
    len: u64,
    modified: SystemTime,
    meta: Option<SessionMeta>,
}

/// `read_meta` results by path. Session files only grow, so while a file's size
/// and mtime stay the same its head does too. Every listing drops the entries
/// of files that are gone.
static META_CACHE: Mutex<Option<HashMap<PathBuf, CachedMeta>>> = Mutex::new(None);

/// `read_meta`, reusing the previous listing's result for an unchanged file.
fn cached_meta(
    path: &Path,
    old: &mut HashMap<PathBuf, CachedMeta>,
    fresh: &mut HashMap<PathBuf, CachedMeta>,
) -> Option<SessionMeta> {
    let Some((len, modified)) = fs::metadata(path)
        .ok()
        .and_then(|m| Some((m.len(), m.modified().ok()?)))
    else {
        return read_meta(path);
    };
    let entry = match old.remove(path) {
        Some(c) if c.len == len && c.modified == modified => c,
        _ => CachedMeta {
            len,
            modified,
            meta: read_meta(path),
        },
    };
    let meta = entry.meta.clone();
    fresh.insert(path.to_path_buf(), entry);
    meta
}

pub(crate) fn sessions_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".omp/agent/sessions"))
}

/// Reads the head of one session file. Returns `None` for unreadable files and
/// for sessions without any user message.
pub(crate) fn read_meta(path: &Path) -> Option<SessionMeta> {
    let file = File::open(path).ok()?;

    let mut id = None;
    let mut cwd = String::new();
    let mut session_title = None;
    let mut title_line = None;
    let mut preview = None;

    // Lines that fail to read or parse are skipped.
    for line in BufReader::new(file).lines().take(MAX_LINES).flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(Value::as_str) {
            // A later title line (after a rename) overrides an earlier one.
            Some("title") => {
                if let Some(t) = text(v.get("title")) {
                    title_line = Some(t);
                }
            }
            Some("session") => {
                id = text(v.get("id"));
                cwd = text(v.get("cwd")).unwrap_or_default();
                session_title = text(v.get("title"));
            }
            // Only the first user message with non-empty text is the preview.
            Some("message") if preview.is_none() => {
                preview = user_text(&v);
            }
            _ => {}
        }
    }

    let preview = preview?;
    let title = title_line
        .or(session_title)
        .or_else(|| {
            (!preview.is_empty()).then(|| short_title(&preview, TITLE_PREVIEW_CHARS))
        })
        .unwrap_or_else(|| UNTITLED.to_string());
    let id = id.unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string()
    });
    let updated_at = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));

    Some(SessionMeta {
        path: path.to_string_lossy().into_owned(),
        id,
        title,
        cwd,
        updated_at,
        preview: Some(preview),
    })
}

/// Text of a `message` line when it is a user message with non-empty text.
/// Content may be a plain string or an array of blocks (only `text` blocks count).
pub(crate) fn user_text(v: &Value) -> Option<String> {
    let msg = v.get("message")?;
    if msg.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let raw = match msg.get("content")? {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|i| i.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|i| i.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    // Plan-first prompts append the app's instruction after "\n\n—\n": keep the task.
    let raw = raw.split("\n\n—\n").next().unwrap_or_default();
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(clip(&collapsed, PREVIEW_CHARS))
}

/// Keeps at most `max` characters, appending "…" when something was cut.
fn clip(s: &str, max: usize) -> String {
    let mut chars = s.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// Shortens `text` to at most `max_chars` characters for use as a title.
/// Cuts back to the last whitespace when it sits in the second half of the
/// limit, drops trailing punctuation and appends "…". A single long word is
/// hard-cut instead. Works on chars, so multi-byte text is never split.
pub(crate) fn short_title(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    if max_chars == 0 {
        return String::new();
    }
    let head: Vec<char> = text.chars().take(max_chars).collect();
    let word_cut = head
        .iter()
        .rposition(|c| c.is_whitespace())
        .filter(|&i| i >= max_chars / 2);
    if let Some(i) = word_cut {
        let kept: String = head[..i].iter().collect();
        let kept = kept.trim_end_matches(|c: char| c.is_whitespace() || ",.;:—-".contains(c));
        if !kept.is_empty() {
            return format!("{kept}…");
        }
    }
    let kept: String = head[..max_chars - 1].iter().collect();
    format!("{kept}…")
}

/// Trimmed, non-empty string value.
fn text(v: Option<&Value>) -> Option<String> {
    v?.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Canonical comparison (resolves `/tmp` vs `/private/tmp` on macOS); when a
/// path cannot be canonicalized, falls back to comparing the raw strings.
pub(crate) fn same_cwd(a: &str, b: &str) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

/// `same_cwd` with the canonical forms already computed by the caller.
fn same_cwd_canon(a: &str, canon_a: Option<&Path>, b: &str, canon_b: Option<&Path>) -> bool {
    match (canon_a, canon_b) {
        (Some(x), Some(y)) => x == y,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

/// Deletes one saved session file. Only `.jsonl` files inside the omp
/// sessions directory are accepted, so a bad path can never remove anything else.
#[tauri::command]
pub fn session_delete(path: String) -> Result<(), String> {
    let root = sessions_root().ok_or("не найден HOME")?;
    let root = fs::canonicalize(&root).map_err(|_| "нет папки сессий агента")?;
    let target = fs::canonicalize(&path).map_err(|_| "сессия не найдена")?;
    let inside = target.starts_with(&root) && target.parent().and_then(Path::parent) == Some(root.as_path());
    if !inside || target.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("это не файл сессии агента".into());
    }
    fs::remove_file(&target).map_err(|e| format!("не удалось удалить: {e}"))
}

/// Sessions modified more recently than this are never pruned, so a session
/// another app or terminal just opened is safe.
const PRUNE_MIN_AGE_SECS: u64 = 3600;
/// Files larger than this carry real content, so they are never pruned.
const PRUNE_MAX_BYTES: u64 = 64 * 1024;

/// Deletes header-only session files (no `message` lines) for one project
/// folder that are older than `PRUNE_MIN_AGE_SECS`, except the session `keep_id`.
/// Returns how many files were removed.
#[tauri::command]
pub fn sessions_prune_empty(cwd: String, keep_id: Option<String>) -> Result<u32, String> {
    let Some(root) = sessions_root() else {
        return Ok(0);
    };
    Ok(prune_empty_in(&root, &cwd, keep_id.as_deref(), SystemTime::now()))
}

/// Core of `sessions_prune_empty`, with the root and the clock passed in so it
/// can be tested against a temp directory.
fn prune_empty_in(root: &Path, cwd: &str, keep_id: Option<&str>, now: SystemTime) -> u32 {
    if cwd.trim().is_empty() {
        return 0;
    }
    let Ok(root) = fs::canonicalize(root) else {
        return 0;
    };
    let mut removed = 0;
    // Same layout as sessions_list: exactly one level of subdirectories.
    for dir in fs::read_dir(&root).into_iter().flatten().flatten() {
        // symlink_metadata: a symlinked directory is never entered.
        if !fs::symlink_metadata(dir.path()).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        for file in fs::read_dir(dir.path()).into_iter().flatten().flatten() {
            let path = file.path();
            if !is_prunable(&root, &path, cwd, keep_id, now) {
                continue;
            }
            if fs::remove_file(&path).is_ok() {
                removed += 1;
                remove_empty_lock(&path);
            }
        }
    }
    removed
}

/// True when `path` is a small, old, `.jsonl` regular file inside `root` whose
/// header belongs to `cwd`, is not `keep_id`, and has no `message` line.
fn is_prunable(root: &Path, path: &Path, cwd: &str, keep_id: Option<&str>, now: SystemTime) -> bool {
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return false;
    }
    // Regular files only: symlinks are never followed or deleted.
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > PRUNE_MAX_BYTES {
        return false;
    }
    let old_enough = meta
        .modified()
        .ok()
        .and_then(|m| now.duration_since(m).ok())
        .is_some_and(|age| age >= Duration::from_secs(PRUNE_MIN_AGE_SECS));
    if !old_enough {
        return false;
    }
    // Exactly two levels below the root, as in session_delete.
    let Ok(target) = fs::canonicalize(path) else {
        return false;
    };
    if !(target.starts_with(root) && target.parent().and_then(Path::parent) == Some(root)) {
        return false;
    }
    let Ok(file) = File::open(&target) else {
        return false;
    };
    // Read at most one byte past the limit, in case the file grew after the stat.
    let mut text = String::new();
    if file.take(PRUNE_MAX_BYTES + 1).read_to_string(&mut text).is_err() {
        return false;
    }
    if u64::try_from(text.len()).unwrap_or(u64::MAX) > PRUNE_MAX_BYTES {
        return false;
    }
    header_only_for(&text, cwd, keep_id, path)
}

/// True when the text has a session header for `cwd` (and not `keep_id`) and no
/// `message` line. A line that does not parse as JSON makes the file unsafe to
/// delete, so it counts as "keep".
fn header_only_for(text: &str, cwd: &str, keep_id: Option<&str>, path: &Path) -> bool {
    let stem = path.file_stem().and_then(|s| s.to_str());
    let mut is_ours = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        match v.get("type").and_then(Value::as_str) {
            Some("message") => return false,
            Some("session") => {
                let id = v.get("id").and_then(Value::as_str);
                if keep_id.is_some_and(|k| Some(k) == id || Some(k) == stem) {
                    return false;
                }
                let session_cwd = v.get("cwd").and_then(Value::as_str).unwrap_or_default();
                if same_cwd(session_cwd, cwd) {
                    is_ours = true;
                }
            }
            _ => {}
        }
    }
    is_ours
}

/// Removes the engine's `.<name>.lock.os` next to a deleted session, but only
/// when it is an empty regular file. Errors are ignored.
fn remove_empty_lock(session: &Path) {
    let Some(name) = session.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let lock = session.with_file_name(format!(".{name}.lock.os"));
    let empty_regular = fs::symlink_metadata(&lock).is_ok_and(|m| m.is_file() && m.len() == 0);
    if empty_regular {
        let _ = fs::remove_file(&lock);
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
    #[ignore] // reads the developer's real ~/.omp data; run with --ignored
    fn smoke() {
        let t = Instant::now();
        let root = sessions_root().expect("HOME is set");
        let all = list_in(&root, None);
        println!(
            "[sessions] sessions_list(None): {} sessions in {} ms",
            all.len(),
            t.elapsed().as_millis()
        );
        for m in all.iter().take(3) {
            println!(
                "[sessions]   title={:?} cwd={} id={} updated_at={} preview_chars={}",
                m.title,
                m.cwd,
                m.id,
                m.updated_at,
                m.preview.as_ref().map_or(0, |p| p.chars().count())
            );
        }
        let empty_titles = all.iter().filter(|m| m.title.trim().is_empty()).count();
        let placeholder = all.iter().filter(|m| m.title == UNTITLED).count();
        println!("[sessions]   empty titles: {empty_titles}, placeholder titles: {placeholder}");
        assert!(all.len() <= MAX_RESULTS);
        assert_eq!(empty_titles, 0);
        assert!(all.iter().all(|m| !m.path.is_empty() && !m.id.is_empty()));

        // Filter by the cwd of the newest session; every match must carry that cwd.
        if let Some(first) = all.first() {
            let want = first.cwd.clone();
            let t = Instant::now();
            let filtered = list_in(&root, Some(want.as_str()));
            println!(
                "[sessions] sessions_list(Some({want})): {} sessions in {} ms",
                filtered.len(),
                t.elapsed().as_millis()
            );
            assert!(!filtered.is_empty());
            assert!(filtered.iter().all(|m| same_cwd(&m.cwd, &want)));
            let expected = all.iter().filter(|m| same_cwd(&m.cwd, &want)).count();
            assert_eq!(filtered.len(), expected);
        }

        // Octopus-AI itself: a project with no recorded sessions should give none.
        let octo = home_path("Documents/GitHub/Octopus-AI");
        let t = Instant::now();
        let octo_list = list_in(&root, Some(octo.as_str()));
        println!(
            "[sessions] sessions_list(Some(Octopus-AI)): {} sessions in {} ms",
            octo_list.len(),
            t.elapsed().as_millis()
        );
        assert!(octo_list.iter().all(|m| same_cwd(&m.cwd, &octo)));
    }
}

#[cfg(test)]
mod title_tests {
    use super::*;

    const README_PROMPT: &str = "В README.md замени ‘return a + b;’ на ‘return a + b + 0;’. Больше ничего не трогай";

    #[test]
    fn short_text_is_unchanged() {
        assert_eq!(short_title("  Короткий заголовок  ", 60), "Короткий заголовок");
        let exact = "я".repeat(60);
        assert_eq!(short_title(&exact, 60), exact);
    }

    #[test]
    fn cuts_at_word_boundary_without_ellipsis_mid_word() {
        let out = short_title(README_PROMPT, TITLE_PREVIEW_CHARS);
        assert_eq!(out, "В README.md замени ‘return a + b;’ на ‘return a + b + 0;’…");
        assert!(out.ends_with('…'));
        assert!(!out.contains('Б'));
        assert!(out.chars().count() <= 60);
    }

    #[test]
    fn single_long_word_is_hard_cut_to_limit() {
        let out = short_title(&"x".repeat(100), 60);
        assert_eq!(out.chars().count(), 60);
        assert_eq!(out, format!("{}…", "x".repeat(59)));
    }

    #[test]
    fn cyrillic_long_word_is_hard_cut_on_chars() {
        let out = short_title(&"ъ".repeat(100), 60);
        assert_eq!(out.chars().count(), 60);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().filter(|&c| c == 'ъ').count(), 59);
    }

    #[test]
    fn early_space_falls_back_to_hard_cut() {
        // The only whitespace sits at index 1, before max/2, so no word cut.
        let out = short_title(&format!("а {}", "б".repeat(100)), 60);
        assert_eq!(out.chars().count(), 60);
        assert!(out.starts_with("а б"));
        assert!(out.ends_with('…'));
    }

    #[test]
    fn cyrillic_multibyte_cut_is_char_safe() {
        let text = "Привет, мир! Сделай это, пожалуйста, и ещё что-нибудь очень длинное для проверки";
        let out = short_title(text, 40);
        assert_eq!(out, "Привет, мир! Сделай это, пожалуйста, и…");
        assert!(out.chars().count() <= 40);
    }

    #[test]
    fn trailing_punctuation_is_dropped_before_ellipsis() {
        assert_eq!(short_title("раз два три, четыре пять шесть", 13), "раз два три…");
    }
}

#[cfg(test)]
mod prune_tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    const CWD: &str = "/nonexistent-octopus-prune/project-a";
    const OTHER_CWD: &str = "/nonexistent-octopus-prune/project-b";

    /// Fresh directory under the system temp dir, removed on drop.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "octopus-prune-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn header(id: &str, cwd: &str) -> String {
        format!(
            "{{\"type\":\"title\",\"title\":\"New session\"}}\n\
             {{\"type\":\"session\",\"id\":\"{id}\",\"cwd\":\"{cwd}\"}}\n"
        )
    }

    fn message_line() -> String {
        "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n".to_string()
    }

    /// Writes `<root>/<dir>/<name>` with `body` and returns its path.
    fn write(root: &Path, dir: &str, name: &str, body: &str) -> PathBuf {
        let d = root.join(dir);
        fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        fs::write(&p, body).unwrap();
        p
    }

    /// A clock two hours ahead of the files just written, so they count as old.
    fn later() -> SystemTime {
        SystemTime::now() + Duration::from_secs(2 * 3600)
    }

    #[test]
    fn header_only_old_file_is_removed_with_its_lock() {
        let t = TempRoot::new();
        let name = "2026-01-01T00-00-00_a.jsonl";
        let file = write(&t.0, "enc-a", name, &header("id-a", CWD));
        let lock = write(&t.0, "enc-a", &format!(".{name}.lock.os"), "");
        assert_eq!(prune_empty_in(&t.0, CWD, None, later()), 1);
        assert!(!file.exists());
        assert!(!lock.exists());
    }

    #[test]
    fn non_empty_lock_is_left_alone() {
        let t = TempRoot::new();
        let name = "2026-01-01T00-00-00_a.jsonl";
        let file = write(&t.0, "enc-a", name, &header("id-a", CWD));
        let lock = write(&t.0, "enc-a", &format!(".{name}.lock.os"), "pid 123\n");
        assert_eq!(prune_empty_in(&t.0, CWD, None, later()), 1);
        assert!(!file.exists());
        assert!(lock.exists());
    }

    #[test]
    fn session_with_a_message_is_kept() {
        let t = TempRoot::new();
        let body = header("id-a", CWD) + &message_line();
        let file = write(&t.0, "enc-a", "s.jsonl", &body);
        assert_eq!(prune_empty_in(&t.0, CWD, None, later()), 0);
        assert!(file.exists());
    }

    #[test]
    fn young_file_is_kept() {
        let t = TempRoot::new();
        let file = write(&t.0, "enc-a", "s.jsonl", &header("id-a", CWD));
        assert_eq!(prune_empty_in(&t.0, CWD, None, SystemTime::now()), 0);
        assert!(file.exists());
    }

    #[test]
    fn keep_id_is_kept() {
        let t = TempRoot::new();
        let file = write(&t.0, "enc-a", "s.jsonl", &header("keep-me", CWD));
        assert_eq!(prune_empty_in(&t.0, CWD, Some("keep-me"), later()), 0);
        assert!(file.exists());
    }

    #[test]
    fn other_cwd_is_kept() {
        let t = TempRoot::new();
        let file = write(&t.0, "enc-b", "s.jsonl", &header("id-b", OTHER_CWD));
        assert_eq!(prune_empty_in(&t.0, CWD, None, later()), 0);
        assert!(file.exists());
    }

    #[test]
    fn non_jsonl_is_kept() {
        let t = TempRoot::new();
        let file = write(&t.0, "enc-a", "notes.txt", &header("id-a", CWD));
        assert_eq!(prune_empty_in(&t.0, CWD, None, later()), 0);
        assert!(file.exists());
    }

    #[test]
    fn file_over_size_limit_is_kept() {
        let t = TempRoot::new();
        let big_title = format!(
            "{{\"type\":\"title\",\"title\":\"{}\"}}\n",
            "x".repeat(70 * 1024)
        );
        let body = big_title + &header("id-a", CWD);
        let file = write(&t.0, "enc-a", "s.jsonl", &body);
        assert_eq!(prune_empty_in(&t.0, CWD, None, later()), 0);
        assert!(file.exists());
    }

    #[test]
    fn unparseable_line_is_kept() {
        let t = TempRoot::new();
        let body = header("id-a", CWD) + "not json\n";
        let file = write(&t.0, "enc-a", "s.jsonl", &body);
        assert_eq!(prune_empty_in(&t.0, CWD, None, later()), 0);
        assert!(file.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed_or_removed() {
        use std::os::unix::fs::symlink;
        let t = TempRoot::new();
        let outside = TempRoot::new();
        let real = write(&outside.0, "x", "real.jsonl", &header("id-a", CWD));
        fs::create_dir_all(t.0.join("enc-a")).unwrap();
        symlink(&real, t.0.join("enc-a").join("link.jsonl")).unwrap();
        write(&outside.0, "enc-out", "s.jsonl", &header("id-b", CWD));
        symlink(outside.0.join("enc-out"), t.0.join("enc-link")).unwrap();

        assert_eq!(prune_empty_in(&t.0, CWD, None, later()), 0);
        assert!(real.exists());
        assert!(outside.0.join("enc-out").join("s.jsonl").exists());
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use std::io::Write;

    const CWD: &str = "/nonexistent-octopus-meta-cache/project";

    fn session(task: &str) -> String {
        format!(
            "{{\"type\":\"session\",\"id\":\"s1\",\"cwd\":\"{CWD}\"}}\n\
             {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"{task}\"}}}}\n"
        )
    }

    #[test]
    fn listing_rereads_only_changed_files_and_forgets_deleted_ones() {
        let root = std::env::temp_dir().join(format!("octopus-meta-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("project")).unwrap();
        let path = root.join("project").join("s1.jsonl");
        fs::write(&path, session("first task")).unwrap();
        let titles = || list_in(&root, Some(CWD)).into_iter().map(|m| m.title).collect::<Vec<_>>();
        assert_eq!(titles(), ["first task"]);

        // Same size and mtime, other bytes: the cached head stands.
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, session("other task")).unwrap();
        File::options().write(true).open(&path).unwrap().set_modified(modified).unwrap();
        assert_eq!(titles(), ["first task"]);

        // A rename appends a title line: the size changes and the head is read again.
        let mut file = File::options().append(true).open(&path).unwrap();
        writeln!(file, "{{\"type\":\"title\",\"title\":\"Renamed\"}}").unwrap();
        drop(file);
        assert_eq!(titles(), ["Renamed"]);

        // A deleted file leaves both the list and the cache.
        fs::remove_file(&path).unwrap();
        assert!(titles().is_empty());
        let cache = META_CACHE.lock().unwrap();
        assert!(!cache.as_ref().unwrap().contains_key(&path));
        drop(cache);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn one_walk_lists_each_folder_in_order() {
        let root = std::env::temp_dir().join(format!("octopus-list-many-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("dir")).unwrap();
        let write = |name: &str, cwd: &str, task: &str, secs: u64| {
            let path = root.join("dir").join(name);
            fs::write(
                &path,
                format!(
                    "{{\"type\":\"session\",\"id\":\"{name}\",\"cwd\":\"{cwd}\"}}\n\
                     {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"{task}\"}}}}\n"
                ),
            )
            .unwrap();
            let at = UNIX_EPOCH + Duration::from_secs(1_760_000_000 + secs);
            File::options().write(true).open(&path).unwrap().set_modified(at).unwrap();
        };
        let (project, copy) = ("/nonexistent-octopus-many/project", "/nonexistent-octopus-many/copy");
        write("a.jsonl", project, "older", 10);
        write("b.jsonl", project, "newer", 20);
        write("c.jsonl", copy, "in the copy", 15);
        write("d.jsonl", "/nonexistent-octopus-many/other", "elsewhere", 30);

        let wanted = [project.to_string(), format!("{copy}/"), "/nonexistent-octopus-many/none".to_string()];
        let titles = |list: &[SessionMeta]| list.iter().map(|m| m.title.clone()).collect::<Vec<_>>();
        let lists = list_many_in(&root, &wanted);
        assert_eq!(lists.len(), 3);
        assert_eq!(titles(&lists[0]), ["newer", "older"]);
        assert_eq!(titles(&lists[1]), ["in the copy"]);
        assert!(lists[2].is_empty());
        for (list, cwd) in lists.iter().zip(&wanted) {
            assert_eq!(titles(list), titles(&list_in(&root, Some(cwd.as_str()))));
        }
        let _ = fs::remove_dir_all(&root);
    }
}
