//! Full-text search through the saved omp sessions of one project. Every
//! session recorded for the project is read in full, newest first, and each
//! matching message yields one hit with a short snippet around the match.
//! Only what the user and the assistant actually wrote is searched: user text,
//! assistant `text` blocks. Thinking, tool calls and tool results are skipped.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::Value;

use crate::sessions::{read_meta, same_cwd, sessions_root, SessionMeta};

/// Session files larger than this are skipped.
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const DEFAULT_LIMIT: usize = 30;
const MAX_LIMIT: usize = 200;
/// At most this many hits from one session (the most recent ones).
const PER_SESSION: usize = 3;
/// Shortest query, in chars, that is searched.
const MIN_QUERY_CHARS: usize = 2;
const SNIPPET_BEFORE: usize = 40;
const SNIPPET_AFTER: usize = 80;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    path: String,
    session_id: String,
    title: String,
    /// "user" or "assistant".
    role: String,
    snippet: String,
    /// Char offset of the match inside `snippet`.
    match_start: usize,
    /// Length of the match in chars.
    match_len: usize,
    /// Message time, ms since epoch.
    at: u64,
}

/// Searches the conversations of the project `cwd` for `query`
/// (case-insensitive). Runs on a blocking thread.
#[tauri::command]
pub async fn sessions_search(
    cwd: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(root) = sessions_root() else {
            return Vec::new();
        };
        search_in(&root, &cwd, &query, limit)
    })
    .await
    .map_err(|e| format!("Внутренняя ошибка: {e}"))
}

/// Core of `sessions_search`, with the root passed in so tests can use a temp
/// directory. Hits come newest session first; within a session, newest first.
fn search_in(root: &Path, cwd: &str, query: &str, limit: usize) -> Vec<SearchHit> {
    let cwd = cwd.trim();
    let needle: Vec<char> = normalize_ws(query).chars().map(fold).collect();
    if cwd.is_empty() || needle.len() < MIN_QUERY_CHARS {
        return Vec::new();
    }

    let mut out = Vec::new();
    for meta in project_sessions(root, cwd) {
        if out.len() >= limit {
            break;
        }
        let take = PER_SESSION.min(limit - out.len());
        out.extend(session_hits(&meta, &needle).into_iter().take(take));
    }
    out
}

/// Sessions recorded for `cwd`, newest first. Same walk and header reading as
/// `sessions_list`.
fn project_sessions(root: &Path, cwd: &str) -> Vec<SessionMeta> {
    let mut out = Vec::new();
    // Exactly one level of subdirectories, each holding *.jsonl files.
    for dir in fs::read_dir(root).into_iter().flatten().flatten() {
        for file in fs::read_dir(dir.path()).into_iter().flatten().flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(meta) = read_meta(&path) else {
                continue;
            };
            if same_cwd(&meta.cwd, cwd) {
                out.push(meta);
            }
        }
    }
    out.sort_by_key(|m| std::cmp::Reverse(m.updated_at));
    out
}

/// Matching messages of one session, newest first, at most `PER_SESSION`.
/// Each message contributes its first match only.
fn session_hits(meta: &SessionMeta, needle: &[char]) -> Vec<SearchHit> {
    let too_big = fs::metadata(&meta.path).map_or(true, |m| m.len() > MAX_FILE_BYTES);
    if too_big {
        return Vec::new();
    }
    let Ok(file) = File::open(&meta.path) else {
        return Vec::new();
    };

    let mut kept: VecDeque<SearchHit> = VecDeque::with_capacity(PER_SESSION + 1);
    // Lines that fail to read or parse are skipped.
    for line in BufReader::new(file).lines().flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some((role, text)) = message_text(&v) else {
            continue;
        };
        let chars: Vec<char> = text.chars().collect();
        let folded: Vec<char> = chars.iter().map(|&c| fold(c)).collect();
        let Some(at) = folded.windows(needle.len()).position(|w| w == needle) else {
            continue;
        };
        let (snippet, match_start, match_len) = snippet(&chars, at, needle.len());
        kept.push_back(SearchHit {
            path: meta.path.clone(),
            session_id: meta.id.clone(),
            title: meta.title.clone(),
            role: role.to_string(),
            snippet,
            match_start,
            match_len,
            at: message_time(&v).unwrap_or(meta.updated_at),
        });
        if kept.len() > PER_SESSION {
            kept.pop_front();
        }
    }
    kept.into_iter().rev().collect()
}

/// Plain searchable text of a `message` line: the user's text, or the assistant's
/// `text` blocks. Other roles (tool results) and other block types are ignored.
/// Whitespace is normalized, so the snippet needs no further cleanup.
fn message_text(v: &Value) -> Option<(&'static str, String)> {
    let msg = v.get("message")?;
    let role = match msg.get("role").and_then(Value::as_str)? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
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
    let text = normalize_ws(&raw);
    if text.is_empty() {
        return None;
    }
    Some((role, text))
}

/// Time of a message line in ms: the `message.timestamp` number when present,
/// else the line's ISO `timestamp`.
fn message_time(v: &Value) -> Option<u64> {
    if let Some(ms) = v
        .get("message")
        .and_then(|m| m.get("timestamp"))
        .and_then(Value::as_u64)
    {
        return Some(ms);
    }
    v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms)
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff]Z` (UTC) into ms since epoch.
fn parse_iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    let shape_ok = b.len() >= 19
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':';
    if !shape_ok {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut ms = 0;
    if let Some(frac) = s.get(19..).and_then(|r| r.strip_prefix('.')) {
        let digits: String = frac
            .chars()
            .take_while(char::is_ascii_digit)
            .take(3)
            .collect();
        if !digits.is_empty() {
            ms = digits.parse::<i64>().ok()? * 10i64.pow(3 - digits.len() as u32);
        }
    }
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h * 3_600 + mi * 60 + sec;
    u64::try_from(secs * 1000 + ms).ok()
}

/// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12; // March = 0
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Case fold of one char that yields exactly one char, so positions in the
/// original text stay aligned. "ё" folds to "е", as in the palette search.
fn fold(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some('ё'), None) => 'е',
        (Some(l), None) => l,
        _ => c,
    }
}

/// Collapses every run of whitespace to one space and trims the ends.
fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Snippet around the match at chars `[at, at + len)` of `chars`, which is
/// whitespace-normalized. Takes up to `SNIPPET_BEFORE` chars before and
/// `SNIPPET_AFTER` after, adds "…" where the text was cut, and returns the
/// match offset and length in chars inside the snippet.
fn snippet(chars: &[char], at: usize, len: usize) -> (String, usize, usize) {
    let mut start = at.saturating_sub(SNIPPET_BEFORE);
    let mut end = (at + len + SNIPPET_AFTER).min(chars.len());
    // Do not start or end a cut with a space. The match itself starts and ends
    // on non-space chars, so these adjustments never touch it.
    if start > 0 && chars[start] == ' ' {
        start += 1;
    }
    if end < chars.len() && chars[end - 1] == ' ' {
        end -= 1;
    }

    let mut out = String::new();
    let mut match_start = at - start;
    if start > 0 {
        out.push('…');
        match_start += 1;
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    (out, match_start, len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    const CWD: &str = "/nonexistent-octopus-search/project-a";
    const OTHER_CWD: &str = "/nonexistent-octopus-search/project-b";

    /// Fresh directory under the system temp dir, removed on drop.
    struct TempRoot(std::path::PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "octopus-search-{}-{nanos}-{n}",
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

    /// Writes one session file with a header for `cwd` and the given lines.
    fn write_session(root: &Path, id: &str, cwd: &str, lines: &[Value]) {
        let dir = root.join(format!("enc-{id}"));
        fs::create_dir_all(&dir).unwrap();
        let mut body = serde_json::json!({"type": "session", "id": id, "cwd": cwd}).to_string();
        body.push('\n');
        for line in lines {
            body.push_str(&line.to_string());
            body.push('\n');
        }
        fs::write(dir.join(format!("{id}.jsonl")), body).unwrap();
    }

    fn user(text: &str) -> Value {
        serde_json::json!({
            "type": "message",
            "message": {"role": "user", "content": [{"type": "text", "text": text}]}
        })
    }

    fn assistant(text: &str) -> Value {
        serde_json::json!({
            "type": "message",
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}
        })
    }

    /// Chars of `hit.snippet` at the match offsets.
    fn matched(hit: &SearchHit) -> String {
        hit.snippet
            .chars()
            .skip(hit.match_start)
            .take(hit.match_len)
            .collect()
    }

    #[test]
    fn cyrillic_match_is_case_insensitive() {
        let t = TempRoot::new();
        write_session(
            &t.0,
            "s1",
            CWD,
            &[user("Как устроен ПАРСЕР?"), assistant("Парсер читает файлы.")],
        );
        let hits = search_in(&t.0, CWD, "ПаРсЕр", 30);
        assert_eq!(hits.len(), 2);
        // Newest message first within the session.
        assert_eq!(hits[0].role, "assistant");
        assert_eq!(matched(&hits[0]), "Парсер");
        assert_eq!(hits[1].role, "user");
        assert_eq!(matched(&hits[1]), "ПАРСЕР");
    }

    #[test]
    fn yo_folds_to_ye() {
        let t = TempRoot::new();
        write_session(&t.0, "s1", CWD, &[user("Ёлка в лесу")]);
        let hits = search_in(&t.0, CWD, "елка", 30);
        assert_eq!(hits.len(), 1);
        assert_eq!(matched(&hits[0]), "Ёлка");
    }

    #[test]
    fn snippet_offsets_point_at_the_match() {
        let t = TempRoot::new();
        let text = format!("{} ПАРСЕР {}", "a".repeat(100), "b".repeat(200));
        write_session(&t.0, "s1", CWD, &[user(&text)]);
        let hits = search_in(&t.0, CWD, "парсер", 30);
        assert_eq!(hits.len(), 1);
        let hit = &hits[0];
        // "…" + 40 chars before the match (the "…" shifts the offset by one).
        assert_eq!(hit.match_start, 41);
        assert_eq!(hit.match_len, 6);
        assert_eq!(matched(hit), "ПАРСЕР");
        assert_eq!(
            hit.snippet,
            format!("…{} ПАРСЕР {}…", "a".repeat(39), "b".repeat(79))
        );
        assert_eq!(hit.session_id, "s1");
        // No session title line: the title is the first user text, hard-cut
        // because its only word is longer than the title limit.
        assert_eq!(hit.title, format!("{}…", "a".repeat(59)));
    }

    #[test]
    fn newlines_collapse_and_offsets_stay_right() {
        let t = TempRoot::new();
        write_session(&t.0, "s1", CWD, &[user("строка один\n\n\nпарсер здесь")]);
        let hits = search_in(&t.0, CWD, "парсер", 30);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet, "строка один парсер здесь");
        assert_eq!(hits[0].match_start, 12);
        assert_eq!(matched(&hits[0]), "парсер");
    }

    #[test]
    fn thinking_tool_calls_and_tool_results_are_not_searched() {
        let t = TempRoot::new();
        let thinking = serde_json::json!({
            "type": "message",
            "message": {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "секретныйпоиск внутри размышления"},
                {"type": "toolCall", "name": "read", "arguments": {"path": "секретныйпоиск.md"}},
                {"type": "text", "text": "Готово"}
            ]}
        });
        let tool_result = serde_json::json!({
            "type": "message",
            "message": {"role": "toolResult", "content": [{"type": "text", "text": "секретныйпоиск"}]}
        });
        write_session(&t.0, "s1", CWD, &[user("вопрос"), thinking, tool_result]);
        assert!(search_in(&t.0, CWD, "секретныйпоиск", 30).is_empty());
        assert_eq!(search_in(&t.0, CWD, "готово", 30).len(), 1);
    }

    #[test]
    fn other_project_is_excluded() {
        let t = TempRoot::new();
        write_session(&t.0, "s1", CWD, &[user("про парсер")]);
        write_session(&t.0, "s2", OTHER_CWD, &[user("тоже про парсер")]);
        let hits = search_in(&t.0, CWD, "парсер", 30);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "s1");
        assert!(search_in(&t.0, "/nonexistent-octopus-search/none", "парсер", 30).is_empty());
    }

    #[test]
    fn one_hit_per_message_and_three_per_session() {
        let t = TempRoot::new();
        let mut lines = vec![user("парсер и снова парсер")];
        for i in 0..4 {
            lines.push(assistant(&format!("ответ {i} про парсер")));
        }
        write_session(&t.0, "s1", CWD, &lines);
        let hits = search_in(&t.0, CWD, "парсер", 30);
        assert_eq!(hits.len(), PER_SESSION);
        // The most recent three, newest first.
        assert!(hits[0].snippet.contains("ответ 3"));
        assert!(hits[2].snippet.contains("ответ 1"));
    }

    #[test]
    fn limit_is_respected() {
        let t = TempRoot::new();
        for s in 0..4 {
            let lines: Vec<Value> = (0..5).map(|i| user(&format!("парсер {i}"))).collect();
            write_session(&t.0, &format!("s{s}"), CWD, &lines);
        }
        assert_eq!(search_in(&t.0, CWD, "парсер", 30).len(), 4 * PER_SESSION);
        assert_eq!(search_in(&t.0, CWD, "парсер", 7).len(), 7);
        assert_eq!(search_in(&t.0, CWD, "парсер", 1).len(), 1);
    }

    #[test]
    fn short_or_blank_query_and_empty_cwd_give_nothing() {
        let t = TempRoot::new();
        write_session(&t.0, "s1", CWD, &[user("парсер")]);
        assert!(search_in(&t.0, CWD, "п", 30).is_empty());
        assert!(search_in(&t.0, CWD, "   ", 30).is_empty());
        assert!(search_in(&t.0, "", "парсер", 30).is_empty());
        assert_eq!(search_in(&t.0, CWD, "  пар ", 30).len(), 1);
    }

    #[test]
    fn title_comes_from_the_session_header_rules() {
        let t = TempRoot::new();
        let dir = t.0.join("enc-titled");
        fs::create_dir_all(&dir).unwrap();
        let body = format!(
            "{}\n{}\n{}\n",
            serde_json::json!({"type": "title", "title": "Разбор парсера"}),
            serde_json::json!({"type": "session", "id": "titled", "cwd": CWD}),
            user("как работает парсер"),
        );
        fs::write(dir.join("titled.jsonl"), body).unwrap();
        let hits = search_in(&t.0, CWD, "парсер", 30);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Разбор парсера");
        assert!(hits[0].at > 0);
    }

    #[test]
    fn iso_timestamps_parse_to_ms() {
        assert_eq!(parse_iso_ms("1970-01-02T00:00:00Z"), Some(86_400_000));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01.500Z"), Some(1_500));
        assert_eq!(
            parse_iso_ms("2026-10-10T16:11:34.847Z"),
            Some(1_791_648_694_847)
        );
        assert_eq!(parse_iso_ms("not a date"), None);
    }
}
