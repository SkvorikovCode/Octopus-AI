//! Token and cost statistics aggregated from saved agent sessions.
//!
//! Sessions live at `$HOME/.omp/agent/sessions/<dir>/<file>.jsonl`. Every
//! assistant message that carries a `usage` object counts as one request; its
//! tokens and cost are summed per local day, per `provider/model` and per
//! session. The `usage_stats` command returns the aggregate for the last N
//! days, optionally limited to sessions started in one project directory.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

const DAY_MS: i64 = 86_400_000;
const MAX_SESSIONS: usize = 20;
const UNTITLED: &str = "Без названия";

/// Usage for one local calendar day of the period.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    /// Local date, `YYYY-MM-DD`.
    pub date: String,
    pub tokens: u64,
    pub cost: f64,
    pub requests: u32,
}

/// Usage for one `provider/model` pair.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStat {
    /// `provider/model`, or just one of them when the other is missing.
    pub model: String,
    pub tokens: u64,
    pub input: u64,
    pub output: u64,
    pub cost: f64,
    pub requests: u32,
}

/// Usage for one session file that had requests inside the period.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStat {
    /// Absolute path of the `.jsonl` file.
    pub path: String,
    /// Last non-empty `title` line, else the session title, else a placeholder.
    pub title: String,
    /// Working directory recorded in the session header.
    pub cwd: String,
    pub tokens: u64,
    pub cost: f64,
    pub requests: u32,
    /// Timestamp of the latest counted request, epoch milliseconds.
    pub last_at: u64,
    /// Cost split by provider id (requests whose provider is unknown are left out).
    pub cost_by_provider: BTreeMap<String, f64>,
}

/// Aggregated statistics returned to the frontend.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    /// One entry per day of the period, oldest first, zeros included.
    pub days: Vec<DayStat>,
    /// Sorted by cost descending, then tokens descending.
    pub models: Vec<ModelStat>,
    /// Top sessions by cost descending, then tokens descending (max 20).
    pub sessions: Vec<SessionStat>,
    pub total_tokens: u64,
    pub total_cost: f64,
    pub total_requests: u32,
    /// Number of sessions with at least one request in the period.
    pub session_count: u32,
}

#[derive(Debug, Clone, Copy, Default)]
struct Acc {
    tokens: u64,
    cost: f64,
    requests: u32,
}

impl Acc {
    fn add(&mut self, other: &Acc) {
        self.tokens = self.tokens.saturating_add(other.tokens);
        self.cost += other.cost;
        self.requests = self.requests.saturating_add(other.requests);
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ModelAcc {
    input: u64,
    output: u64,
    acc: Acc,
}

impl ModelAcc {
    fn add(&mut self, other: &ModelAcc) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.acc.add(&other.acc);
    }
}

/// Per-file result of scanning one session.
#[derive(Clone, Default)]
struct FileAgg {
    cwd: String,
    session_title: String,
    title_line: String,
    /// First user message, the title fallback (same as the session list).
    first_user: String,
    days: HashMap<i64, Acc>,
    models: HashMap<String, ModelAcc>,
    total: Acc,
    last_ms: i64,
}

/// The period in local-day numbers (days since 1970-01-01, local time).
#[derive(Clone, Copy)]
struct Window {
    first_day: i64,
    last_day: i64,
    offset_secs: i64,
}

impl Window {
    fn new(now_ms: i64, days: u32, offset_secs: i64) -> Self {
        let last_day = local_day(now_ms, offset_secs);
        Window {
            first_day: last_day - (days as i64 - 1),
            last_day,
            offset_secs,
        }
    }

    fn contains(&self, day: i64) -> bool {
        day >= self.first_day && day <= self.last_day
    }

    /// Epoch milliseconds of local midnight that opens the period.
    fn start_ms(&self) -> i64 {
        self.first_day * DAY_MS - self.offset_secs * 1000
    }
}

/// Session files are append-only, so a file last written before the period
/// holds no request inside it. A day of slack covers clock changes; a file
/// whose time cannot be read is scanned.
fn written_since(path: &Path, since_ms: i64) -> bool {
    let Ok(modified) = fs::metadata(path).and_then(|m| m.modified()) else {
        return true;
    };
    modified
        .duration_since(UNIX_EPOCH)
        .map_or(true, |d| d.as_millis() as i64 >= since_ms)
}

/// Usage statistics for the last `days` days (clamped to 1..=365), optionally
/// restricted to sessions whose working directory is `cwd`. Scanning runs on a
/// blocking thread; a missing sessions directory yields empty statistics.
#[tauri::command]
pub async fn usage_stats(days: u32, cwd: Option<String>) -> Result<UsageStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = sessions_root().unwrap_or_default();
        collect(&root, days, cwd.as_deref(), now_ms(), local_offset_secs())
    })
    .await
    .map_err(|e| e.to_string())
}

/// Scans every `.jsonl` file one level below `root` and aggregates the requests
/// that fall into the period. Never panics; unreadable files and bad lines are
/// skipped.
fn collect(root: &Path, days: u32, cwd: Option<&str>, now_ms: i64, offset_secs: i64) -> UsageStats {
    let days = days.clamp(1, 365);
    let window = Window::new(now_ms, days, offset_secs);
    let filter = cwd
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(normalize_path);

    let mut day_totals: HashMap<i64, Acc> = HashMap::new();
    let mut model_totals: HashMap<String, ModelAcc> = HashMap::new();
    let mut sessions: Vec<SessionStat> = Vec::new();
    let mut total = Acc::default();
    let since_ms = window.start_ms() - DAY_MS;
    let mut scanned: HashSet<PathBuf> = HashSet::new();

    for path in session_files(root) {
        if !written_since(&path, since_ms) {
            continue;
        }
        scanned.insert(path.clone());
        let Some(agg) = cached_scan(&path, &window) else {
            continue;
        };
        if agg.total.requests == 0 {
            continue;
        }
        if let Some(wanted) = &filter {
            if agg.cwd.is_empty() || normalize_path(&agg.cwd) != *wanted {
                continue;
            }
        }

        total.add(&agg.total);
        for (day, acc) in &agg.days {
            day_totals.entry(*day).or_default().add(acc);
        }
        for (name, model) in &agg.models {
            model_totals.entry(name.clone()).or_default().add(model);
        }

        let title = if !agg.title_line.is_empty() {
            agg.title_line.clone()
        } else if !agg.session_title.is_empty() {
            agg.session_title.clone()
        } else if !agg.first_user.is_empty() {
            crate::sessions::short_title(&agg.first_user, crate::sessions::TITLE_PREVIEW_CHARS)
        } else {
            UNTITLED.to_string()
        };
        sessions.push(SessionStat {
            path: path.to_string_lossy().into_owned(),
            title,
            cwd: agg.cwd.clone(),
            tokens: agg.total.tokens,
            cost: agg.total.cost,
            requests: agg.total.requests,
            last_at: agg.last_ms.max(0) as u64,
            cost_by_provider: cost_by_provider(&agg.models),
        });
    }

    forget_unscanned(root, &window, &scanned);

    let day_stats = (0..days as i64)
        .map(|i| {
            let day = window.first_day + i;
            let acc = day_totals.get(&day).copied().unwrap_or_default();
            DayStat {
                date: date_string(day),
                tokens: acc.tokens,
                cost: acc.cost,
                requests: acc.requests,
            }
        })
        .collect();

    let mut models: Vec<ModelStat> = model_totals
        .into_iter()
        .map(|(model, m)| ModelStat {
            model,
            tokens: m.acc.tokens,
            input: m.input,
            output: m.output,
            cost: m.acc.cost,
            requests: m.acc.requests,
        })
        .collect();
    models.sort_by(|a, b| {
        b.cost
            .partial_cmp(&a.cost)
            .unwrap_or(Ordering::Equal)
            .then(b.tokens.cmp(&a.tokens))
            .then_with(|| a.model.cmp(&b.model))
    });

    let session_count = sessions.len() as u32;
    sessions.sort_by(|a, b| {
        b.cost
            .partial_cmp(&a.cost)
            .unwrap_or(Ordering::Equal)
            .then(b.tokens.cmp(&a.tokens))
            .then_with(|| a.path.cmp(&b.path))
    });
    sessions.truncate(MAX_SESSIONS);

    UsageStats {
        days: day_stats,
        models,
        sessions,
        total_tokens: total.tokens,
        total_cost: total.cost,
        total_requests: total.requests,
        session_count,
    }
}

/// Per-file results by period, so a repeated scan (the budget after every turn,
/// the Stats screen) reopens only files written since. Keyed by the period's
/// days and offset, then by path; valid while size and mtime stay the same.
type WindowKey = (i64, i64, i64);

struct CachedAgg {
    len: u64,
    modified: SystemTime,
    agg: FileAgg,
}

static FILE_CACHE: Mutex<Option<HashMap<WindowKey, HashMap<PathBuf, CachedAgg>>>> = Mutex::new(None);

/// Drops this period's entries under `root` that the last walk did not reach
/// (deleted files), so the cache never outgrows the sessions directory.
fn forget_unscanned(root: &Path, window: &Window, scanned: &HashSet<PathBuf>) {
    let key = (window.first_day, window.last_day, window.offset_secs);
    let mut guard = FILE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(files) = guard.as_mut().and_then(|w| w.get_mut(&key)) {
        files.retain(|p, _| !p.starts_with(root) || scanned.contains(p));
    }
}

/// `scan_file`, reusing the previous result while the file is unchanged.
fn cached_scan(path: &Path, window: &Window) -> Option<FileAgg> {
    let Some((len, modified)) = fs::metadata(path)
        .ok()
        .and_then(|m| Some((m.len(), m.modified().ok()?)))
    else {
        return scan_file(path, window);
    };
    let key = (window.first_day, window.last_day, window.offset_secs);
    let mut guard = FILE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let by_window = guard.get_or_insert_with(HashMap::new);
    // A period that ended before this one never comes back.
    by_window.retain(|k, _| k.1 >= window.last_day);
    let files = by_window.entry(key).or_default();
    if let Some(c) = files.get(path).filter(|c| c.len == len && c.modified == modified) {
        return Some(c.agg.clone());
    }
    drop(guard);
    let agg = scan_file(path, window)?;
    let mut guard = FILE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .entry(key)
        .or_default()
        .insert(path.to_path_buf(), CachedAgg { len, modified, agg: agg.clone() });
    Some(agg)
}

/// Reads one session file and counts the assistant requests inside the window.
/// Returns `None` only when the file cannot be opened.
fn scan_file(path: &Path, window: &Window) -> Option<FileAgg> {
    let mut reader = BufReader::new(File::open(path).ok()?);
    let mut agg = FileAgg::default();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = String::from_utf8_lossy(&buf);
        let Ok(line) = serde_json::from_str::<Value>(text.trim()) else {
            continue;
        };
        match line.get("type").and_then(Value::as_str) {
            Some("session") => {
                if let Some(cwd) = non_empty(&line, "cwd") {
                    agg.cwd = cwd;
                }
                if let Some(title) = non_empty(&line, "title") {
                    agg.session_title = title;
                }
            }
            Some("title") => {
                if let Some(title) = non_empty(&line, "title") {
                    agg.title_line = title;
                }
            }
            Some("message") => {
                if agg.first_user.is_empty() {
                    if let Some(text) = crate::sessions::user_text(&line) {
                        agg.first_user = text;
                    }
                }
                count_message(&line, window, &mut agg)
            }
            _ => {}
        }
    }
    Some(agg)
}

/// Adds one assistant message with a `usage` object to the aggregate, if its
/// timestamp falls inside the window.
fn count_message(line: &Value, window: &Window, agg: &mut FileAgg) {
    let Some(message) = line.get("message") else {
        return;
    };
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let Some(usage) = message.get("usage").filter(|u| u.is_object()) else {
        return;
    };
    let Some(at) = line
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_ms)
    else {
        return;
    };
    let day = local_day(at, window.offset_secs);
    if !window.contains(day) {
        return;
    }

    let input = field_u64(usage, "input").unwrap_or(0);
    let output = field_u64(usage, "output").unwrap_or(0);
    let tokens = field_u64(usage, "totalTokens").unwrap_or_else(|| {
        ["input", "output", "cacheRead", "cacheWrite"]
            .iter()
            .fold(0u64, |sum, key| {
                sum.saturating_add(field_u64(usage, key).unwrap_or(0))
            })
    });
    let cost = usage
        .get("cost")
        .and_then(|c| field_f64(c, "total"))
        .unwrap_or(0.0);

    let acc = Acc {
        tokens,
        cost,
        requests: 1,
    };
    agg.total.add(&acc);
    agg.days.entry(day).or_default().add(&acc);

    let model = agg.models.entry(model_key(message)).or_default();
    model.input = model.input.saturating_add(input);
    model.output = model.output.saturating_add(output);
    model.acc.add(&acc);

    agg.last_ms = agg.last_ms.max(at);
}

/// Lists `<root>/<dir>/*.jsonl`, sorted for deterministic output.
fn session_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(dirs) = fs::read_dir(root) else {
        return out;
    };
    for entry in dirs.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let is_jsonl = path.extension().and_then(|e| e.to_str()) == Some("jsonl");
            if is_jsonl && path.is_file() {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// Canonical form of a directory path for comparison. Falls back to the raw
/// path without trailing slashes (mapping `/tmp` to `/private/tmp`, as macOS
/// does) when the path does not exist.
fn normalize_path(raw: &str) -> String {
    if let Ok(canon) = fs::canonicalize(raw) {
        return canon.to_string_lossy().into_owned();
    }
    let trimmed = raw.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_string();
    }
    if trimmed == "/tmp" || trimmed.starts_with("/tmp/") {
        return format!("/private{trimmed}");
    }
    trimmed.to_string()
}

/// Sums model costs per provider. Keys are `provider/model` (see `model_key`);
/// a key without a slash names only one of them, so it can't be attributed.
fn cost_by_provider(models: &HashMap<String, ModelAcc>) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for (key, m) in models {
        if let Some((provider, _)) = key.split_once('/') {
            *out.entry(provider.to_string()).or_insert(0.0) += m.acc.cost;
        }
    }
    out
}

fn model_key(message: &Value) -> String {
    let provider = str_field(message, "provider");
    let model = str_field(message, "model");
    match (provider.is_empty(), model.is_empty()) {
        (false, false) => format!("{provider}/{model}"),
        (true, false) => model.to_string(),
        (false, true) => provider.to_string(),
        (true, true) => "unknown".to_string(),
    }
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
}

fn non_empty(value: &Value, key: &str) -> Option<String> {
    let s = str_field(value, key);
    (!s.is_empty()).then(|| s.to_string())
}

fn field_u64(value: &Value, key: &str) -> Option<u64> {
    let field = value.get(key)?;
    field
        .as_u64()
        .or_else(|| field.as_f64().filter(|x| x.is_finite() && *x >= 0.0).map(|x| x as u64))
}

fn field_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64().filter(|x| x.is_finite())
}

fn sessions_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(
        PathBuf::from(home)
            .join(".omp")
            .join("agent")
            .join("sessions"),
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Local UTC offset in seconds, read once from `date +%z`. Falls back to UTC.
fn local_offset_secs() -> i64 {
    std::process::Command::new("date")
        .arg("+%z")
        .output()
        .ok()
        .and_then(|out| parse_offset_secs(String::from_utf8_lossy(&out.stdout).trim()))
        .unwrap_or(0)
}

/// Parses `±HHMM` into seconds east of UTC.
fn parse_offset_secs(raw: &str) -> Option<i64> {
    let sign: i64 = match raw.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let body = raw.get(1..)?;
    if body.len() != 4 {
        return None;
    }
    let hours = digits(body.get(..2)?)?;
    let minutes = digits(body.get(2..)?)?;
    Some(sign * (hours * 3600 + minutes * 60))
}

fn digits(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Local day number for an epoch-millisecond instant at the given UTC offset.
fn local_day(ms: i64, offset_secs: i64) -> i64 {
    (ms + offset_secs * 1000).div_euclid(DAY_MS)
}

/// `YYYY-MM-DD` for a day number (days since 1970-01-01).
fn date_string(day: i64) -> String {
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM|±HHMM)` into epoch
/// milliseconds. Fractions of any length are truncated to milliseconds; a
/// missing zone is treated as UTC. Returns `None` on anything malformed.
fn parse_iso_ms(raw: &str) -> Option<i64> {
    let s = raw.trim();
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year = digits(s.get(0..4)?)?;
    let month = digits(s.get(5..7)?)?;
    let day = digits(s.get(8..10)?)?;
    let hour = digits(s.get(11..13)?)?;
    let minute = digits(s.get(14..16)?)?;
    let second = digits(s.get(17..19)?)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    let mut rest = s.get(19..)?;
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let end = frac
            .bytes()
            .position(|c| !c.is_ascii_digit())
            .unwrap_or(frac.len());
        let digit_run = frac.get(..end)?;
        if digit_run.is_empty() {
            return None;
        }
        let mut three: String = digit_run.chars().take(3).collect();
        while three.len() < 3 {
            three.push('0');
        }
        millis = digits(&three)?;
        rest = frac.get(end..)?;
    }

    let offset_ms: i64 = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign: i64 = match rest.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let body = rest.get(1..)?;
            let (hh, mm) = match body.len() {
                5 if body.as_bytes()[2] == b':' => (body.get(..2)?, body.get(3..5)?),
                4 => (body.get(..2)?, body.get(2..4)?),
                _ => return None,
            };
            sign * (digits(hh)? * 3_600_000 + digits(mm)? * 60_000)
        }
    };

    let days = days_from_civil(year, month as u32, day as u32);
    let local_ms = days * DAY_MS + (hour * 3600 + minute * 60 + second) * 1000 + millis;
    Some(local_ms - offset_ms)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month as i64 + 9) % 12; // March = 0
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of [`days_from_civil`]: `(year, month, day)` for a day number.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-10T12:00:00Z";

    const SESSION_A: &str = r#"{"type":"session","version":3,"id":"a","timestamp":"2026-10-09T08:00:00.000Z","cwd":"/work/a","title":"Alpha"}
{"type":"message","id":"1","timestamp":"2026-10-09T09:00:00.000Z","message":{"role":"assistant","provider":"wikivibe","model":"gpt-6-luna","usage":{"input":40,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":50,"cost":{"input":0.15,"output":0.05,"cacheRead":0,"cacheWrite":0,"total":0.2}},"stopReason":"stop"}}
this line is not json
{"type":"message","id":"2","timestamp":"2026-10-10T10:00:00.000Z","message":{"role":"user","content":"hi"}}
{"type":"message","id":"3","timestamp":"2026-10-10T10:00:01.000Z","message":{"role":"assistant","provider":"wikivibe","model":"gpt-6-luna","usage":{"input":90,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":100,"cost":{"total":0.5}}}}
{"type":"message","id":"4","timestamp":"2026-10-10T10:05:00.000Z","message":{"role":"assistant","provider":"wikivibe","model":"gpt-6-luna","usage":{}}}
{"type":"message","id":"5","timestamp":"2026-10-10T10:06:00.000Z","message":{"role":"assistant","provider":"wikivibe","model":"gpt-6-luna","content":"no usage object"}}
{"type":"message","id":"6","timestamp":"2026-08-01T10:00:00.000Z","message":{"role":"assistant","provider":"wikivibe","model":"gpt-6-luna","usage":{"totalTokens":999,"cost":{"total":9}}}}
{"type":"title","v":1,"title":"Промежуточное"}
{"type":"title","v":1,"title":"Новое имя"}
{"type":"title","v":1,"title":""}
"#;

    const SESSION_B: &str = r#"{"type":"session","version":3,"id":"b","timestamp":"2026-10-10T11:00:00.000Z","cwd":"/work/b","title":"Beta"}
{"type":"message","id":"7","timestamp":"2026-10-10T11:00:00.000Z","message":{"role":"assistant","provider":"openai","model":"x-1","usage":{"input":10,"output":5,"cacheRead":1,"cacheWrite":2,"cost":{"total":0}}}}
"#;

    const SESSION_C: &str = r#"{"type":"session","version":3,"id":"c","timestamp":"2026-08-01T10:00:00.000Z","cwd":"/work/c"}
{"type":"message","id":"8","timestamp":"2026-08-01T10:00:00.000Z","message":{"role":"assistant","provider":"openai","model":"x-1","usage":{"totalTokens":500,"cost":{"total":3}}}}
"#;

    /// A loose file directly under the sessions root must be ignored.
    const LOOSE: &str = r#"{"type":"session","cwd":"/work/a","title":"Loose"}
{"type":"message","timestamp":"2026-10-10T10:00:00.000Z","message":{"role":"assistant","provider":"wikivibe","model":"gpt-6-luna","usage":{"totalTokens":9999,"cost":{"total":9}}}}
"#;

    fn ms(s: &str) -> i64 {
        parse_iso_ms(s).expect("valid ISO timestamp")
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "octopus-stats-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("proj-a")).unwrap();
        fs::create_dir_all(root.join("proj-b")).unwrap();
        fs::write(root.join("proj-a").join("s1.jsonl"), SESSION_A).unwrap();
        fs::write(root.join("proj-b").join("s2.jsonl"), SESSION_B).unwrap();
        fs::write(root.join("proj-b").join("s3.jsonl"), SESSION_C).unwrap();
        fs::write(root.join("loose.jsonl"), LOOSE).unwrap();
        root
    }

    #[test]
    fn splits_session_cost_by_provider() {
        let mut models = HashMap::new();
        let mut acc = |key: &str, cost: f64| {
            let mut m = ModelAcc::default();
            m.acc.cost = cost;
            models.insert(key.to_string(), m);
        };
        acc("openai-codex/gpt-5.6-terra", 0.4);
        acc("openai-codex/gpt-6-luna", 0.1);
        acc("openrouter/anthropic/claude-sonnet", 0.3);
        acc("gpt-6-luna", 9.0);
        let split = cost_by_provider(&models);
        assert_eq!(split.len(), 2);
        assert!(approx(split["openai-codex"], 0.5));
        assert!(approx(split["openrouter"], 0.3));
    }

    #[test]
    fn parses_iso_timestamps() {
        let base = days_from_civil(2026, 10, 10) * DAY_MS + (15 * 3600 + 21 * 60 + 37) * 1000;
        assert_eq!(parse_iso_ms("2026-10-10T15:21:37.112Z"), Some(base + 112));
        assert_eq!(parse_iso_ms("2026-10-10T15:21:37Z"), Some(base));
        assert_eq!(parse_iso_ms("2026-10-10T15:21:37.5Z"), Some(base + 500));
        assert_eq!(parse_iso_ms("2026-10-10T15:21:37.123456Z"), Some(base + 123));
        assert_eq!(parse_iso_ms("2026-10-10T17:21:37.112+02:00"), Some(base + 112));
        assert_eq!(parse_iso_ms("2026-10-10T15:21:37.112"), Some(base + 112));
        assert_eq!(parse_iso_ms("not a date"), None);
        assert_eq!(parse_iso_ms("2026-10-10T15:21:37.Z"), None);
        assert_eq!(parse_iso_ms("2026-13-10T15:21:37Z"), None);
        assert_eq!(parse_iso_ms("2026-10-10T15:21:37жZ"), None);
        assert_eq!(parse_iso_ms(""), None);
    }

    #[test]
    fn days_from_civil_handles_month_and_year_boundaries() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 1, 1), 20_454);
        assert_eq!(days_from_civil(2026, 1, 1) - days_from_civil(2025, 12, 31), 1);
        assert_eq!(days_from_civil(2024, 3, 1) - days_from_civil(2024, 2, 28), 2); // leap year
        assert_eq!(days_from_civil(2026, 3, 1) - days_from_civil(2026, 2, 28), 1);
        assert_eq!(days_from_civil(2100, 3, 1) - days_from_civil(2100, 2, 28), 1); // not leap
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        for z in [-1000, -1, 0, 1, 20_453, 20_454, 30_000] {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
        assert_eq!(date_string(days_from_civil(2026, 10, 10)), "2026-10-10");
        assert_eq!(date_string(days_from_civil(2026, 12, 31) + 1), "2027-01-01");
        assert_eq!(date_string(days_from_civil(2024, 2, 28) + 1), "2024-02-29");
    }

    #[test]
    fn local_day_and_offset_parsing() {
        let t = ms("2026-10-10T20:30:00Z");
        assert_eq!(date_string(local_day(t, 0)), "2026-10-10");
        assert_eq!(date_string(local_day(t, 7 * 3600)), "2026-10-11");
        assert_eq!(date_string(local_day(t, -5 * 3600)), "2026-10-10");
        assert_eq!(parse_offset_secs("+0700"), Some(25_200));
        assert_eq!(parse_offset_secs("-0330"), Some(-12_600));
        assert_eq!(parse_offset_secs("garbage"), None);
        assert_eq!(parse_offset_secs("+07"), None);
    }

    #[test]
    fn aggregates_two_sessions_over_three_days() {
        let root = fixture("agg");
        let stats = collect(&root, 3, None, ms(NOW), 0);

        assert_eq!(stats.days.len(), 3);
        assert_eq!(stats.days[0].date, "2026-10-08");
        assert_eq!(stats.days[0].tokens, 0);
        assert_eq!(stats.days[1].date, "2026-10-09");
        assert_eq!(stats.days[1].tokens, 50);
        assert!(approx(stats.days[1].cost, 0.2));
        assert_eq!(stats.days[1].requests, 1);
        assert_eq!(stats.days[2].date, "2026-10-10");
        assert_eq!(stats.days[2].tokens, 118);
        assert!(approx(stats.days[2].cost, 0.5));
        assert_eq!(stats.days[2].requests, 3);

        assert_eq!(stats.total_tokens, 168);
        assert_eq!(stats.total_requests, 4);
        assert!(approx(stats.total_cost, 0.7));
        assert_eq!(stats.session_count, 2);

        assert_eq!(stats.models.len(), 2);
        let m0 = &stats.models[0];
        assert_eq!(m0.model, "wikivibe/gpt-6-luna");
        assert_eq!(m0.tokens, 150);
        assert_eq!(m0.input, 130);
        assert_eq!(m0.output, 20);
        assert_eq!(m0.requests, 3);
        assert!(approx(m0.cost, 0.7));
        let m1 = &stats.models[1];
        assert_eq!(m1.model, "openai/x-1");
        assert_eq!(m1.tokens, 18);
        assert_eq!(m1.input, 10);
        assert_eq!(m1.output, 5);
        assert_eq!(m1.requests, 1);

        assert_eq!(stats.sessions.len(), 2);
        let s0 = &stats.sessions[0];
        assert!(s0.path.ends_with("s1.jsonl"));
        assert_eq!(s0.title, "Новое имя");
        assert_eq!(s0.cost_by_provider.len(), 1);
        assert!(approx(s0.cost_by_provider["wikivibe"], 0.7));
        assert_eq!(s0.cwd, "/work/a");
        assert_eq!(s0.tokens, 150);
        assert_eq!(s0.requests, 3);
        assert_eq!(s0.last_at, ms("2026-10-10T10:05:00.000Z") as u64);
        let s1 = &stats.sessions[1];
        assert_eq!(s1.title, "Beta");
        assert_eq!(s1.tokens, 18);
        assert_eq!(s1.requests, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn period_excludes_older_days_and_loose_files() {
        let root = fixture("period");
        let stats = collect(&root, 1, None, ms(NOW), 0);
        assert_eq!(stats.days.len(), 1);
        assert_eq!(stats.days[0].date, "2026-10-10");
        assert_eq!(stats.total_tokens, 118);
        assert_eq!(stats.total_requests, 3);
        assert_eq!(stats.session_count, 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn files_last_written_before_the_period_are_not_read() {
        let root = fixture("mtime");
        let now = ms(NOW);
        let written_at = |rel: &str, at: i64| {
            let file = File::options().write(true).open(root.join(rel)).unwrap();
            file.set_modified(UNIX_EPOCH + std::time::Duration::from_millis(at as u64))
                .unwrap();
        };
        // The period (one day) starts at 2026-10-10 00:00. Alpha holds requests from
        // that day, but its mtime says it was last written three days earlier, so the
        // scan never opens it. Beta was written within the day of slack and is read.
        written_at("proj-a/s1.jsonl", now - 3 * DAY_MS);
        written_at("proj-b/s2.jsonl", now - DAY_MS - 3_600_000);

        let stats = collect(&root, 1, None, now, 0);
        let titles: Vec<&str> = stats.sessions.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, ["Beta"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unchanged_files_are_not_read_again() {
        let root = fixture("cache");
        let now = ms(NOW);
        let path = root.join("proj-b").join("s2.jsonl");
        let first = collect(&root, 3, None, now, 0);

        // Same size and mtime, different bytes: the previous result stands.
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let swapped = SESSION_B.replace("\"input\":10", "\"input\":90");
        assert_eq!(swapped.len(), SESSION_B.len());
        fs::write(&path, &swapped).unwrap();
        File::options().write(true).open(&path).unwrap().set_modified(modified).unwrap();
        assert_eq!(collect(&root, 3, None, now, 0).total_tokens, first.total_tokens);

        // A write that changes the size is read again.
        fs::write(&path, format!("{swapped}\n")).unwrap();
        assert_eq!(collect(&root, 3, None, now, 0).total_tokens, first.total_tokens + 80);

        // A deleted file leaves both the result and the cache.
        fs::remove_file(&path).unwrap();
        let after = collect(&root, 3, None, now, 0);
        assert!(after.sessions.iter().all(|s| s.title != "Beta"));
        let cached = FILE_CACHE.lock().unwrap();
        assert!(cached.as_ref().unwrap().values().all(|files| !files.contains_key(&path)));
        drop(cached);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cwd_filter_limits_sessions() {
        let root = fixture("cwd");
        let stats = collect(&root, 3, Some("/work/b/"), ms(NOW), 0);
        assert_eq!(stats.session_count, 1);
        assert_eq!(stats.total_tokens, 18);
        assert_eq!(stats.sessions.len(), 1);
        assert_eq!(stats.sessions[0].title, "Beta");
        assert_eq!(stats.models.len(), 1);

        // A session with no requests in the period is never listed.
        let empty = collect(&root, 3, Some("/work/c"), ms(NOW), 0);
        assert_eq!(empty.session_count, 0);
        assert_eq!(empty.total_requests, 0);
        assert!(empty.sessions.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clamps_days_and_handles_missing_root() {
        let root = fixture("clamp");
        assert_eq!(collect(&root, 0, None, ms(NOW), 0).days.len(), 1);
        assert_eq!(collect(&root, 1000, None, ms(NOW), 0).days.len(), 365);
        let _ = fs::remove_dir_all(&root);

        let missing = collect(Path::new("/nonexistent-octopus-stats-root"), 7, None, ms(NOW), 0);
        assert_eq!(missing.days.len(), 7);
        assert_eq!(missing.total_requests, 0);
        assert!(missing.sessions.is_empty());
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

    fn print_summary(label: &str, s: &UsageStats, ms: u128) {
        println!(
            "{label}: {ms} ms, requests={} tokens={} cost={:.6} sessions={} (listed {}) days={} models={}",
            s.total_requests,
            s.total_tokens,
            s.total_cost,
            s.session_count,
            s.sessions.len(),
            s.days.len(),
            s.models.len()
        );
        for m in s.models.iter().take(3) {
            println!(
                "[stats]   model={} requests={} tokens={} input={} output={} cost={:.6}",
                m.model, m.requests, m.tokens, m.input, m.output, m.cost
            );
        }
        for x in s.sessions.iter().take(3) {
            println!(
                "[stats]   session title={:?} cwd={} requests={} tokens={} cost={:.6} last_at={}",
                x.title, x.cwd, x.requests, x.tokens, x.cost, x.last_at
            );
        }
    }

    #[test]
    #[ignore] // reads the developer's real ~/.omp data; run with --ignored
    fn smoke() {
        let t = Instant::now();
        let all = tauri::async_runtime::block_on(usage_stats(30, None))
            .expect("usage_stats(30, None) returns Ok");
        print_summary("[stats] usage_stats(30, None)", &all, t.elapsed().as_millis());

        assert_eq!(all.days.len(), 30);
        assert!(all.sessions.len() <= MAX_SESSIONS);
        assert!(all.session_count as usize >= all.sessions.len());
        assert!(all.total_cost.is_finite() && all.total_cost >= 0.0);
        let day_tokens: u64 = all.days.iter().map(|d| d.tokens).sum();
        let day_requests: u32 = all.days.iter().map(|d| d.requests).sum();
        let day_cost: f64 = all.days.iter().map(|d| d.cost).sum();
        let model_tokens: u64 = all.models.iter().map(|m| m.tokens).sum();
        assert_eq!(day_tokens, all.total_tokens);
        assert_eq!(day_requests, all.total_requests);
        assert!((day_cost - all.total_cost).abs() < 1e-6);
        assert_eq!(model_tokens, all.total_tokens);
        if all.total_requests > 0 && all.total_tokens == 0 {
            println!("[stats] WARN: requests exist but total tokens is 0");
        }
        for x in &all.sessions {
            if x.tokens == 0 {
                println!("[stats] WARN: session with zero tokens: {:?} ({})", x.title, x.path);
            }
            if x.title == UNTITLED {
                println!("[stats] WARN: session with placeholder title: {}", x.path);
            }
        }

        // Filtered by the cwd of the top session.
        if let Some(first) = all.sessions.first() {
            let want = first.cwd.clone();
            let t = Instant::now();
            let filtered = tauri::async_runtime::block_on(usage_stats(30, Some(want.clone())))
                .expect("usage_stats(30, Some(cwd)) returns Ok");
            print_summary(
                &format!("[stats] usage_stats(30, Some({want}))"),
                &filtered,
                t.elapsed().as_millis(),
            );
            assert!(filtered.total_tokens <= all.total_tokens);
            assert!(filtered.total_requests <= all.total_requests);
            let wanted = normalize_path(&want);
            assert!(filtered.sessions.iter().all(|s| normalize_path(&s.cwd) == wanted));
        }

        // Octopus-AI itself: no recorded requests expected, but the call must succeed.
        let octo = home_path("Documents/GitHub/Octopus-AI");
        let t = Instant::now();
        let octo_stats = tauri::async_runtime::block_on(usage_stats(30, Some(octo)))
            .expect("usage_stats(30, Some(Octopus-AI)) returns Ok");
        print_summary(
            "[stats] usage_stats(30, Some(Octopus-AI))",
            &octo_stats,
            t.elapsed().as_millis(),
        );
        assert!(octo_stats.total_requests <= all.total_requests);
    }
}
