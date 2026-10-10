//! omp (oh-my-pi) as a child process speaking its RPC protocol over stdio.
//!
//! Rust only owns the process: spawn, write command lines to stdin, read
//! NDJSON frames from stdout, reassemble protocol-v2 `rpc_chunk` sequences and
//! forward every frame to the webview. Protocol logic lives in the frontend.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{keys, providers};

/// Matches omp's advertised `maxReassembledFrameBytes`.
const MAX_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;

/// Upper bound on agents running at once (one per parallel session).
const MAX_PROCS: usize = 6;

struct Proc {
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
    /// Random id of the webview page that started it: after a reload the old
    /// page's processes are orphans and get stopped on the next start.
    page: String,
}

/// One agent process per running session, keyed by the generation the
/// frontend assigned when starting it.
#[derive(Default)]
pub struct OmpState {
    procs: Mutex<HashMap<u64, Proc>>,
}

impl OmpState {
    pub fn shutdown(&self) {
        for (_, p) in self.procs.lock().unwrap().drain() {
            stop_proc(p);
        }
    }
}

// Every payload carries the generation the frontend assigned at start, so
// late frames from a process that is being replaced are easy to drop.
#[derive(Clone, Serialize)]
struct FramePayload {
    generation: u64,
    frame: Value,
}

#[derive(Clone, Serialize)]
struct LinePayload {
    generation: u64,
    line: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    generation: u64,
    code: Option<i32>,
}

fn stop_proc(mut p: Proc) {
    // Closing stdin asks omp to drain accepted commands and exit with 0.
    drop(p.stdin.take());
    let child = p.child;
    thread::spawn(move || {
        for _ in 0..30 {
            if let Ok(Some(_)) = child.lock().unwrap().try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = child.lock().unwrap().kill();
    });
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// PATH from the user's login shell. Apps started from Finder get a minimal
/// PATH, and omp's bash tool needs the user's real one (git, node, cargo...).
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
            .filter(|p| !p.trim().is_empty());
        from_shell.unwrap_or_else(|| {
            let h = home();
            format!(
                "/opt/homebrew/bin:/usr/local/bin:{h}/.bun/bin:{h}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            )
        })
    })
}

fn locate_omp() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OMP_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let found = shell_path()
        .split(':')
        .map(|dir| PathBuf::from(dir).join("omp"))
        .find(|p| p.is_file());
    if found.is_some() {
        return found;
    }
    let h = home();
    [format!("{h}/.omp/bin/omp"), format!("{h}/.bun/bin/omp")]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

#[tauri::command]
pub fn omp_locate() -> Option<String> {
    locate_omp().map(|p| p.display().to_string())
}

/// Extra instructions for the desktop UI: the app shows each tool call's
/// intent as the step title, so it should read in the user's language.
fn ui_prompt(lang: Option<&str>) -> String {
    let fallback = if lang == Some("ru") { "Russian" } else { "English" };
    format!(
        "You are running inside Octopus, a desktop app that shows the short intent of each tool call to the user as a step title. \
         Write these intents in the language the user writes in; if unclear, use {fallback}. Keep them short."
    )
}

#[tauri::command]
pub fn omp_start(
    app: AppHandle,
    state: State<OmpState>,
    cwd: String,
    generation: u64,
    approval_mode: Option<String>,
    lang: Option<String>,
    page: String,
) -> Result<(), String> {
    {
        let mut procs = state.procs.lock().unwrap();
        let stale: Vec<u64> = procs.iter().filter(|(g, p)| p.page != page || **g == generation).map(|(g, _)| *g).collect();
        for g in stale {
            if let Some(p) = procs.remove(&g) {
                stop_proc(p);
            }
        }
        if procs.len() >= MAX_PROCS {
            return Err("Слишком много агентов работает одновременно".into());
        }
    }

    let bin = locate_omp().ok_or("Движок агента не найден")?;
    let mode = approval_mode.unwrap_or_else(|| "write".into());

    let mut cmd = Command::new(&bin);
    cmd.args(["--mode", "rpc-ui", "--approval-mode", &mode])
        .args(["--append-system-prompt", &ui_prompt(lang.as_deref())])
        .current_dir(&cwd)
        .env("PATH", shell_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in keys::env_pairs() {
        cmd.env(name, value);
    }
    // Custom providers reference their keys as OCTOPUS_KEY_* in models.yml.
    for (name, value) in providers::env_pairs() {
        cmd.env(name, value);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Не удалось запустить движок агента: {e}"))?;
    let stdin = child.stdin.take().ok_or("нет stdin у движка")?;
    let stdout = child.stdout.take().ok_or("нет stdout у движка")?;
    let stderr = child.stderr.take().ok_or("нет stderr у движка")?;
    let child = Arc::new(Mutex::new(child));

    {
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let _ = app.emit("omp-stderr", LinePayload { generation, line });
            }
        });
    }

    {
        let app = app.clone();
        let child = child.clone();
        thread::spawn(move || {
            read_frames(&app, generation, stdout);
            // stdout closed: the process is exiting, report its code.
            let code = loop {
                match child.lock().unwrap().try_wait() {
                    Ok(Some(status)) => break status.code(),
                    Ok(None) => {}
                    Err(_) => break None,
                }
                thread::sleep(Duration::from_millis(50));
            };
            // Forget it so it no longer counts toward MAX_PROCS.
            app.state::<OmpState>().procs.lock().unwrap().remove(&generation);
            let _ = app.emit("omp-exit", ExitPayload { generation, code });
        });
    }

    state.procs.lock().unwrap().insert(
        generation,
        Proc {
            child,
            stdin: Some(stdin),
            page,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn omp_send(state: State<OmpState>, generation: u64, frame: Value) -> Result<(), String> {
    let mut procs = state.procs.lock().unwrap();
    let p = procs.get_mut(&generation).ok_or("агент не запущен")?;
    let stdin = p.stdin.as_mut().ok_or("агент останавливается")?;
    let mut line = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Запись в движок: {e}"))
}

/// Stops the process of `generation` only (a stale stop can never kill a
/// process started after it); without a generation stops every agent.
#[tauri::command]
pub fn omp_stop(state: State<OmpState>, generation: Option<u64>) {
    match generation {
        Some(g) => {
            if let Some(p) = state.procs.lock().unwrap().remove(&g) {
                stop_proc(p);
            }
        }
        None => state.shutdown(),
    }
}

struct Chunks {
    id: String,
    count: u64,
    byte_length: u64,
    next: u64,
    buf: Vec<u8>,
}

fn read_frames(app: &AppHandle, generation: u64, stdout: impl std::io::Read) {
    let emit = |frame: Value| {
        let _ = app.emit("omp-frame", FramePayload { generation, frame });
    };
    let mut pending: Option<Chunks> = None;

    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let frame: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                // stdout is protocol-only; anything else is worth seeing.
                let _ = app.emit("omp-stderr", LinePayload { generation, line });
                continue;
            }
        };

        if frame["type"] == "rpc_chunk" {
            match reassemble(&mut pending, &frame) {
                Ok(Some(full)) => emit(full),
                Ok(None) => {}
                Err(error) => {
                    pending = None;
                    emit(json!({ "type": "rpc_frame_error", "error": error }));
                }
            }
            continue;
        }
        if pending.take().is_some() {
            emit(json!({ "type": "rpc_frame_error", "error": "chunk sequence interrupted" }));
        }
        emit(frame);
    }
}

fn reassemble(pending: &mut Option<Chunks>, f: &Value) -> Result<Option<Value>, String> {
    let id = f["chunkId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("rpc_chunk: bad chunkId")?;
    let index = f["index"].as_u64().ok_or("rpc_chunk: bad index")?;
    let count = f["count"].as_u64().ok_or("rpc_chunk: bad count")?;
    let byte_length = f["byteLength"].as_u64().ok_or("rpc_chunk: bad byteLength")?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(f["data"].as_str().ok_or("rpc_chunk: bad data")?)
        .map_err(|e| format!("rpc_chunk: {e}"))?;

    if index == 0 {
        *pending = Some(Chunks {
            id: id.to_owned(),
            count,
            byte_length,
            next: 0,
            buf: Vec::new(),
        });
    }
    let c = pending.as_mut().ok_or("rpc_chunk: sequence without start")?;
    if c.id != id || c.count != count || c.byte_length != byte_length || c.next != index {
        return Err("rpc_chunk: sequence mismatch".into());
    }
    c.buf.extend_from_slice(&data);
    c.next += 1;
    if c.buf.len() > MAX_REASSEMBLED_BYTES {
        return Err("rpc_chunk: frame too large".into());
    }
    if c.next < c.count {
        return Ok(None);
    }

    let c = pending.take().expect("checked above");
    if c.buf.len() as u64 != c.byte_length {
        return Err("rpc_chunk: length mismatch".into());
    }
    let text = String::from_utf8(c.buf).map_err(|_| "rpc_chunk: invalid utf-8")?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("rpc_chunk: {e}"))
}
