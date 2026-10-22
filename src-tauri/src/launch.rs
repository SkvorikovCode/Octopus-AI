//! Launches from outside the window: a hotkey, a desktop widget or a notification
//! runs `octopus-ai --show` or `octopus-ai --session <id>`. Only one copy runs: a
//! second launch hands its arguments to the first (single-instance plugin), which
//! shows the window and, for `--session`, tells the web side to open that session.
//! `--show` needs no handling of its own: every launch shows the window.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// A session asked for by the launch that started this copy, until the web side takes it.
#[derive(Default)]
pub struct LaunchState {
    session: Mutex<Option<String>>,
}

/// The id after `--session` (or in `--session=<id>`); other arguments are ignored.
fn session_arg(args: impl IntoIterator<Item = String>) -> Option<String> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let value = if arg == "--session" {
            args.next()
        } else {
            arg.strip_prefix("--session=").map(str::to_owned)
        };
        if let Some(id) = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
            return Some(id);
        }
    }
    None
}

/// Remembers the session the first launch asked for; the page is not loaded yet.
pub fn on_first_launch<R: Runtime>(app: &AppHandle<R>) {
    let id = session_arg(std::env::args().skip(1));
    *app.state::<LaunchState>().session.lock().unwrap() = id;
}

/// A second launch: bring the window forward and pass its session on.
pub fn on_second_launch<R: Runtime>(app: &AppHandle<R>, args: Vec<String>) {
    crate::shell::show_main(app);
    if let Some(id) = session_arg(args.into_iter().skip(1)) {
        let _ = app.emit("open-session", id);
    }
}

/// The session the first launch asked for, once (the web side calls this on start).
#[tauri::command]
pub fn app_take_launch_session(state: State<LaunchState>) -> Option<String> {
    state.session.lock().unwrap().take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_the_session_in_either_form() {
        assert_eq!(session_arg(args(&["--session", "abc"])), Some("abc".into()));
        assert_eq!(session_arg(args(&["--show", "--session=abc"])), Some("abc".into()));
    }

    #[test]
    fn show_alone_or_nothing_asks_for_no_session() {
        assert_eq!(session_arg(args(&["--show"])), None);
        assert_eq!(session_arg(args(&[])), None);
        assert_eq!(session_arg(args(&["--session"])), None);
        assert_eq!(session_arg(args(&["--session", "  "])), None);
    }
}
