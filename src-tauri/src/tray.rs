//! Optional tray icon outside macOS, where the Dock already plays this part.
//! With the setting on, closing the window only hides it and the agents keep
//! working; the tray menu (or `octopus-ai --show`) brings the window back, and
//! Quit asks first while an agent works. With it off, closing the window quits,
//! as before.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, State, Wry};

const TRAY_ID: &str = "main";

#[derive(Default)]
pub struct TrayState {
    keep_running: AtomicBool,
    /// The tray's menu, so a language change rewrites its labels instead of
    /// building a second tray.
    menu: Mutex<Option<Menu<Wry>>>,
    /// The menu handler is registered once: tauri appends global listeners to a
    /// list it never prunes, so a second copy would run on every click.
    handled: AtomicBool,
}

/// Whether closing the main window should hide it instead of quitting.
pub fn keeps_running<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<TrayState>().keep_running.load(Ordering::Relaxed)
}

/// Turns the tray on or off. The labels come from the page, in its language.
#[tauri::command]
pub fn app_set_keep_in_tray(
    app: AppHandle,
    state: State<TrayState>,
    enabled: bool,
    show_label: String,
    quit_label: String,
) -> Result<(), String> {
    let enabled = enabled && !cfg!(target_os = "macos");
    // Set only once the icon exists: a hidden window with no icon has no way back.
    state.keep_running.store(false, Ordering::Relaxed);
    if !enabled {
        let _ = app.remove_tray_by_id(TRAY_ID);
        *state.menu.lock().unwrap() = None;
        return Ok(());
    }
    if !has_appindicator() {
        return Err("tray: neither libayatana-appindicator3 nor libappindicator3 is installed".into());
    }
    // Built once. A language change only rewrites the labels: rebuilding would
    // register another menu handler, and one click would then run it once per
    // past build (twice for a second quit question, and so on).
    if app.tray_by_id(TRAY_ID).is_some() {
        let menu = state.menu.lock().unwrap();
        if let Some(menu) = menu.as_ref() {
            set_label(menu, "tray-show", &show_label)?;
            set_label(menu, "tray-quit", &quit_label)?;
        }
        state.keep_running.store(true, Ordering::Relaxed);
        return Ok(());
    }
    let show = MenuItem::with_id(&app, "tray-show", show_label, true, None::<&str>).map_err(|e| e.to_string())?;
    let separator = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, "tray-quit", quit_label, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&show, &separator, &quit]).map_err(|e| e.to_string())?;
    if !state.handled.swap(true, Ordering::Relaxed) {
        app.on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => crate::shell::show_main(app),
            "tray-quit" => crate::shell::app_quit(app.clone(), app.state(), false),
            _ => {}
        });
    }
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Octopus")
        .menu(&menu)
        // Windows reports clicks; the Linux tray (AppIndicator) only opens the menu.
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::shell::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(&app).map_err(|e| format!("tray: {e}"))?;
    *state.menu.lock().unwrap() = Some(menu);
    state.keep_running.store(true, Ordering::Relaxed);
    Ok(())
}

/// Rewrites one label of the tray's menu, which is still on screen.
fn set_label(menu: &Menu<Wry>, id: &str, text: &str) -> Result<(), String> {
    if let Some(MenuItemKind::MenuItem(item)) = menu.get(id) {
        item.set_text(text).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The Linux tray goes through libappindicator, which aborts the app when the
/// library is missing, so look for it first. These are every name
/// libappindicator-sys tries, in order: the versioned pair, then the pair the
/// "backcompat" feature adds for bundles that ship the file without a soname.
#[cfg(target_os = "linux")]
fn has_appindicator() -> bool {
    [
        "libayatana-appindicator3.so.1",
        "libappindicator3.so.1",
        "libayatana-appindicator3.so",
        "libappindicator3.so",
    ]
    .iter()
    .any(|name| unsafe { libloading::Library::new(name) }.is_ok())
}

#[cfg(not(target_os = "linux"))]
fn has_appindicator() -> bool {
    true
}
