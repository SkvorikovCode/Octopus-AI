//! Interactive terminals for the bottom panel of a session.
//!
//! Each terminal is a PTY running the user's login shell. A reader thread per
//! terminal streams its output to the webview as `pty-data` events and reports
//! the end of the process as `pty-exit`. Bytes in, text out: no protocol here.

use std::collections::HashMap;
use std::env;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};

const DEFAULT_SHELL: &str = "/bin/zsh";
const DEFAULT_LANG: &str = "en_US.UTF-8";
const READ_BUF: usize = 8192;

type Writer = Arc<Mutex<Box<dyn Write + Send>>>;

struct Session {
    writer: Writer,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// All open terminals, keyed by the id handed to the webview.
#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

impl PtyState {
    /// Kills every terminal. Called when the window closes.
    pub fn shutdown(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        for (_, session) in sessions {
            close_session(session);
        }
    }
}

/// Where a terminal's output goes. The app emits Tauri events; tests collect.
pub trait PtyEvents: Send + Sync + 'static {
    fn data(&self, id: u32, text: &str);
    fn exit(&self, id: u32, code: Option<u32>);
}

#[derive(Clone, Serialize)]
struct DataEvent<'a> {
    id: u32,
    data: &'a str,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: u32,
    code: Option<u32>,
}

impl<R: Runtime> PtyEvents for AppHandle<R> {
    fn data(&self, id: u32, text: &str) {
        let _ = self.emit("pty-data", DataEvent { id, data: text });
    }

    fn exit(&self, id: u32, code: Option<u32>) {
        let _ = self.emit("pty-exit", ExitEvent { id, code });
    }
}

/// Decodes `chunk`, appended to the bytes left over from the previous read.
/// An incomplete UTF-8 sequence at the end stays in `carry` until the next
/// chunk completes it; bytes that can never be valid become U+FFFD.
pub fn decode_chunk(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    let mut buf = std::mem::take(carry);
    buf.extend_from_slice(chunk);
    let mut out = String::new();
    let mut rest: &[u8] = &buf;
    loop {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                out.push_str(text);
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // `valid_up_to` marks a prefix that is valid UTF-8 by definition.
                out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or(""));
                match e.error_len() {
                    Some(len) => {
                        out.push('\u{FFFD}');
                        rest = &rest[valid + len..];
                    }
                    None => {
                        carry.extend_from_slice(&rest[valid..]);
                        break;
                    }
                }
            }
        }
    }
    out
}

/// Reads until EOF or until the terminal is gone, forwarding decoded text.
fn pump<R: Read, E: PtyEvents>(id: u32, mut reader: R, events: &E) {
    let mut buf = [0u8; READ_BUF];
    let mut carry = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let text = decode_chunk(&mut carry, &buf[..n]);
                if !text.is_empty() {
                    events.data(id, &text);
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            // EIO on macOS once the child has closed the terminal.
            Err(_) => break,
        }
    }
    if !carry.is_empty() {
        events.data(id, &String::from_utf8_lossy(&carry));
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(1),
        rows: rows.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Runs `cmd` on a new PTY and streams its output to `events` from a thread
/// that also reaps the child and reports its exit.
fn spawn<E: PtyEvents>(id: u32, cmd: CommandBuilder, size: PtySize, events: Arc<E>) -> Result<Session, String> {
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("Не удалось открыть терминал: {e}"))?;
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Не удалось запустить оболочку: {e}"))?;
    // The child holds the slave now. Dropping ours lets the reader see EOF
    // when the child exits.
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Не удалось открыть терминал: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Не удалось открыть терминал: {e}"))?;
    let killer = child.clone_killer();
    thread::spawn(move || {
        pump(id, reader, &*events);
        let code = child.wait().ok().map(|status| status.exit_code());
        events.exit(id, code);
    });
    Ok(Session {
        writer: Arc::new(Mutex::new(writer)),
        master: pair.master,
        killer,
    })
}

/// Kills the child and releases the PTY. The reader thread ends on its own.
fn close_session(mut session: Session) {
    let _ = session.killer.kill();
    drop(session.writer);
    drop(session.master);
}

/// `$SHELL`, or zsh when it is unset or empty.
fn shell_path(env_shell: Option<String>) -> String {
    env_shell
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SHELL.to_string())
}

/// `$LANG`, or UTF-8 English when it is unset (apps started from Finder have none).
fn lang_value(env_lang: Option<String>) -> String {
    env_lang
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_LANG.to_string())
}

/// Login shell (`-l`) in `cwd` with terminal-friendly environment.
fn login_shell_command(cwd: &Path) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell_path(env::var("SHELL").ok()));
    cmd.arg("-l");
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", lang_value(env::var("LANG").ok()));
    cmd
}

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let dir = Path::new(&cwd);
    if !dir.is_dir() {
        return Err(format!("Папка не найдена: {cwd}"));
    }
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let session = spawn(id, login_shell_command(dir), pty_size(cols, rows), Arc::new(app))?;
    state.sessions.lock().unwrap().insert(id, session);
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let writer = state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| s.writer.clone())
        .ok_or_else(|| "Терминал не найден".to_string())?;
    let mut w = writer.lock().unwrap();
    w.write_all(data.as_bytes())
        .and_then(|()| w.flush())
        .map_err(|e| format!("Не удалось записать в терминал: {e}"))
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or_else(|| "Терминал не найден".to_string())?;
    session
        .master
        .resize(pty_size(cols, rows))
        .map_err(|e| format!("Не удалось изменить размер терминала: {e}"))
}

/// Closing an unknown id is not an error: the tab may already be gone.
#[tauri::command]
pub fn pty_close(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let session = state.sessions.lock().unwrap().remove(&id);
    if let Some(session) = session {
        close_session(session);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::time::Duration;

    #[derive(Debug, PartialEq)]
    enum Event {
        Data(String),
        Exit(Option<u32>),
    }

    struct Collect {
        tx: Mutex<Sender<Event>>,
    }

    impl PtyEvents for Collect {
        fn data(&self, _id: u32, text: &str) {
            let _ = self.tx.lock().unwrap().send(Event::Data(text.to_string()));
        }

        fn exit(&self, _id: u32, code: Option<u32>) {
            let _ = self.tx.lock().unwrap().send(Event::Exit(code));
        }
    }

    fn collector() -> (Arc<Collect>, Receiver<Event>) {
        let (tx, rx) = channel();
        (Arc::new(Collect { tx: Mutex::new(tx) }), rx)
    }

    /// Collects output until the exit event; returns (text, exit code).
    fn drain_until_exit(rx: &Receiver<Event>) -> (String, Option<u32>) {
        let mut text = String::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).expect("terminal did not exit") {
                Event::Data(d) => text.push_str(&d),
                Event::Exit(code) => return (text, code),
            }
        }
    }

    fn decode_split(text: &str, cut: usize) -> String {
        let bytes = text.as_bytes();
        let mut carry = Vec::new();
        let mut out = decode_chunk(&mut carry, &bytes[..cut]);
        out.push_str(&decode_chunk(&mut carry, &bytes[cut..]));
        assert!(carry.is_empty(), "nothing may be left over after a full sequence");
        out
    }

    #[test]
    fn decodes_multibyte_sequences_split_at_any_boundary() {
        let text = "привет, мир 🐙";
        for cut in 0..=text.len() {
            assert_eq!(decode_split(text, cut), text, "cut at byte {cut}");
        }
    }

    #[test]
    fn decodes_one_byte_at_a_time() {
        let text = "привет";
        let mut carry = Vec::new();
        let mut out = String::new();
        for b in text.as_bytes() {
            out.push_str(&decode_chunk(&mut carry, std::slice::from_ref(b)));
        }
        assert_eq!(out, text);
        assert!(carry.is_empty());
    }

    #[test]
    fn replaces_invalid_bytes_and_keeps_going() {
        let mut carry = Vec::new();
        assert_eq!(decode_chunk(&mut carry, &[b'a', 0xff, b'b']), "a\u{FFFD}b");
        assert!(carry.is_empty());
    }

    #[test]
    fn pump_flushes_incomplete_tail_as_replacement() {
        let (events, rx) = collector();
        // "ab" followed by the first byte of a two-byte sequence that never completes.
        pump(7, &b"ab\xd0"[..], events.as_ref());
        assert_eq!(rx.try_recv().unwrap(), Event::Data("ab".into()));
        assert_eq!(rx.try_recv().unwrap(), Event::Data("\u{FFFD}".into()));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn runs_fixed_command_and_reports_exit_code() {
        let (events, rx) = collector();
        let mut cmd = CommandBuilder::new("/bin/echo");
        cmd.arg("hello");
        let session = spawn(1, cmd, pty_size(80, 24), events).expect("spawn /bin/echo");
        let (text, code) = drain_until_exit(&rx);
        assert!(text.contains("hello"), "output was {text:?}");
        assert_eq!(code, Some(0));
        close_session(session);
    }

    #[test]
    fn written_input_reaches_the_child_and_close_ends_it() {
        let (events, rx) = collector();
        let session = spawn(2, CommandBuilder::new("/bin/cat"), pty_size(80, 24), events).expect("spawn /bin/cat");
        {
            let mut w = session.writer.lock().unwrap();
            w.write_all(b"ping\n").unwrap();
            w.flush().unwrap();
        }
        let mut seen = String::new();
        while !seen.contains("ping") {
            match rx.recv_timeout(Duration::from_secs(10)).expect("no echo from cat") {
                Event::Data(d) => seen.push_str(&d),
                Event::Exit(_) => panic!("cat exited early"),
            }
        }
        close_session(session);
        drain_until_exit(&rx);
    }

    #[test]
    fn shell_falls_back_to_zsh() {
        assert_eq!(shell_path(None), "/bin/zsh");
        assert_eq!(shell_path(Some("  ".into())), "/bin/zsh");
        assert_eq!(shell_path(Some("/bin/bash".into())), "/bin/bash");
    }

    #[test]
    fn lang_falls_back_to_utf8() {
        assert_eq!(lang_value(None), "en_US.UTF-8");
        assert_eq!(lang_value(Some(String::new())), "en_US.UTF-8");
        assert_eq!(lang_value(Some("ru_RU.UTF-8".into())), "ru_RU.UTF-8");
    }
}
