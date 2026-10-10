//! Project file reading and saving exported text.
//!
//! `read_project_file` serves files from the agent's project folder only: the
//! path is canonicalized (which resolves `..` and symlinks) and must stay
//! inside the canonical project root. `save_text_file` writes an absolute path
//! picked in a native save dialog, atomically, via a temp file and a rename.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::Serialize;

const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SAVE_BYTES: usize = 20 * 1024 * 1024;
/// Largest image accepted from a dropped file (same limit as pasted images).
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// NUL bytes are only searched for in this many leading bytes.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// Share of invalid UTF-8 bytes above which a file counts as binary.
const MAX_INVALID_UTF8_RATIO: f64 = 0.01;
const LANGUAGES: &[&str] = &[
    "ts", "tsx", "js", "jsx", "rs", "py", "go", "json", "md", "css", "html", "toml", "yaml", "yml",
    "sh", "sql", "swift", "kt", "java", "c", "cpp", "h",
];

const ERR_ROOT: &str = "Папка проекта не найдена";
const ERR_NOT_FOUND: &str = "Файл не найден";
const ERR_OUTSIDE: &str = "Файл находится за пределами папки проекта";
const ERR_IS_DIR: &str = "Это папка";
const ERR_NOT_REGULAR: &str = "Это не обычный файл";
const ERR_BINARY: &str = "Бинарный файл — просмотр недоступен";
const ERR_NOT_ABSOLUTE: &str = "Нужен абсолютный путь к файлу";
const ERR_PARENT_MISSING: &str = "Папка не найдена";
const ERR_IMAGE_TYPE: &str = "Неподдерживаемый формат изображения";
const ERR_IMAGE_TOO_BIG: &str = "Файл больше 5 МБ";

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    /// Base64 of the file bytes, no `data:` prefix.
    data: String,
    mime_type: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// Relative to the project root, forward slashes.
    path: String,
    text: String,
    lines: u32,
    /// Size of the file on disk.
    bytes: u64,
    truncated: bool,
    language: String,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn read_project_file(cwd: String, path: String) -> Result<FileContent, String> {
    blocking(move || read_project_file_sync(&cwd, &path)).await
}

#[tauri::command]
pub async fn save_text_file(path: String, content: String) -> Result<(), String> {
    blocking(move || save_text_file_sync(&path, &content)).await
}

/// Reads an image dropped from Finder (absolute path, png/jpg/gif/webp, at most 5 MB).
#[tauri::command]
pub async fn read_image_file(path: String) -> Result<ImageData, String> {
    blocking(move || read_image_file_sync(&path)).await
}

/// Whether a dropped path is a folder (or a symlink to one).
#[tauri::command]
pub async fn path_is_dir(path: String) -> Result<bool, String> {
    blocking(move || path_is_dir_sync(&path)).await
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Внутренняя ошибка: {e}"))?
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

fn read_project_file_sync(cwd: &str, path: &str) -> Result<FileContent, String> {
    let root = fs::canonicalize(cwd).map_err(|_| ERR_ROOT.to_string())?;
    let target = resolve_inside(&root, path)?;

    let meta = fs::metadata(&target).map_err(read_error)?;
    if meta.is_dir() {
        return Err(ERR_IS_DIR.to_string());
    }
    if !meta.is_file() {
        return Err(ERR_NOT_REGULAR.to_string());
    }

    let size = meta.len();
    let mut buf = Vec::new();
    File::open(&target)
        .and_then(|f| f.take(MAX_READ_BYTES).read_to_end(&mut buf))
        .map_err(read_error)?;

    let truncated = size > MAX_READ_BYTES;
    let text = decode_sample(buf, truncated)?;
    Ok(FileContent {
        path: relative_path(&root, &target),
        lines: count_lines(&text),
        bytes: size,
        truncated,
        language: language_of(&target),
        text,
    })
}

/// Resolves `path` (relative to `root` or absolute) to a canonical path and
/// rejects anything that does not stay inside the canonical `root`.
fn resolve_inside(root: &Path, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|_| ERR_ROOT.to_string())?;
    let joined = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    let target = fs::canonicalize(&joined).map_err(|_| ERR_NOT_FOUND.to_string())?;
    // `Path::starts_with` compares whole components, so `/a/proj2` is not inside `/a/proj`.
    if !target.starts_with(&root) {
        return Err(ERR_OUTSIDE.to_string());
    }
    Ok(target)
}

/// Turns the bytes read from a file into text.
///
/// Rejects binary content (NUL in the sniff window, or more than 1% invalid
/// UTF-8). When `truncated`, the text is cut after its last full line; if the
/// buffer holds no newline at all, it is kept whole.
fn decode_sample(buf: Vec<u8>, truncated: bool) -> Result<String, String> {
    let sniff = &buf[..buf.len().min(BINARY_SNIFF_BYTES)];
    if sniff.contains(&0) || invalid_utf8_ratio(&buf) > MAX_INVALID_UTF8_RATIO {
        return Err(ERR_BINARY.to_string());
    }
    let keep = if truncated {
        buf.iter()
            .rposition(|&b| b == b'\n')
            .map_or(buf.len(), |i| i + 1)
    } else {
        buf.len()
    };
    Ok(String::from_utf8_lossy(&buf[..keep]).into_owned())
}

fn invalid_utf8_ratio(buf: &[u8]) -> f64 {
    if buf.is_empty() {
        return 0.0;
    }
    invalid_utf8_bytes(buf) as f64 / buf.len() as f64
}

fn invalid_utf8_bytes(mut rest: &[u8]) -> usize {
    let mut invalid = 0;
    while let Err(e) = std::str::from_utf8(rest) {
        let valid = e.valid_up_to();
        let bad = e.error_len().unwrap_or(rest.len() - valid);
        invalid += bad;
        rest = &rest[valid + bad..];
    }
    invalid
}

fn count_lines(text: &str) -> u32 {
    u32::try_from(text.lines().count()).unwrap_or(u32::MAX)
}

fn relative_path(root: &Path, target: &Path) -> String {
    target
        .strip_prefix(root)
        .unwrap_or(target)
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn language_of(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if LANGUAGES.contains(&ext.as_str()) {
        ext
    } else {
        "text".to_string()
    }
}

fn read_error(e: io::Error) -> String {
    if e.kind() == io::ErrorKind::NotFound {
        ERR_NOT_FOUND.to_string()
    } else {
        format!("Не удалось прочитать файл: {e}")
    }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

fn save_text_file_sync(path: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_SAVE_BYTES {
        return Err("Файл слишком большой (максимум 20 МБ)".to_string());
    }
    if !Path::new(path).is_absolute() {
        return Err(ERR_NOT_ABSOLUTE.to_string());
    }
    let mut target = PathBuf::from(path);
    if target.is_dir() {
        return Err(ERR_IS_DIR.to_string());
    }
    // Write through an existing symlink rather than replacing the link itself.
    if let Ok(real) = fs::canonicalize(&target) {
        target = real;
    }
    let dir = target
        .parent()
        .filter(|d| d.is_dir())
        .ok_or_else(|| ERR_PARENT_MISSING.to_string())?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "Некорректный путь к файлу".to_string())?;

    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        file_name.to_string_lossy(),
        unique_suffix()
    ));
    write_temp(&tmp, content)?;

    // Keep the permissions of the file being replaced (e.g. executable scripts).
    if let Ok(meta) = fs::metadata(&target) {
        if let Err(e) = fs::set_permissions(&tmp, meta.permissions()) {
            let _ = fs::remove_file(&tmp);
            return Err(write_error(e));
        }
    }
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        write_error(e)
    })
}

/// Creates `tmp` exclusively and writes `content` to it durably.
/// Removes `tmp` again if anything fails.
fn write_temp(tmp: &Path, content: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp)
        .map_err(write_error)?;
    let written = file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    written.map_err(|e| {
        let _ = fs::remove_file(tmp);
        write_error(e)
    })
}

fn write_error(e: io::Error) -> String {
    format!("Не удалось записать файл: {e}")
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

// ---------------------------------------------------------------------------
// Dropped files
// ---------------------------------------------------------------------------

/// MIME type for the image extensions we send to the agent, else `None`.
fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn read_image_file_sync(path: &str) -> Result<ImageData, String> {
    if !Path::new(path).is_absolute() {
        return Err(ERR_NOT_ABSOLUTE.to_string());
    }
    let target = Path::new(path);
    let mime = image_mime(target).ok_or_else(|| ERR_IMAGE_TYPE.to_string())?;

    // symlink_metadata: a symlink is not a regular file here, so it is refused.
    let meta = fs::symlink_metadata(target).map_err(read_error)?;
    if meta.is_dir() {
        return Err(ERR_IS_DIR.to_string());
    }
    if !meta.file_type().is_file() {
        return Err(ERR_NOT_REGULAR.to_string());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(ERR_IMAGE_TOO_BIG.to_string());
    }

    // Read at most one byte past the limit, in case the file grew since the stat.
    let mut buf = Vec::new();
    File::open(target)
        .and_then(|f| f.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut buf))
        .map_err(read_error)?;
    if buf.len() as u64 > MAX_IMAGE_BYTES {
        return Err(ERR_IMAGE_TOO_BIG.to_string());
    }

    Ok(ImageData {
        data: base64::engine::general_purpose::STANDARD.encode(&buf),
        mime_type: mime.to_string(),
    })
}

fn path_is_dir_sync(path: &str) -> Result<bool, String> {
    if !Path::new(path).is_absolute() {
        return Err(ERR_NOT_ABSOLUTE.to_string());
    }
    fs::metadata(path)
        .map(|m| m.is_dir())
        .map_err(read_error)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp directory, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("octopus-files-{name}-{}", unique_suffix()));
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    // -- containment --------------------------------------------------------

    #[test]
    fn containment_accepts_relative_and_absolute_paths_inside_root() {
        let t = TempDir::new("inside");
        write(&t.path().join("src/a.ts"), b"x");

        let rel = resolve_inside(t.path(), "src/a.ts").unwrap();
        assert!(rel.ends_with("src/a.ts"));

        let abs = t.path().join("src/a.ts");
        assert!(resolve_inside(t.path(), abs.to_str().unwrap()).is_ok());
    }

    #[test]
    fn containment_rejects_dotdot_escape() {
        let base = TempDir::new("dotdot");
        write(&base.path().join("secret.txt"), b"s");
        let proj = base.path().join("proj");
        fs::create_dir_all(&proj).unwrap();

        assert_eq!(
            resolve_inside(&proj, "../secret.txt").unwrap_err(),
            ERR_OUTSIDE
        );
    }

    #[test]
    fn containment_rejects_absolute_path_outside_root() {
        let base = TempDir::new("absolute");
        write(&base.path().join("secret.txt"), b"s");
        let proj = base.path().join("proj");
        fs::create_dir_all(&proj).unwrap();

        let outside = base.path().join("secret.txt");
        assert_eq!(
            resolve_inside(&proj, outside.to_str().unwrap()).unwrap_err(),
            ERR_OUTSIDE
        );
    }

    #[test]
    fn containment_rejects_sibling_with_same_name_prefix() {
        let base = TempDir::new("sibling");
        let proj = base.path().join("proj");
        fs::create_dir_all(&proj).unwrap();
        write(&base.path().join("proj2/x.txt"), b"x");

        assert_eq!(
            resolve_inside(&proj, "../proj2/x.txt").unwrap_err(),
            ERR_OUTSIDE
        );
    }

    #[cfg(unix)]
    #[test]
    fn containment_rejects_symlink_escape() {
        let base = TempDir::new("symlink");
        write(&base.path().join("secret.txt"), b"s");
        let proj = base.path().join("proj");
        fs::create_dir_all(&proj).unwrap();
        std::os::unix::fs::symlink(base.path().join("secret.txt"), proj.join("link")).unwrap();

        assert_eq!(resolve_inside(&proj, "link").unwrap_err(), ERR_OUTSIDE);
    }

    #[test]
    fn containment_reports_missing_file() {
        let t = TempDir::new("missing");
        assert_eq!(
            resolve_inside(t.path(), "nope.txt").unwrap_err(),
            ERR_NOT_FOUND
        );
    }

    // -- binary detection and truncation -------------------------------------

    #[test]
    fn nul_byte_in_sniff_window_is_binary() {
        assert_eq!(
            decode_sample(b"hello\0world".to_vec(), false).unwrap_err(),
            ERR_BINARY
        );
    }

    #[test]
    fn invalid_utf8_above_one_percent_is_binary() {
        let mut buf = vec![b'a'; 1000];
        for i in 0..20 {
            buf[i * 10] = 0xFF; // 2%
        }
        assert_eq!(decode_sample(buf, false).unwrap_err(), ERR_BINARY);
    }

    #[test]
    fn small_invalid_utf8_share_is_tolerated() {
        let mut buf = vec![b'a'; 1000];
        for i in 0..5 {
            buf[i * 100] = 0xFF; // 0.5%
        }
        let text = decode_sample(buf, false).unwrap();
        assert!(text.contains('\u{FFFD}'));
    }

    #[test]
    fn untruncated_text_is_returned_whole() {
        assert_eq!(decode_sample(b"a\nb".to_vec(), false).unwrap(), "a\nb");
    }

    #[test]
    fn truncation_cuts_at_last_full_line() {
        let line = {
            let mut l = vec![b'x'; 99];
            l.push(b'\n');
            l
        };
        let limit = MAX_READ_BYTES as usize;
        let mut full = Vec::new();
        while full.len() + line.len() <= limit {
            full.extend_from_slice(&line);
        }
        let mut buf = full.clone();
        buf.extend_from_slice(b"partial line without newline");

        let text = decode_sample(buf, true).unwrap();
        assert_eq!(text.as_bytes(), &full[..]);
        assert_eq!(count_lines(&text) as usize, full.len() / line.len());
    }

    #[test]
    fn truncation_without_newline_keeps_buffer() {
        assert_eq!(decode_sample(vec![b'a'; 10], true).unwrap(), "aaaaaaaaaa");
    }

    #[test]
    fn language_is_guessed_from_extension() {
        assert_eq!(language_of(Path::new("a/B.TSX")), "tsx");
        assert_eq!(language_of(Path::new("x.xyz")), "text");
        assert_eq!(language_of(Path::new("Makefile")), "text");
    }

    #[test]
    fn read_returns_metadata_for_small_file() {
        let t = TempDir::new("read-small");
        write(&t.path().join("src/main.rs"), b"fn main() {}\n\n");
        let root = t.path().to_str().unwrap();

        let f = read_project_file_sync(root, "src/main.rs").unwrap();
        assert_eq!(f.path, "src/main.rs");
        assert_eq!(f.lines, 2);
        assert_eq!(f.bytes, 14);
        assert!(!f.truncated);
        assert_eq!(f.language, "rs");
    }

    #[test]
    fn read_truncates_big_file_at_line_boundary() {
        let t = TempDir::new("read-big");
        let mut content = Vec::new();
        while content.len() <= MAX_READ_BYTES as usize + 1000 {
            content.extend_from_slice(b"0123456789 0123456789 0123456789\n");
        }
        write(&t.path().join("big.log"), &content);

        let f = read_project_file_sync(t.path().to_str().unwrap(), "big.log").unwrap();
        assert!(f.truncated);
        assert_eq!(f.bytes, content.len() as u64);
        assert!(f.text.len() <= MAX_READ_BYTES as usize);
        assert!(f.text.ends_with('\n'));
        assert_eq!(f.lines as usize, f.text.lines().count());
    }

    #[test]
    fn read_rejects_directory_and_binary_file() {
        let t = TempDir::new("read-errors");
        fs::create_dir_all(t.path().join("src")).unwrap();
        write(&t.path().join("img.bin"), b"\x89PNG\0\0");
        let root = t.path().to_str().unwrap();

        assert_eq!(read_project_file_sync(root, "src").unwrap_err(), ERR_IS_DIR);
        assert_eq!(
            read_project_file_sync(root, "img.bin").unwrap_err(),
            ERR_BINARY
        );
    }

    // -- saving --------------------------------------------------------------

    #[test]
    fn save_rejects_relative_path() {
        assert_eq!(
            save_text_file_sync("out.txt", "x").unwrap_err(),
            ERR_NOT_ABSOLUTE
        );
    }

    #[test]
    fn save_rejects_missing_parent_and_directory() {
        let t = TempDir::new("save-reject");
        let missing = t.path().join("missing/out.txt");
        assert_eq!(
            save_text_file_sync(missing.to_str().unwrap(), "x").unwrap_err(),
            ERR_PARENT_MISSING
        );
        assert_eq!(
            save_text_file_sync(t.path().to_str().unwrap(), "x").unwrap_err(),
            ERR_IS_DIR
        );
    }

    #[test]
    fn save_writes_and_overwrites_without_leftovers() {
        let t = TempDir::new("save-ok");
        let out = t.path().join("out.md");
        let out = out.to_str().unwrap();

        save_text_file_sync(out, "one").unwrap();
        save_text_file_sync(out, "two").unwrap();

        assert_eq!(fs::read_to_string(out).unwrap(), "two");
        assert_eq!(fs::read_dir(t.path()).unwrap().count(), 1);
    }

    #[test]
    fn save_rejects_oversized_content() {
        let t = TempDir::new("save-big");
        let out = t.path().join("big.txt");
        let content = "a".repeat(MAX_SAVE_BYTES + 1);
        assert!(save_text_file_sync(out.to_str().unwrap(), &content).is_err());
        assert!(!out.exists());
    }

    // -- dropped images --------------------------------------------------------

    const PNG_LIKE: &[u8] = b"\x89PNG\r\n\x1a\n\x00\xff\xfe\x10binary-payload";

    #[test]
    fn image_roundtrips_through_base64() {
        let t = TempDir::new("img-ok");
        write(&t.path().join("Shot.PNG"), PNG_LIKE);

        let img = read_image_file_sync(t.path().join("Shot.PNG").to_str().unwrap()).unwrap();
        assert_eq!(img.mime_type, "image/png");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&img.data)
            .unwrap();
        assert_eq!(decoded, PNG_LIKE);
    }

    #[test]
    fn image_over_five_mb_is_rejected() {
        let t = TempDir::new("img-big");
        let path = t.path().join("big.jpg");
        write(&path, &vec![0u8; MAX_IMAGE_BYTES as usize + 1]);

        assert_eq!(
            read_image_file_sync(path.to_str().unwrap()).unwrap_err(),
            ERR_IMAGE_TOO_BIG
        );
    }

    #[test]
    fn non_image_extension_is_rejected() {
        let t = TempDir::new("img-type");
        write(&t.path().join("notes.txt"), b"hello");
        write(&t.path().join("vector.svg"), b"<svg/>");

        assert_eq!(
            read_image_file_sync(t.path().join("notes.txt").to_str().unwrap()).unwrap_err(),
            ERR_IMAGE_TYPE
        );
        assert_eq!(
            read_image_file_sync(t.path().join("vector.svg").to_str().unwrap()).unwrap_err(),
            ERR_IMAGE_TYPE
        );
    }

    #[test]
    fn image_read_needs_absolute_path_and_rejects_folders() {
        let t = TempDir::new("img-paths");
        fs::create_dir_all(t.path().join("pics.png")).unwrap();

        assert_eq!(
            read_image_file_sync("pics.png").unwrap_err(),
            ERR_NOT_ABSOLUTE
        );
        assert_eq!(
            read_image_file_sync(t.path().join("pics.png").to_str().unwrap()).unwrap_err(),
            ERR_IS_DIR
        );
    }

    #[cfg(unix)]
    #[test]
    fn image_symlink_is_not_followed() {
        let t = TempDir::new("img-link");
        write(&t.path().join("real.png"), PNG_LIKE);
        let link = t.path().join("link.png");
        std::os::unix::fs::symlink(t.path().join("real.png"), &link).unwrap();

        assert_eq!(
            read_image_file_sync(link.to_str().unwrap()).unwrap_err(),
            ERR_NOT_REGULAR
        );
    }

    #[test]
    fn path_is_dir_distinguishes_folders_and_files() {
        let t = TempDir::new("is-dir");
        fs::create_dir_all(t.path().join("src")).unwrap();
        write(&t.path().join("a.ts"), b"x");

        assert!(path_is_dir_sync(t.path().join("src").to_str().unwrap()).unwrap());
        assert!(!path_is_dir_sync(t.path().join("a.ts").to_str().unwrap()).unwrap());
        assert_eq!(path_is_dir_sync("src").unwrap_err(), ERR_NOT_ABSOLUTE);
    }
}

#[cfg(test)]
mod real_data {
    use super::*;
    use std::time::Instant;

    fn project_root() -> String {
        let home = std::env::var("HOME").expect("HOME is set");
        format!("{home}/Documents/GitHub/Octopus-AI")
    }

    fn preview80(s: &str) -> String {
        s.chars().take(80).collect::<String>().replace('\n', " / ")
    }

    #[test]
    #[ignore] // reads the developer's real project files; run with --ignored
    fn smoke() {
        let root = project_root();

        for (rel, lang) in [("package.json", "json"), ("src/App.tsx", "tsx")] {
            let t = Instant::now();
            let res = tauri::async_runtime::block_on(read_project_file(root.clone(), rel.into()));
            let ms = t.elapsed().as_millis();
            match &res {
                Ok(f) => println!(
                    "[files] read {rel}: ok {ms} ms, path={} lines={} bytes={} truncated={} language={} preview={:?}",
                    f.path,
                    f.lines,
                    f.bytes,
                    f.truncated,
                    f.language,
                    preview80(&f.text)
                ),
                Err(e) => println!("[files] read {rel}: ERR {e} ({ms} ms)"),
            }
            let f = res.expect("project file reads Ok");
            assert_eq!(f.path, rel);
            assert_eq!(f.language, lang);
            assert!(f.lines > 0);
        }

        // Escapes: only the absolute-resolving ones really leave the project.
        for (rel, expected) in [
            ("../../etc/hosts", None),
            ("../../../../../etc/hosts", Some(ERR_OUTSIDE)),
            ("/etc/hosts", Some(ERR_OUTSIDE)),
        ] {
            let t = Instant::now();
            let res = tauri::async_runtime::block_on(read_project_file(root.clone(), rel.into()));
            let ms = t.elapsed().as_millis();
            println!(
                "[files] escape {rel}: {} ({ms} ms)",
                match &res {
                    Ok(f) => format!("OK path={}", f.path),
                    Err(e) => format!("ERR {e}"),
                }
            );
            match expected {
                Some(err) => assert_eq!(res.as_ref().err().map(String::as_str), Some(err)),
                None => assert!(res.is_err()),
            }
        }

        let t = Instant::now();
        let res = tauri::async_runtime::block_on(read_project_file(
            root.clone(),
            "src-tauri/icons/32x32.png".into(),
        ));
        println!(
            "[files] binary src-tauri/icons/32x32.png: {} ({} ms)",
            match &res {
                Ok(f) => format!("OK (unexpected) bytes={}", f.bytes),
                Err(e) => format!("ERR {e}"),
            },
            t.elapsed().as_millis()
        );
        assert_eq!(res.as_ref().err().map(String::as_str), Some(ERR_BINARY));

        let dir = tauri::async_runtime::block_on(read_project_file(root, "src".into()));
        assert_eq!(dir.as_ref().err().map(String::as_str), Some(ERR_IS_DIR));
    }
}
