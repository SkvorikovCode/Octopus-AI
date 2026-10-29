//! An outside color palette, `<config dir>/octopus/palette.json` (~/.config on
//! Linux), that another program writes so Octopus follows the desktop's colors.
//! The page parses and applies it (src/lib/palette.ts); this side reads the file
//! and tells the page when it changes. A stat every second is enough for a
//! theme switch and costs nothing next to a file-watching dependency.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Larger than any palette; a bigger file is not one.
const MAX_BYTES: u64 = 64 * 1024;

fn palette_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().config_dir().ok().map(|dir| dir.join("octopus").join("palette.json"))
}

/// What identifies a version of the file: none while it is missing.
fn stamp(path: &PathBuf) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// The palette file's text, if there is one.
#[tauri::command]
pub fn palette_read<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    let path = palette_path(&app)?;
    if std::fs::metadata(&path).ok()?.len() > MAX_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Emits `palette-changed` when the file appears, changes or goes away.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    let Some(path) = palette_path(app) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = stamp(&path);
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let now = stamp(&path);
            if now != last {
                last = now;
                let _ = app.emit("palette-changed", ());
            }
        }
    });
}
