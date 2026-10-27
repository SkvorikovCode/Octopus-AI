//! What the agents are doing, in a file desktop widgets can watch:
//! `$XDG_RUNTIME_DIR/octopus/status.json`. The page sends a snapshot whenever an
//! agent's status changes; this side adds the app's pid and the time, writes it
//! atomically (a reader never sees half a file) and removes it on exit. A file
//! whose pid is gone was left by a crash. Without `XDG_RUNTIME_DIR` (macOS) nothing
//! is written. The directory is the user's own (mode 0700), and the file is 0600:
//! it carries session titles.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, RunEvent, Runtime, State};

/// Bumped when a field changes meaning; readers check it.
const FORMAT: u32 = 1;

#[derive(Default)]
pub struct StatusState {
    /// The last snapshot written, so an unchanged one is not written again.
    last: Mutex<Option<Value>>,
}

fn status_path() -> Option<PathBuf> {
    let dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty())?;
    Some(PathBuf::from(dir).join("octopus").join("status.json"))
}

/// The file's content: the page's snapshot plus who wrote it and when.
fn document(snapshot: &Value, pid: u32, now_ms: u128) -> Value {
    json!({ "format": FORMAT, "pid": pid, "updatedAt": now_ms as u64, "agents": snapshot["agents"], "counts": snapshot["counts"] })
}

/// Writes through a temporary file in the same directory and a rename.
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".status.{}.tmp", std::process::id()));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(0o600);
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
        let mut file = options.open(&tmp)?;
        file.write_all(text.as_bytes())?;
    }
    fs::rename(&tmp, path)
}

/// The page's snapshot: `{ agents: [...], counts: {...} }`.
#[tauri::command]
pub fn app_set_status(state: State<StatusState>, snapshot: Value) -> Result<(), String> {
    let Some(path) = status_path() else {
        return Ok(());
    };
    let mut last = state.last.lock().unwrap();
    if last.as_ref() == Some(&snapshot) {
        return Ok(());
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let text = document(&snapshot, std::process::id(), now).to_string();
    write_atomic(&path, &text).map_err(|e| format!("status file: {e}"))?;
    *last = Some(snapshot);
    Ok(())
}

pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if let RunEvent::Exit = event {
        if let Some(path) = status_path() {
            let _ = fs::remove_file(path);
        }
        *app.state::<StatusState>().last.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_wraps_the_snapshot() {
        let snapshot = json!({ "agents": [{ "status": "working" }], "counts": { "working": 1 }, "extra": 1 });
        let doc = document(&snapshot, 42, 1_760_000_000_000);
        assert_eq!(doc["format"], FORMAT);
        assert_eq!(doc["pid"], 42);
        assert_eq!(doc["updatedAt"], 1_760_000_000_000u64);
        assert_eq!(doc["agents"][0]["status"], "working");
        assert_eq!(doc["counts"]["working"], 1);
        assert!(doc.get("extra").is_none());
    }

    #[test]
    fn writes_whole_files_private_to_the_user() {
        let dir = std::env::temp_dir().join(format!("octopus-status-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("octopus").join("status.json");
        write_atomic(&path, "{\"a\":1}").unwrap();
        write_atomic(&path, "{\"a\":2}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        // No temporary file is left next to it.
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
