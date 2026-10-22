// App lifecycle on macOS: closing the window keeps the app and its agents running
// in the background, the Dock icon brings the window back, and quitting while an
// agent works asks first (the question itself is shown by the web side).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State, WindowEvent};

#[derive(Default)]
pub struct ShellState {
    /// An agent is working or waiting for an answer (reported by the web side).
    busy: AtomicBool,
    /// The user confirmed quitting: let the next exit through.
    quitting: AtomicBool,
}

/// Shows and focuses the main window (it may be hidden or minimized).
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Whether the in-app updater may replace this copy. On Linux it can swap only an
/// AppImage (`$APPIMAGE` is set inside one); a .deb or AUR install belongs to the
/// package manager.
fn self_updates(linux: bool, appimage: Option<std::ffi::OsString>) -> bool {
    !linux || appimage.is_some_and(|p| !p.is_empty())
}

#[tauri::command]
pub fn app_self_updates() -> bool {
    self_updates(cfg!(target_os = "linux"), std::env::var_os("APPIMAGE"))
}

#[tauri::command]
pub fn app_set_busy(state: State<ShellState>, busy: bool) {
    state.busy.store(busy, Ordering::Relaxed);
}

/// Quits the app. Unless `force`, an agent at work turns this into a question to the user.
#[tauri::command]
pub fn app_quit<R: Runtime>(app: AppHandle<R>, state: State<ShellState>, force: bool) {
    if !force && state.busy.load(Ordering::Relaxed) {
        ask_before_quit(&app);
        return;
    }
    state.quitting.store(true, Ordering::Relaxed);
    app.exit(0);
}

fn ask_before_quit<R: Runtime>(app: &AppHandle<R>) {
    show_main(app);
    let _ = app.emit("quit-requested", ());
}

/// Window close hides the window instead (macOS only: elsewhere nothing would bring it back).
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    #[cfg(target_os = "macos")]
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" && !window.state::<ShellState>().quitting.load(Ordering::Relaxed) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
    let _ = (window, event);
}

pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    match event {
        // ⌘Q from the system (Dock menu, logout) while an agent works: ask first.
        RunEvent::ExitRequested { api, .. } => {
            let state = app.state::<ShellState>();
            if state.busy.load(Ordering::Relaxed) && !state.quitting.load(Ordering::Relaxed) {
                api.prevent_exit();
                ask_before_quit(app);
            }
        }
        // Clicking the Dock icon with the window hidden.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => show_main(app),
        RunEvent::Exit => {
            app.state::<crate::omp::OmpState>().shutdown();
            app.state::<crate::pty::PtyState>().shutdown();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_linux_system_package_leaves_updates_to_the_package_manager() {
        assert!(self_updates(false, None));
        assert!(self_updates(true, Some("/home/u/Octopus.AppImage".into())));
        assert!(!self_updates(true, None));
        assert!(!self_updates(true, Some("".into())));
    }
}
