//! Notifications whose click opens their session, on Linux. The notification
//! plugin cannot report a click on the desktop, so the page sends Linux
//! notifications here instead. Each session keeps at most one card: a new one
//! replaces the old, and the page closes a card once it no longer needs the
//! user. A click (the freedesktop "default" action) shows the window and opens
//! the session, as `octopus-ai --session <id>` would. Elsewhere `app_notify`
//! fails and the page falls back to the plugin.

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::sync::Mutex;

use tauri::{AppHandle, Runtime, State};

#[derive(Default)]
pub struct NotifyState {
    #[cfg(target_os = "linux")]
    cards: Mutex<HashMap<String, notify_rust::NotificationHandle>>,
}

// Async commands, so the D-Bus calls run off the main thread.

/// Shows a card for the session, replacing its previous one.
#[tauri::command]
pub async fn app_notify<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NotifyState>,
    session_id: String,
    title: String,
    body: String,
    open_label: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use notify_rust::{ActionResponse, Notification};
        use tauri::Manager;

        // One guard for the whole replace-then-show. Releasing it in between lets
        // two cards for one session reach the screen at once; the map then holds
        // only the second, so the first can never be closed and stays up for good.
        let mut cards = state.cards.lock().unwrap();
        if let Some(old) = cards.remove(&session_id) {
            old.close();
        }
        let handle = Notification::new()
            .auto_icon()
            .summary(&title)
            .body(&body)
            // Servers that draw actions as buttons show this label.
            .action("default", &open_label)
            .show()
            .map_err(|e| e.to_string())?;
        let id = handle.id();
        cards.insert(session_id.clone(), handle);
        drop(cards);
        // Waits until the card is clicked or closed; a closed card ends the wait.
        std::thread::spawn(move || {
            let _ = notify_rust::handle_action(id, |response| {
                if let ActionResponse::Custom("default") = response {
                    crate::launch::open_session(&app, session_id.clone());
                }
            });
            let state = app.state::<NotifyState>();
            let mut cards = state.cards.lock().unwrap();
            if cards.get(&session_id).is_some_and(|h| h.id() == id) {
                cards.remove(&session_id);
            }
        });
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state, session_id, title, body, open_label);
        Err("notifications with a click action are Linux-only".into())
    }
}

/// Takes the session's card off the screen, if it has one.
#[tauri::command]
pub async fn app_notify_close(state: State<'_, NotifyState>, session_id: String) -> Result<(), ()> {
    #[cfg(target_os = "linux")]
    if let Some(handle) = state.cards.lock().unwrap().remove(&session_id) {
        handle.close();
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (state, session_id);
    Ok(())
}
