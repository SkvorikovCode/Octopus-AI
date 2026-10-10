//! MCP servers in the agent's mcp.json: user-wide (~/.omp/agent/mcp.json) and per project
//! (<project>/.omp/mcp.json). Edits keep unknown keys, write atomically with mode 0600 and
//! keep a one-time copy of the original file. Secret values are never returned to the UI.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const BACKUP_NAME: &str = "mcp.json.octopus-backup";
const KINDS: [&str; 3] = ["stdio", "http", "sse"];
/// Keys Octopus rewrites on every save; any other key of a server is kept as is.
const OWNED_KEYS: [&str; 6] = ["type", "command", "args", "url", "env", "headers"];
const NAME_MAX: usize = 100;
const NOT_FOUND: &str = "Сервер не найден";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    name: String,
    /// "user" | "project"
    scope: &'static str,
    /// "stdio" | "http" | "sse"
    kind: String,
    command: Option<String>,
    args: Vec<String>,
    url: Option<String>,
    /// Names only, never values.
    env_keys: Vec<String>,
    /// Names only, never values.
    header_keys: Vec<String>,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    name: String,
    kind: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    url: Option<String>,
    /// None keeps the existing values of an edited server; Some replaces them.
    /// An entry with an empty value keeps the old value of that key.
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
}

// ---------- paths ----------

fn user_path_in(home: &Path) -> PathBuf {
    home.join(".omp").join("agent").join("mcp.json")
}

fn project_path_in(cwd: &Path) -> PathBuf {
    cwd.join(".omp").join("mcp.json")
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Не найден $HOME".to_string())
}

/// File for a scope. The project scope needs the project folder.
fn scope_path(scope: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "user" => Ok(user_path_in(&home_dir()?)),
        "project" => {
            let dir = cwd
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .ok_or_else(|| "Не выбран проект".to_string())?;
            Ok(project_path_in(Path::new(dir)))
        }
        _ => Err("Неизвестная область".to_string()),
    }
}

// ---------- reading ----------

/// Loads mcp.json. A missing or blank file is an empty document; a file that does
/// not parse is an error, so it is never overwritten.
fn load_doc(path: &Path) -> Result<Value, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(empty_doc()),
        Err(e) => return Err(format!("Не удалось прочитать {}: {e}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(empty_doc());
    }
    match serde_json::from_str::<Value>(&text).map_err(|e| format!("mcp.json не разобран: {e}"))? {
        doc @ Value::Object(_) => Ok(doc),
        _ => Err("mcp.json: корень должен быть объектом".to_string()),
    }
}

fn empty_doc() -> Value {
    Value::Object(Map::new())
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn keys_of(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

fn kind_of(entry: &Map<String, Value>) -> String {
    match entry.get("type").and_then(Value::as_str) {
        Some(k @ ("stdio" | "http" | "sse")) => k.to_string(),
        _ if entry.contains_key("url") => "http".to_string(),
        _ => "stdio".to_string(),
    }
}

fn list_servers(path: &Path, scope: &'static str) -> Result<Vec<McpServer>, String> {
    let doc = load_doc(path)?;
    let disabled = string_list(doc.get("disabledServers"));
    let Some(servers) = doc.get("mcpServers").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    Ok(servers
        .iter()
        .filter_map(|(name, raw)| {
            let entry = raw.as_object()?;
            let enabled = entry.get("enabled") != Some(&Value::Bool(false)) && !disabled.contains(name);
            Some(McpServer {
                name: name.clone(),
                scope,
                kind: kind_of(entry),
                command: entry.get("command").and_then(Value::as_str).map(str::to_string),
                args: string_list(entry.get("args")),
                url: entry.get("url").and_then(Value::as_str).map(str::to_string),
                env_keys: keys_of(entry.get("env")),
                header_keys: keys_of(entry.get("headers")),
                enabled,
            })
        })
        .collect())
}

// ---------- validation ----------

/// Matches `^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$`, up to 100 characters.
fn valid_name(name: &str) -> bool {
    name.len() <= NAME_MAX
        && name.split(' ').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
        })
}

fn is_env_name(key: &str) -> bool {
    let b = key.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

fn is_header_name(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| b.is_ascii_graphic() && b != b':')
}

fn trimmed(v: &Option<String>) -> String {
    v.as_deref().unwrap_or("").trim().to_string()
}

fn validate_input(input: &McpServerInput) -> Result<(), String> {
    if !valid_name(&input.name) {
        return Err("Имя: латиница, цифры, . _ : - и пробелы, до 100 знаков".to_string());
    }
    let kind = input.kind.as_str();
    if !KINDS.contains(&kind) {
        return Err(format!("Неизвестный тип сервера: {kind}"));
    }
    let command = trimmed(&input.command);
    let url = trimmed(&input.url);
    if !command.is_empty() && !url.is_empty() {
        return Err("Укажите команду или URL, не оба".to_string());
    }
    if kind == "stdio" {
        if command.is_empty() {
            return Err("Укажите команду запуска".to_string());
        }
    } else if url.is_empty() {
        return Err("Укажите адрес сервера".to_string());
    } else if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Адрес должен начинаться с http:// или https://".to_string());
    }
    Ok(())
}

// ---------- writing ----------

/// Values for env or headers. None keeps the existing map; Some replaces it, with an
/// empty value keeping the old value of that key.
fn merge_section(
    input: Option<&HashMap<String, String>>,
    existing: Option<&Value>,
    valid: fn(&str) -> bool,
    what: &str,
) -> Result<Map<String, Value>, String> {
    let old = existing.and_then(Value::as_object);
    let Some(input) = input else {
        return Ok(old.cloned().unwrap_or_default());
    };
    let mut out = Map::new();
    for (key, value) in input {
        if !valid(key) {
            return Err(format!("Некорректное имя {what}: {key}"));
        }
        let v = if value.trim().is_empty() {
            old.and_then(|m| m.get(key))
                .cloned()
                .ok_or_else(|| format!("Укажите значение {what}: {key}"))?
        } else {
            Value::String(value.clone())
        };
        out.insert(key.clone(), v);
    }
    Ok(out)
}

fn build_entry(input: &McpServerInput, existing: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let mut entry = existing.clone();
    for key in OWNED_KEYS {
        entry.remove(key);
    }
    let kind = input.kind.as_str();
    entry.insert("type".to_string(), Value::String(kind.to_string()));
    if kind == "stdio" {
        entry.insert("command".to_string(), Value::String(trimmed(&input.command)));
        let args: Vec<Value> = input
            .args
            .iter()
            .map(|a| a.trim())
            .filter(|a| !a.is_empty())
            .map(|a| Value::String(a.to_string()))
            .collect();
        if !args.is_empty() {
            entry.insert("args".to_string(), Value::Array(args));
        }
        let env = merge_section(input.env.as_ref(), existing.get("env"), is_env_name, "переменной")?;
        if !env.is_empty() {
            entry.insert("env".to_string(), Value::Object(env));
        }
    } else {
        entry.insert("url".to_string(), Value::String(trimmed(&input.url)));
        let headers = merge_section(input.headers.as_ref(), existing.get("headers"), is_header_name, "заголовка")?;
        if !headers.is_empty() {
            entry.insert("headers".to_string(), Value::Object(headers));
        }
    }
    Ok(entry)
}

/// The `mcpServers` object, created when missing.
fn servers_mut(doc: &mut Value) -> Result<&mut Map<String, Value>, String> {
    let root = doc
        .as_object_mut()
        .ok_or_else(|| "mcp.json: корень должен быть объектом".to_string())?;
    let slot = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    if slot.is_null() {
        *slot = Value::Object(Map::new());
    }
    slot.as_object_mut()
        .ok_or_else(|| "mcp.json: mcpServers должен быть объектом".to_string())
}

fn rename_disabled(doc: &mut Value, from: &str, to: &str) {
    if let Some(list) = doc.get_mut("disabledServers").and_then(Value::as_array_mut) {
        for item in list.iter_mut() {
            if item.as_str() == Some(from) {
                *item = Value::String(to.to_string());
            }
        }
    }
}

fn forget_disabled(doc: &mut Value, name: &str) {
    if let Some(list) = doc.get_mut("disabledServers").and_then(Value::as_array_mut) {
        list.retain(|item| item.as_str() != Some(name));
    }
}

/// Adds a server, or edits one (`original` names the server being edited; a changed
/// name renames it).
fn save_server(path: &Path, input: &McpServerInput, original: Option<&str>) -> Result<(), String> {
    validate_input(input)?;
    let mut doc = load_doc(path)?;
    let source = {
        let servers = servers_mut(&mut doc)?;
        let source = match original.map(str::trim).filter(|s| !s.is_empty()) {
            Some(old) => {
                if !servers.contains_key(old) {
                    return Err(NOT_FOUND.to_string());
                }
                old.to_string()
            }
            None => {
                if servers.contains_key(&input.name) {
                    return Err("Сервер с таким именем уже есть".to_string());
                }
                input.name.clone()
            }
        };
        if source != input.name && servers.contains_key(&input.name) {
            return Err("Сервер с таким именем уже есть".to_string());
        }
        let existing = servers
            .get(&source)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let entry = build_entry(input, &existing)?;
        if source != input.name {
            servers.remove(&source);
        }
        servers.insert(input.name.clone(), Value::Object(entry));
        source
    };
    if source != input.name {
        rename_disabled(&mut doc, &source, &input.name);
    }
    commit(path, &doc)
}

fn remove_server(path: &Path, name: &str) -> Result<(), String> {
    let mut doc = load_doc(path)?;
    let removed = doc
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .and_then(|servers| servers.remove(name))
        .is_some();
    if !removed {
        return Err(NOT_FOUND.to_string());
    }
    forget_disabled(&mut doc, name);
    commit(path, &doc)
}

/// Sets the server's `enabled` field. Enabling also drops the name from disabledServers.
fn set_enabled(path: &Path, name: &str, enabled: bool) -> Result<(), String> {
    let mut doc = load_doc(path)?;
    {
        let entry = doc
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .and_then(|servers| servers.get_mut(name))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| NOT_FOUND.to_string())?;
        entry.insert("enabled".to_string(), Value::Bool(enabled));
    }
    if enabled {
        forget_disabled(&mut doc, name);
    }
    commit(path, &doc)
}

fn commit(path: &Path, doc: &Value) -> Result<(), String> {
    let mut text =
        serde_json::to_string_pretty(doc).map_err(|e| format!("Не удалось записать mcp.json: {e}"))?;
    text.push('\n');
    ensure_backup(path)?;
    write_atomic(path, &text)
}

/// Keeps the user's original file once, before the first write.
fn ensure_backup(path: &Path) -> Result<(), String> {
    let backup = path.with_file_name(BACKUP_NAME);
    if path.is_file() && !backup.exists() {
        fs::copy(path, &backup).map_err(|e| format!("Не удалось сделать резервную копию: {e}"))?;
        set_mode(&backup, 0o600)?;
    }
    Ok(())
}

/// Creates a directory chain; the directories it creates get mode 0700.
fn ensure_dir(dir: &Path) -> Result<(), String> {
    let mut missing = Vec::new();
    let mut cur = Some(dir);
    while let Some(d) = cur {
        if d.exists() {
            break;
        }
        missing.push(d);
        cur = d.parent();
    }
    fs::create_dir_all(dir).map_err(|e| format!("Не удалось создать {}: {e}", dir.display()))?;
    for d in missing {
        set_mode(d, 0o700)?;
    }
    Ok(())
}

/// Writes `<file>.tmp` with mode 0600, then renames it over the target.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Некорректный путь к mcp.json".to_string())?;
    ensure_dir(dir)?;

    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);

    let io_err = |e: io::Error| format!("Не удалось записать mcp.json: {e}");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp).map_err(io_err)?;
    file.write_all(text.as_bytes()).map_err(io_err)?;
    file.sync_all().map_err(io_err)?;
    drop(file);
    set_mode(&tmp, 0o600)?;
    fs::rename(&tmp, path).map_err(io_err)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|e| format!("Не удалось выставить права на {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn mcp_list(cwd: Option<String>) -> Result<Vec<McpServer>, String> {
    let mut out = list_servers(&user_path_in(&home_dir()?), "user")?;
    if let Some(dir) = cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        out.extend(list_servers(&project_path_in(Path::new(dir)), "project")?);
    }
    Ok(out)
}

#[tauri::command]
pub fn mcp_save(
    cwd: Option<String>,
    scope: String,
    server: McpServerInput,
    original_name: Option<String>,
) -> Result<(), String> {
    let path = scope_path(&scope, cwd.as_deref())?;
    save_server(&path, &server, original_name.as_deref())
}

#[tauri::command]
pub fn mcp_remove(cwd: Option<String>, scope: String, name: String) -> Result<(), String> {
    let path = scope_path(&scope, cwd.as_deref())?;
    remove_server(&path, &name)
}

#[tauri::command]
pub fn mcp_set_enabled(
    cwd: Option<String>,
    scope: String,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let path = scope_path(&scope, cwd.as_deref())?;
    set_enabled(&path, &name, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "octopus-mcp-test-{}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn map(pairs: &[(&str, &str)]) -> Option<HashMap<String, String>> {
        Some(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    fn stdio(name: &str) -> McpServerInput {
        McpServerInput {
            name: name.to_string(),
            kind: "stdio".to_string(),
            command: Some("npx".to_string()),
            args: vec!["-y".to_string(), "@modelcontextprotocol/server-postgres".to_string()],
            url: None,
            env: None,
            headers: None,
        }
    }

    fn remote(name: &str, kind: &str, url: &str) -> McpServerInput {
        McpServerInput {
            name: name.to_string(),
            kind: kind.to_string(),
            command: None,
            args: Vec::new(),
            url: Some(url.to_string()),
            env: None,
            headers: None,
        }
    }

    fn write_raw(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn find<'a>(list: &'a [McpServer], name: &str) -> &'a McpServer {
        list.iter().find(|s| s.name == name).unwrap()
    }

    #[test]
    fn add_and_list_hide_secret_values() {
        let dir = TempDir::new("add");
        let path = user_path_in(&dir.0);
        let mut pg = stdio("postgres");
        pg.env = map(&[("PG_URL", "postgres://secret@db")]);
        save_server(&path, &pg, None).unwrap();
        let mut gh = remote("github", "http", "https://example.com/mcp");
        gh.headers = map(&[("Authorization", "Bearer tok-123")]);
        save_server(&path, &gh, None).unwrap();

        let list = list_servers(&path, "user").unwrap();
        let names: Vec<&str> = list.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["github", "postgres"]);

        let p = find(&list, "postgres");
        assert_eq!(p.kind, "stdio");
        assert_eq!(p.scope, "user");
        assert_eq!(p.command.as_deref(), Some("npx"));
        assert_eq!(p.args, vec!["-y", "@modelcontextprotocol/server-postgres"]);
        assert_eq!(p.env_keys, vec!["PG_URL"]);
        assert!(p.enabled);

        let g = find(&list, "github");
        assert_eq!(g.kind, "http");
        assert_eq!(g.url.as_deref(), Some("https://example.com/mcp"));
        assert_eq!(g.header_keys, vec!["Authorization"]);

        let json = serde_json::to_string(&list).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("tok-123"));

        // Adding a name that exists is refused and changes nothing.
        assert!(save_server(&path, &stdio("postgres"), None).is_err());
        assert_eq!(list_servers(&path, "user").unwrap().len(), 2);
    }

    #[test]
    fn edit_keeps_values_unless_replaced() {
        let dir = TempDir::new("edit");
        let path = user_path_in(&dir.0);
        let mut pg = stdio("postgres");
        pg.env = map(&[("PG_URL", "postgres://secret@db")]);
        save_server(&path, &pg, None).unwrap();

        // env None: the stored value stays.
        let mut edited = stdio("postgres");
        edited.args = vec!["-y".to_string(), "other".to_string()];
        save_server(&path, &edited, Some("postgres")).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("postgres://secret@db"));
        let list = list_servers(&path, "user").unwrap();
        assert_eq!(find(&list, "postgres").env_keys, vec!["PG_URL"]);
        assert_eq!(find(&list, "postgres").args, vec!["-y", "other"]);

        // An empty value keeps the old one; a typed value replaces it; a dropped key goes.
        let mut kept = stdio("postgres");
        kept.env = map(&[("PG_URL", ""), ("EXTRA", "1")]);
        save_server(&path, &kept, Some("postgres")).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("postgres://secret@db"));
        let list = list_servers(&path, "user").unwrap();
        assert_eq!(find(&list, "postgres").env_keys.len(), 2);

        let mut replaced = stdio("postgres");
        replaced.env = map(&[("EXTRA", "2")]);
        save_server(&path, &replaced, Some("postgres")).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("postgres://secret@db"));
        let list = list_servers(&path, "user").unwrap();
        assert_eq!(find(&list, "postgres").env_keys, vec!["EXTRA"]);

        // A new key without a value has nothing to keep.
        let mut bad = stdio("postgres");
        bad.env = map(&[("NEW_KEY", "")]);
        assert!(save_server(&path, &bad, Some("postgres")).is_err());
        assert!(!fs::read_to_string(&path).unwrap().contains("NEW_KEY"));
    }

    #[test]
    fn rename_moves_entry_and_keeps_disabled_state() {
        let dir = TempDir::new("rename");
        let path = user_path_in(&dir.0);
        save_server(&path, &stdio("postgres"), None).unwrap();
        save_server(&path, &remote("github", "http", "https://example.com/mcp"), None).unwrap();
        set_enabled(&path, "postgres", false).unwrap();

        save_server(&path, &stdio("pg"), Some("postgres")).unwrap();
        let list = list_servers(&path, "user").unwrap();
        let names: Vec<&str> = list.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["github", "pg"]);
        assert!(!find(&list, "pg").enabled);

        // Renaming onto an existing name, or from a missing one, fails.
        assert!(save_server(&path, &stdio("github"), Some("pg")).is_err());
        assert!(save_server(&path, &stdio("x"), Some("nope")).is_err());
    }

    #[test]
    fn kind_change_drops_fields_of_the_old_kind() {
        let dir = TempDir::new("kind");
        let path = user_path_in(&dir.0);
        let mut pg = stdio("pg");
        pg.env = map(&[("PG_URL", "postgres://secret@db")]);
        save_server(&path, &pg, None).unwrap();

        save_server(&path, &remote("pg", "sse", "https://example.com/sse"), Some("pg")).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("postgres://secret@db"));
        assert!(!text.contains("\"command\""));
        let list = list_servers(&path, "user").unwrap();
        let s = find(&list, "pg");
        assert_eq!(s.kind, "sse");
        assert!(s.command.is_none());
        assert!(s.env_keys.is_empty());
    }

    #[test]
    fn remove_and_toggle() {
        let dir = TempDir::new("toggle");
        let path = user_path_in(&dir.0);
        save_server(&path, &stdio("pg"), None).unwrap();
        save_server(&path, &remote("github", "http", "https://example.com/mcp"), None).unwrap();

        set_enabled(&path, "pg", false).unwrap();
        assert!(!find(&list_servers(&path, "user").unwrap(), "pg").enabled);
        assert!(fs::read_to_string(&path).unwrap().contains("\"enabled\": false"));
        set_enabled(&path, "pg", true).unwrap();
        assert!(find(&list_servers(&path, "user").unwrap(), "pg").enabled);

        remove_server(&path, "github").unwrap();
        assert!(remove_server(&path, "github").is_err());
        let names: Vec<String> = list_servers(&path, "user")
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["pg"]);
        assert!(set_enabled(&path, "missing", false).is_err());
    }

    #[test]
    fn disabled_list_turns_servers_off_until_enabled() {
        let dir = TempDir::new("disabled");
        let path = user_path_in(&dir.0);
        write_raw(
            &path,
            r#"{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}},"disabledServers":["a"]}"#,
        );
        let list = list_servers(&path, "user").unwrap();
        assert!(!find(&list, "a").enabled);
        assert!(find(&list, "b").enabled);

        set_enabled(&path, "a", true).unwrap();
        let list = list_servers(&path, "user").unwrap();
        assert!(find(&list, "a").enabled);
        let doc = load_doc(&path).unwrap();
        assert_eq!(doc["disabledServers"], serde_json::json!([]));
    }

    #[test]
    fn unknown_keys_survive() {
        let dir = TempDir::new("unknown");
        let path = user_path_in(&dir.0);
        write_raw(
            &path,
            r#"{"$schema":"https://example.com/schema.json","custom":{"a":1},"mcpServers":{"a":{"command":"x","timeout":30,"enabled":true}}}"#,
        );
        save_server(&path, &stdio("a"), Some("a")).unwrap();
        set_enabled(&path, "a", false).unwrap();
        save_server(&path, &stdio("b"), None).unwrap();

        let doc = load_doc(&path).unwrap();
        assert_eq!(doc["$schema"], "https://example.com/schema.json");
        assert_eq!(doc["custom"]["a"], 1);
        assert_eq!(doc["mcpServers"]["a"]["timeout"], 30);
        assert_eq!(doc["mcpServers"]["a"]["enabled"], false);
    }

    #[test]
    fn invalid_input_is_rejected_and_nothing_is_written() {
        let dir = TempDir::new("invalid");
        let path = user_path_in(&dir.0);
        let long = "x".repeat(101);
        for name in ["", " lead", "trail ", "a  b", "bad/name", "кириллица", long.as_str()] {
            assert!(save_server(&path, &stdio(name), None).is_err(), "name {name:?}");
        }
        assert!(save_server(&path, &remote("ws", "ws", "https://x.test"), None).is_err());

        let mut both = stdio("both");
        both.url = Some("https://x.test/mcp".to_string());
        assert!(save_server(&path, &both, None).is_err());

        let mut no_cmd = stdio("nocmd");
        no_cmd.command = None;
        assert!(save_server(&path, &no_cmd, None).is_err());
        assert!(save_server(&path, &remote("noid", "http", ""), None).is_err());
        assert!(save_server(&path, &remote("ftp", "http", "ftp://x.test"), None).is_err());

        assert!(!path.exists());
    }

    #[test]
    fn missing_file_is_empty_and_is_created_only_on_save() {
        let dir = TempDir::new("missing");
        let path = user_path_in(&dir.0);
        assert!(list_servers(&path, "user").unwrap().is_empty());
        assert!(remove_server(&path, "nothing").is_err());
        assert!(set_enabled(&path, "nothing", true).is_err());
        assert!(!path.exists());

        save_server(&path, &stdio("fresh"), None).unwrap();
        assert!(path.is_file());
        assert!(!path.with_file_name(BACKUP_NAME).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn corrupt_file_is_never_overwritten() {
        let dir = TempDir::new("corrupt");
        let path = user_path_in(&dir.0);
        write_raw(&path, "{\"mcpServers\": {");
        assert!(save_server(&path, &stdio("x"), None).is_err());
        assert!(remove_server(&path, "x").is_err());
        assert!(list_servers(&path, "user").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"mcpServers\": {");
    }

    #[test]
    fn first_write_keeps_one_backup_of_the_original() {
        let dir = TempDir::new("backup");
        let path = project_path_in(&dir.0);
        write_raw(&path, r#"{"custom":"original-marker","mcpServers":{}}"#);
        save_server(&path, &stdio("one"), None).unwrap();
        save_server(&path, &stdio("two"), None).unwrap();

        let backup = path.with_file_name(BACKUP_NAME);
        assert!(fs::read_to_string(&backup).unwrap().contains("original-marker"));
        assert!(fs::read_to_string(&path).unwrap().contains("original-marker"));
        assert_eq!(list_servers(&path, "project").unwrap().len(), 2);
        assert_eq!(list_servers(&path, "project").unwrap()[0].scope, "project");
    }

    #[test]
    fn scope_needs_a_project_for_project_files() {
        assert!(scope_path("project", None).is_err());
        assert!(scope_path("project", Some("  ")).is_err());
        assert!(scope_path("elsewhere", Some("/tmp")).is_err());
        let p = scope_path("project", Some("/work/app")).unwrap();
        assert_eq!(p, PathBuf::from("/work/app/.omp/mcp.json"));
    }
}
