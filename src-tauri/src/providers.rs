//! Custom model providers in omp's models.yml; keys live in the OS keychain.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use serde_yaml::{Mapping, Value};

const SERVICE: &str = "ai.octopus.desktop";
const KEY_PREFIX: &str = "OCTOPUS_KEY_";
const BACKUP_NAME: &str = "models.yml.octopus-backup";
const APIS: [&str; 3] = ["openai-completions", "openai-responses", "anthropic-messages"];

const MAX_PRICE: f64 = 10_000.0;
const MAX_INPUT_THRESHOLD: u64 = 10_000_000;

/// Per-model price in USD per 1M tokens: the `cost` map the engine reads from models.yml.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    long_context: Option<LongContextCost>,
}

/// Prices used when the prompt is longer than `input_threshold` tokens.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LongContextCost {
    input_threshold: u64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context_window: Option<u64>,
    #[serde(default)]
    max_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cost: Option<ModelCost>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    id: String,
    base_url: String,
    api: String,
    models: Vec<ProviderModel>,
    /// "octopus" | "env" | "command" | "literal" | "none"
    key_source: &'static str,
    /// true when apiKey is an Octopus-managed keychain reference
    managed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    id: String,
    base_url: String,
    api: String,
    #[serde(default)]
    api_key: Option<String>,
    models: Vec<ProviderModel>,
}

// ---------- paths and small helpers ----------

fn models_path_in(base: &Path) -> PathBuf {
    base.join(".omp").join("agent").join("models.yml")
}

fn models_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "Не найден $HOME".to_string())?;
    Ok(models_path_in(Path::new(&home)))
}

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

/// Reads a string field; numbers and other scalars are rendered as text.
fn str_field(entry: &Value, key: &str) -> String {
    match entry.get(key) {
        None => String::new(),
        Some(Value::Null) => String::new(),
        Some(Value::String(v)) => v.clone(),
        Some(other) => serde_yaml::to_string(other)
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=41).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// Matches `^[A-Z_][A-Z0-9_]*$`.
fn is_env_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_uppercase() || b[0] == b'_')
        && b
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

/// Environment variable name Octopus writes into apiKey for a provider id.
fn env_name(id: &str) -> String {
    let suffix: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("{KEY_PREFIX}{suffix}")
}

fn key_source(api_key: &str) -> &'static str {
    let key = api_key.trim();
    if key.is_empty() {
        "none"
    } else if key.starts_with('!') {
        "command"
    } else if key.starts_with(KEY_PREFIX) {
        "octopus"
    } else if is_env_name(key) {
        "env"
    } else {
        "literal"
    }
}

// ---------- models.yml read / merge / write ----------

fn empty_doc() -> Value {
    Value::Mapping(Mapping::new())
}

/// Loads models.yml. A missing or empty file is an empty document;
/// a file that does not parse is an error, so it is never overwritten.
fn load_doc(path: &Path) -> Result<Value, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(empty_doc()),
        Err(e) => return Err(format!("Не удалось прочитать {}: {e}", path.display())),
    };
    match serde_yaml::from_str::<Value>(&text).map_err(|e| format!("Настройки агента не разобраны: {e}"))? {
        Value::Null => Ok(empty_doc()),
        doc @ Value::Mapping(_) => Ok(doc),
        _ => Err("Настройки агента: корень должен быть словарём".to_string()),
    }
}

fn providers_map(doc: &Value) -> Option<&Mapping> {
    doc.get("providers")?.as_mapping()
}

fn list_providers(doc: &Value) -> Vec<ProviderInfo> {
    let Some(map) = providers_map(doc) else {
        return Vec::new();
    };
    let mut out: Vec<ProviderInfo> = map
        .iter()
        .filter_map(|(key, entry)| {
            let id = key.as_str()?.to_string();
            let api_key = str_field(entry, "apiKey");
            let models = entry
                .get("models")
                .and_then(Value::as_sequence)
                .map(|seq| seq.iter().filter_map(read_model).collect())
                .unwrap_or_default();
            Some(ProviderInfo {
                id,
                base_url: str_field(entry, "baseUrl"),
                api: str_field(entry, "api"),
                models,
                key_source: key_source(&api_key),
                managed: api_key.starts_with(KEY_PREFIX),
            })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Reads one model from models.yml. A malformed `cost` must not hide the model:
/// the model is shown without a cost, and the stored `cost` stays in the file.
fn read_model(m: &Value) -> Option<ProviderModel> {
    if let Ok(model) = serde_yaml::from_value::<ProviderModel>(m.clone()) {
        return Some(model);
    }
    let mut without_cost = m.clone();
    without_cost.as_mapping_mut()?.remove("cost");
    serde_yaml::from_value(without_cost).ok()
}

/// Sets `key` to `value`, or removes it when `value` is None.
fn put(map: &mut Mapping, key: &str, value: Option<Value>) {
    match value {
        Some(v) => {
            map.insert(s(key), v);
        }
        None => {
            map.remove(key);
        }
    }
}

/// Drops float noise (0.1 + 0.2) so the file keeps the prices as the user typed them.
fn tidy_cost(cost: &ModelCost) -> ModelCost {
    let t = |v: f64| (v * 1e9).round() / 1e9;
    ModelCost {
        input: t(cost.input),
        output: t(cost.output),
        cache_read: t(cost.cache_read),
        cache_write: t(cost.cache_write),
        long_context: cost.long_context.as_ref().map(|lc| LongContextCost {
            input_threshold: lc.input_threshold,
            input: t(lc.input),
            output: t(lc.output),
            cache_read: t(lc.cache_read),
            cache_write: t(lc.cache_write),
        }),
    }
}

fn cost_value(cost: &ModelCost) -> Result<Value, String> {
    serde_yaml::to_value(tidy_cost(cost))
        .map_err(|e| format!("Не удалось записать настройки агента: {e}"))
}

/// Builds a models.yml entry for one model of the form. Keys the form does not
/// know (cost, anything added by hand) are kept from `existing`; `cost` is
/// replaced only when the form sets one.
fn model_entry(model: &ProviderModel, existing: Option<&Value>) -> Result<Value, String> {
    let mut m = existing.and_then(Value::as_mapping).cloned().unwrap_or_default();
    put(&mut m, "id", Some(s(model.id.trim())));
    let name = model.name.as_deref().map(str::trim).filter(|n| !n.is_empty());
    put(&mut m, "name", name.map(s));
    let num = |v: u64| Value::Number(serde_yaml::Number::from(v));
    put(&mut m, "contextWindow", model.context_window.map(num));
    put(&mut m, "maxTokens", model.max_tokens.map(num));
    if let Some(cost) = &model.cost {
        m.insert(s("cost"), cost_value(cost)?);
    }
    Ok(Value::Mapping(m))
}

/// Builds providers.<id>. Provider keys the form does not know survive from
/// `existing`; each model keeps its unknown keys (see `model_entry`).
fn provider_entry(input: &ProviderInput, existing: Option<&Value>) -> Result<Value, String> {
    let mut m = existing.and_then(Value::as_mapping).cloned().unwrap_or_default();
    m.insert(s("baseUrl"), s(input.base_url.trim()));
    m.insert(s("api"), s(&input.api));
    m.insert(s("apiKey"), s(&env_name(&input.id)));
    put(
        &mut m,
        "authHeader",
        (input.api != "anthropic-messages").then_some(Value::Bool(true)),
    );
    let old_models: &[Value] = existing
        .and_then(|e| e.get("models"))
        .and_then(Value::as_sequence)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let models = input
        .models
        .iter()
        .map(|model| {
            let old = old_models
                .iter()
                .find(|o| str_field(o, "id").trim() == model.id.trim());
            model_entry(model, old)
        })
        .collect::<Result<Vec<_>, _>>()?;
    m.insert(s("models"), Value::Sequence(models));
    Ok(Value::Mapping(m))
}

/// Sets providers.<id>, leaving every other key and provider untouched.
fn set_provider(doc: &mut Value, input: &ProviderInput) -> Result<(), String> {
    let root = doc
        .as_mapping_mut()
        .ok_or_else(|| "Настройки агента: корень должен быть словарём".to_string())?;
    let key = s("providers");
    if root.get(&key).map_or(true, Value::is_null) {
        root.insert(key.clone(), empty_doc());
    }
    let providers = root
        .get_mut(&key)
        .and_then(Value::as_mapping_mut)
        .ok_or_else(|| "Настройки агента: providers должен быть словарём".to_string())?;

    // Two ids that differ only in case or punctuation would share one env var.
    let env = env_name(&input.id);
    let clash = providers.iter().find(|(k, v)| {
        k.as_str() != Some(input.id.as_str()) && str_field(v, "apiKey") == env
    });
    if let Some((other, _)) = clash {
        return Err(format!(
            "ID конфликтует с провайдером «{}»: их переменные окружения совпадают",
            other.as_str().unwrap_or("?")
        ));
    }

    let existing = providers.get(input.id.as_str()).cloned();
    let entry = provider_entry(input, existing.as_ref())?;
    providers.insert(s(&input.id), entry);
    Ok(())
}

/// Removes providers.<id>. Returns true when something was removed.
fn unset_provider(doc: &mut Value, id: &str) -> bool {
    let Some(providers) = doc.get_mut("providers").and_then(Value::as_mapping_mut) else {
        return false;
    };
    providers.shift_remove(id).is_some()
}

/// Keeps the user's original file (comments included) once, before the first write.
fn ensure_backup(path: &Path) -> Result<(), String> {
    let backup = path.with_file_name(BACKUP_NAME);
    if path.is_file() && !backup.exists() {
        fs::copy(path, &backup).map_err(|e| format!("Не удалось сделать резервную копию: {e}"))?;
        set_private(&backup)?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_private(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("Не удалось выставить права на {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_private(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Writes `<file>.tmp` with mode 0600, then renames it over the target.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Некорректный путь к настройкам агента".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Не удалось создать {}: {e}", dir.display()))?;

    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);

    let io_err = |e: io::Error| format!("Не удалось записать настройки агента: {e}");
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
    set_private(&tmp)?;
    fs::rename(&tmp, path).map_err(io_err)
}

fn commit(path: &Path, doc: &Value) -> Result<(), String> {
    ensure_backup(path)?;
    let text = serde_yaml::to_string(doc).map_err(|e| format!("Не удалось записать настройки агента: {e}"))?;
    write_atomic(path, &text)
}

fn write_provider(path: &Path, input: &ProviderInput) -> Result<(), String> {
    let mut doc = load_doc(path)?;
    set_provider(&mut doc, input)?;
    commit(path, &doc)
}

fn remove_provider(path: &Path, id: &str) -> Result<(), String> {
    let mut doc = load_doc(path)?;
    if unset_provider(&mut doc, id) {
        commit(path, &doc)
    } else {
        Ok(())
    }
}

/// Sets (Some) or removes (None) the `cost` of one model. Removing it returns the
/// model to the engine's catalog price. Everything else in the file is kept.
fn set_model_cost_at(
    path: &Path,
    provider: &str,
    model: &str,
    cost: Option<&ModelCost>,
) -> Result<(), String> {
    if let Some(cost) = cost {
        validate_cost(cost)?;
    }
    let mut doc = load_doc(path)?;
    let entry = doc
        .get_mut("providers")
        .and_then(Value::as_mapping_mut)
        .and_then(|providers| providers.get_mut(provider))
        .ok_or_else(|| "Провайдер не найден".to_string())?;
    let target = entry
        .get_mut("models")
        .and_then(Value::as_sequence_mut)
        .and_then(|models| models.iter_mut().find(|m| str_field(m, "id") == model))
        .ok_or_else(|| "Модель не найдена".to_string())?;
    let fields = target
        .as_mapping_mut()
        .ok_or_else(|| "Модель не найдена".to_string())?;
    put(fields, "cost", cost.map(cost_value).transpose()?);
    commit(path, &doc)
}

// ---------- keychain ----------

fn account(id: &str) -> String {
    format!("provider:{id}")
}

fn keychain_entry(id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &account(id)).map_err(|e| format!("Keychain: {e}"))
}

fn keychain_get(id: &str) -> Option<String> {
    keychain_entry(id)
        .ok()?
        .get_password()
        .ok()
        .filter(|k| !k.is_empty())
}

fn keychain_set(id: &str, key: &str) -> Result<(), String> {
    keychain_entry(id)?
        .set_password(key)
        .map_err(|e| format!("Не удалось сохранить ключ в Keychain: {e}"))
}

fn keychain_delete(id: &str) -> Result<(), String> {
    match keychain_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Не удалось удалить ключ из Keychain: {e}")),
    }
}

// ---------- validation and discovery ----------

fn validate(input: &ProviderInput) -> Result<(), String> {
    if !valid_id(&input.id) {
        return Err("ID провайдера: только латиница, цифры, - и _".to_string());
    }
    validate_base_url(&input.base_url)?;
    if !APIS.contains(&input.api.as_str()) {
        return Err(format!("Неизвестный тип API: {}", input.api));
    }
    if input.models.is_empty() {
        return Err("Добавьте хотя бы одну модель".to_string());
    }
    if input.models.iter().any(|m| m.id.trim().is_empty()) {
        return Err("У модели пустой id".to_string());
    }
    input.models.iter().filter_map(|m| m.cost.as_ref()).try_for_each(validate_cost)
}

/// Prices are USD per 1M tokens: finite, 0..=10000. The threshold is 1..=10000000 tokens.
fn validate_cost(cost: &ModelCost) -> Result<(), String> {
    let mut prices = vec![cost.input, cost.output, cost.cache_read, cost.cache_write];
    if let Some(lc) = &cost.long_context {
        if !(1..=MAX_INPUT_THRESHOLD).contains(&lc.input_threshold) {
            return Err("Порог длинного контекста должен быть от 1 до 10000000".to_string());
        }
        prices.extend([lc.input, lc.output, lc.cache_read, lc.cache_write]);
    }
    let ok = prices.iter().all(|p| p.is_finite() && (0.0..=MAX_PRICE).contains(p));
    if ok {
        Ok(())
    } else {
        Err("Цены должны быть числами от 0 до 10000".to_string())
    }
}

fn validate_base_url(base_url: &str) -> Result<(), String> {
    let url = base_url.trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err("Адрес должен начинаться с http:// или https://".to_string())
    }
}

/// Accepts `{ "data": [ { "id": ... } ] }` or a bare `[ { "id": ... } ]`.
fn parse_model_ids(json: &JsonValue) -> Option<Vec<String>> {
    let items = match json {
        JsonValue::Object(map) => map.get("data")?.as_array()?,
        JsonValue::Array(items) => items,
        _ => return None,
    };
    let mut ids: Vec<String> = items
        .iter()
        .filter_map(|m| m.get("id")?.as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    ids.sort();
    ids.dedup();
    Some(ids)
}

fn discover(base_url: &str, api: &str, api_key: &str) -> Result<Vec<String>, String> {
    validate_base_url(base_url)?;
    let url = format!("{}/models", base_url.trim().trim_end_matches('/'));
    // ureq 3 turns 4xx/5xx into errors by default; we want the body of those responses.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut req = agent.get(&url);
    if api == "anthropic-messages" {
        req = req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.header("Authorization", &format!("Bearer {api_key}"));
    }

    let mut resp = req
        .call()
        .map_err(|e| format!("Не удалось подключиться: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let body = resp.body_mut().read_to_string().unwrap_or_default();
        let head: String = body.chars().take(200).collect();
        return Err(format!("Сервер ответил {code}: {head}"));
    }
    let json: JsonValue = resp
        .body_mut()
        .read_json()
        .map_err(|_| "Сервер вернул не список моделей".to_string())?;
    parse_model_ids(&json).ok_or_else(|| "Сервер вернул не список моделей".to_string())
}

// ---------- Tauri commands and public API ----------

#[tauri::command]
pub async fn providers_list() -> Result<Vec<ProviderInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let doc = load_doc(&models_path()?)?;
        Ok(list_providers(&doc))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn provider_discover(
    base_url: String,
    api: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || discover(&base_url, &api, &api_key))
        .await
        .map_err(|e| format!("Внутренняя ошибка: {e}"))?
}

#[tauri::command]
pub fn provider_save(input: ProviderInput) -> Result<(), String> {
    validate(&input)?;
    let path = models_path()?;

    // Store the key first so a keychain failure leaves models.yml untouched.
    let key = input.api_key.as_deref().map(str::trim).unwrap_or("");
    if !key.is_empty() {
        keychain_set(&input.id, key)?;
    } else if keychain_get(&input.id).is_none() {
        return Err("Нужен API-ключ".to_string());
    }

    write_provider(&path, &input)
}

#[tauri::command]
pub fn provider_remove(id: String) -> Result<(), String> {
    let path = models_path()?;
    remove_provider(&path, &id)?;
    keychain_delete(&id)
}

/// Sets a model's price, or with `None` returns it to the engine's catalog price.
#[tauri::command]
pub fn model_cost_set(
    provider: String,
    model: String,
    cost: Option<ModelCost>,
) -> Result<(), String> {
    let path = models_path()?;
    set_model_cost_at(&path, &provider, &model, cost.as_ref())
}

/// For omp.rs: env vars to inject when spawning omp, one per managed provider whose key exists in Keychain.
pub fn env_pairs() -> Vec<(String, String)> {
    let Ok(path) = models_path() else {
        return Vec::new();
    };
    let Ok(doc) = load_doc(&path) else {
        return Vec::new();
    };
    let Some(map) = providers_map(&doc) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(key, entry)| {
            let id = key.as_str()?;
            let env = str_field(entry, "apiKey");
            if !env.starts_with(KEY_PREFIX) || !is_env_name(&env) {
                return None;
            }
            keychain_get(id).map(|secret| (env, secret))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "octopus-providers-test-{}-{name}",
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

    fn model(id: &str) -> ProviderModel {
        ProviderModel {
            id: id.to_string(),
            name: Some("6 Luna".to_string()),
            context_window: Some(272_000),
            max_tokens: Some(128_000),
            cost: None,
        }
    }

    fn priced() -> ModelCost {
        ModelCost {
            input: 2.5,
            output: 15.0,
            cache_read: 0.25,
            cache_write: 0.0,
            long_context: Some(LongContextCost {
                input_threshold: 272_000,
                input: 5.0,
                output: 22.5,
                cache_read: 0.5,
                cache_write: 0.0,
            }),
        }
    }

    fn write_text(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn input(id: &str, api: &str) -> ProviderInput {
        ProviderInput {
            id: id.to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            api: api.to_string(),
            api_key: None,
            models: vec![model("gpt-6-luna")],
        }
    }

    #[test]
    fn parses_both_discover_shapes() {
        let wrapped: JsonValue =
            serde_json::from_str(r#"{"data":[{"id":"b"},{"id":"a"},{"id":"a"}]}"#).unwrap();
        assert_eq!(parse_model_ids(&wrapped).unwrap(), vec!["a", "b"]);

        let bare: JsonValue = serde_json::from_str(r#"[{"id":"x"}, {"id":" y "}]"#).unwrap();
        assert_eq!(parse_model_ids(&bare).unwrap(), vec!["x", "y"]);

        let bad: JsonValue = serde_json::from_str(r#"{"error":"nope"}"#).unwrap();
        assert!(parse_model_ids(&bad).is_none());
    }

    #[test]
    fn env_names_and_key_sources() {
        assert_eq!(env_name("my-prov"), "OCTOPUS_KEY_MY_PROV");
        assert_eq!(env_name("wikivibe"), "OCTOPUS_KEY_WIKIVIBE");
        assert_eq!(key_source(""), "none");
        assert_eq!(key_source("!pass show x"), "command");
        assert_eq!(key_source("OCTOPUS_KEY_X"), "octopus");
        assert_eq!(key_source("OPENAI_API_KEY"), "env");
        assert_eq!(key_source("sk-literal"), "literal");
    }

    #[test]
    fn ids_are_validated() {
        assert!(valid_id("wikivibe"));
        assert!(valid_id("a-b_1"));
        assert!(!valid_id(""));
        assert!(!valid_id("-abc"));
        assert!(!valid_id("Abc"));
        assert!(!valid_id(&"a".repeat(42)));
    }

    #[test]
    fn save_and_remove_keep_other_content() {
        let dir = TempDir::new("merge");
        let path = models_path_in(&dir.0);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            "# user comment\ndefaultModel: foo\nproviders:\n  other:\n    baseUrl: https://x\n    apiKey: sk-literal\n    models:\n      - id: m1\n",
        )
        .unwrap();

        write_provider(&path, &input("wikivibe", "openai-completions")).unwrap();

        // The first write keeps the untouched original, comments included.
        let backup = path.with_file_name(BACKUP_NAME);
        assert!(fs::read_to_string(&backup).unwrap().contains("# user comment"));

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("defaultModel: foo"));
        assert!(text.contains("sk-literal"));
        assert!(text.contains("OCTOPUS_KEY_WIKIVIBE"));

        let doc = load_doc(&path).unwrap();
        let list = list_providers(&doc);
        let ids: Vec<&str> = list.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["other", "wikivibe"]);
        let wiki = list.iter().find(|p| p.id == "wikivibe").unwrap();
        assert!(wiki.managed);
        assert_eq!(wiki.key_source, "octopus");
        assert_eq!(wiki.models[0].context_window, Some(272_000));
        assert_eq!(list[0].key_source, "literal");

        // A second write must not replace the backup.
        write_provider(&path, &input("second", "anthropic-messages")).unwrap();
        assert!(fs::read_to_string(&backup).unwrap().contains("# user comment"));

        let doc = load_doc(&path).unwrap();
        let anthropic = list_providers(&doc)
            .into_iter()
            .find(|p| p.id == "second")
            .unwrap();
        assert_eq!(anthropic.api, "anthropic-messages");
        let entry = providers_map(&doc).unwrap().get("second").unwrap();
        assert!(entry.get("authHeader").is_none());

        remove_provider(&path, "wikivibe").unwrap();
        remove_provider(&path, "wikivibe").unwrap();
        let doc = load_doc(&path).unwrap();
        let ids: Vec<String> = list_providers(&doc).into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["other", "second"]);
        assert!(fs::read_to_string(&path).unwrap().contains("defaultModel: foo"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn missing_file_is_no_providers_and_gets_created() {
        let dir = TempDir::new("missing");
        let path = models_path_in(&dir.0);
        assert!(list_providers(&load_doc(&path).unwrap()).is_empty());

        // Removing from a missing file is a no-op and must not create it.
        remove_provider(&path, "nothing").unwrap();
        assert!(!path.exists());

        write_provider(&path, &input("fresh", "openai-responses")).unwrap();
        assert!(path.is_file());
        assert!(!path.with_file_name(BACKUP_NAME).exists());
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("authHeader: true"));
    }

    #[test]
    fn corrupt_file_is_never_overwritten() {
        let dir = TempDir::new("corrupt");
        let path = models_path_in(&dir.0);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "providers: [unclosed").unwrap();
        assert!(write_provider(&path, &input("x", "openai-completions")).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "providers: [unclosed");
    }

    #[test]
    fn id_collision_is_rejected() {
        let dir = TempDir::new("collision");
        let path = models_path_in(&dir.0);
        write_provider(&path, &input("a-b", "openai-completions")).unwrap();
        assert!(write_provider(&path, &input("a_b", "openai-completions")).is_err());
    }

    #[test]
    fn provider_save_keeps_model_cost_and_unknown_keys() {
        let dir = TempDir::new("keep-cost");
        let path = models_path_in(&dir.0);
        write_text(
            &path,
            "providers:\n  wikivibe:\n    baseUrl: https://api.wikivibe.ru/v1\n    api: openai-completions\n    apiKey: OCTOPUS_KEY_WIKIVIBE\n    headers:\n      X-Team: ops\n    models:\n      - id: gpt-6-luna\n        name: 6 Luna\n        contextWindow: 272000\n        note: keep me\n        cost:\n          input: 2.5\n          output: 15\n          cacheRead: 0.25\n          cacheWrite: 0\n      - id: gpt-6-sol\n",
        );

        // The form knows nothing about cost: it must survive the save.
        let mut form = input("wikivibe", "openai-completions");
        form.models = vec![ProviderModel { max_tokens: None, ..model("gpt-6-luna") }];
        write_provider(&path, &form).unwrap();

        let doc = load_doc(&path).unwrap();
        let m = &doc["providers"]["wikivibe"]["models"][0];
        assert_eq!(m["note"].as_str(), Some("keep me"));
        assert_eq!(m["cost"]["cacheRead"].as_f64(), Some(0.25));
        assert_eq!(m["cost"]["output"].as_f64(), Some(15.0));
        assert!(m.get("maxTokens").is_none());
        assert_eq!(doc["providers"]["wikivibe"]["headers"]["X-Team"].as_str(), Some("ops"));
        // gpt-6-sol left the form, so it is removed.
        assert_eq!(doc["providers"]["wikivibe"]["models"].as_sequence().unwrap().len(), 1);

        let list = list_providers(&doc);
        let stored = list[0].models[0].cost.clone().unwrap();
        assert_eq!(stored.input, 2.5);
        assert!(stored.long_context.is_none());

        // A cost set in the form replaces the stored one.
        let mut repriced = priced();
        repriced.input = 1.0;
        form.models[0].cost = Some(repriced.clone());
        write_provider(&path, &form).unwrap();
        let doc = load_doc(&path).unwrap();
        let list = list_providers(&doc);
        assert_eq!(list[0].models[0].cost, Some(repriced));
        assert_eq!(doc["providers"]["wikivibe"]["models"][0]["note"].as_str(), Some("keep me"));
    }

    #[test]
    fn malformed_cost_keeps_model_visible_and_in_file() {
        let dir = TempDir::new("bad-cost");
        let path = models_path_in(&dir.0);
        write_text(
            &path,
            "providers:\n  wikivibe:\n    baseUrl: https://x\n    api: openai-completions\n    apiKey: OCTOPUS_KEY_WIKIVIBE\n    models:\n      - id: gpt-6-luna\n        cost: oops\n",
        );
        let list = list_providers(&load_doc(&path).unwrap());
        assert_eq!(list[0].models.len(), 1);
        assert!(list[0].models[0].cost.is_none());

        write_provider(&path, &input("wikivibe", "openai-completions")).unwrap();
        let doc = load_doc(&path).unwrap();
        assert_eq!(doc["providers"]["wikivibe"]["models"][0]["cost"].as_str(), Some("oops"));
    }

    #[test]
    fn model_cost_set_overwrite_and_remove() {
        let dir = TempDir::new("cost-set");
        let path = models_path_in(&dir.0);
        write_provider(&path, &input("wikivibe", "openai-completions")).unwrap();

        set_model_cost_at(&path, "wikivibe", "gpt-6-luna", Some(&priced())).unwrap();
        let list = list_providers(&load_doc(&path).unwrap());
        assert_eq!(list[0].models[0].cost, Some(priced()));

        let mut again = priced();
        again.input = 3.0;
        again.long_context = None;
        set_model_cost_at(&path, "wikivibe", "gpt-6-luna", Some(&again)).unwrap();
        let list = list_providers(&load_doc(&path).unwrap());
        assert_eq!(list[0].models[0].cost, Some(again));

        set_model_cost_at(&path, "wikivibe", "gpt-6-luna", None).unwrap();
        let doc = load_doc(&path).unwrap();
        let m = &doc["providers"]["wikivibe"]["models"][0];
        assert!(m.get("cost").is_none());
        // Everything else on the model stays.
        assert_eq!(m["name"].as_str(), Some("6 Luna"));
        assert_eq!(m["contextWindow"].as_u64(), Some(272_000));
        assert_eq!(m["maxTokens"].as_u64(), Some(128_000));
    }

    #[test]
    fn model_cost_long_context_roundtrip_and_float_tidy() {
        let dir = TempDir::new("cost-roundtrip");
        let path = models_path_in(&dir.0);
        write_provider(&path, &input("wikivibe", "openai-completions")).unwrap();

        set_model_cost_at(&path, "wikivibe", "gpt-6-luna", Some(&priced())).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("inputThreshold: 272000"));
        assert!(text.contains("longContext:"));

        let noisy = ModelCost {
            input: 0.1 + 0.2,
            output: 8.0,
            cache_read: 0.0,
            cache_write: 0.0,
            long_context: None,
        };
        set_model_cost_at(&path, "wikivibe", "gpt-6-luna", Some(&noisy)).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("input: 0.3\n"), "{text}");
        assert!(!text.contains("0.30000000000000004"));
        let stored = list_providers(&load_doc(&path).unwrap())[0].models[0].cost.clone();
        assert_eq!(stored.unwrap().input, 0.3);
    }

    #[test]
    fn hand_written_integer_prices_parse() {
        let dir = TempDir::new("cost-ints");
        let path = models_path_in(&dir.0);
        write_text(
            &path,
            "providers:\n  wikivibe:\n    baseUrl: https://x\n    api: openai-completions\n    apiKey: sk-literal\n    models:\n      - id: gpt-6-luna\n        cost:\n          input: 2\n          output: 8\n          cacheRead: 0\n          cacheWrite: 0\n          longContext:\n            inputThreshold: 200000\n            input: 4\n            output: 12\n            cacheRead: 0\n            cacheWrite: 0\n",
        );
        let list = list_providers(&load_doc(&path).unwrap());
        let cost = list[0].models[0].cost.clone().unwrap();
        assert_eq!(cost.output, 8.0);
        assert_eq!(cost.long_context.unwrap().input_threshold, 200_000);
    }

    #[test]
    fn model_cost_invalid_values_are_rejected() {
        let dir = TempDir::new("cost-invalid");
        let path = models_path_in(&dir.0);
        write_provider(&path, &input("wikivibe", "openai-completions")).unwrap();
        let before = fs::read_to_string(&path).unwrap();

        let base = || ModelCost {
            input: 1.0,
            output: 1.0,
            cache_read: 1.0,
            cache_write: 1.0,
            long_context: None,
        };
        let long = |threshold: u64, price: f64| {
            let mut c = base();
            c.long_context = Some(LongContextCost {
                input_threshold: threshold,
                input: price,
                output: 1.0,
                cache_read: 1.0,
                cache_write: 1.0,
            });
            c
        };
        let bad = vec![
            ModelCost { input: f64::NAN, ..base() },
            ModelCost { output: f64::INFINITY, ..base() },
            ModelCost { cache_read: -0.01, ..base() },
            ModelCost { cache_write: 10_000.5, ..base() },
            long(0, 1.0),
            long(10_000_001, 1.0),
            long(200_000, -1.0),
            long(200_000, 20_000.0),
        ];
        for cost in &bad {
            assert!(set_model_cost_at(&path, "wikivibe", "gpt-6-luna", Some(cost)).is_err());
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), before);

        // Boundaries and a free model are valid.
        let free = ModelCost { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0, long_context: None };
        set_model_cost_at(&path, "wikivibe", "gpt-6-luna", Some(&free)).unwrap();
        let edge = ModelCost { input: 10_000.0, ..long(10_000_000, 0.0) };
        set_model_cost_at(&path, "wikivibe", "gpt-6-luna", Some(&edge)).unwrap();
        set_model_cost_at(&path, "wikivibe", "gpt-6-luna", Some(&long(1, 0.0))).unwrap();

        // provider_save validates the same prices.
        let mut form = input("wikivibe", "openai-completions");
        form.models[0].cost = Some(ModelCost { input: f64::NAN, ..base() });
        assert!(validate(&form).is_err());
    }

    #[test]
    fn model_cost_unknown_provider_or_model_is_rejected() {
        let dir = TempDir::new("cost-unknown");
        let path = models_path_in(&dir.0);
        assert_eq!(
            set_model_cost_at(&path, "wikivibe", "gpt-6-luna", Some(&priced())).unwrap_err(),
            "Провайдер не найден"
        );
        assert!(!path.exists());

        write_provider(&path, &input("wikivibe", "openai-completions")).unwrap();
        let before = fs::read_to_string(&path).unwrap();
        assert_eq!(
            set_model_cost_at(&path, "nope", "gpt-6-luna", Some(&priced())).unwrap_err(),
            "Провайдер не найден"
        );
        assert_eq!(
            set_model_cost_at(&path, "wikivibe", "gpt-9", None).unwrap_err(),
            "Модель не найдена"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn model_cost_leaves_other_providers_untouched() {
        let dir = TempDir::new("cost-others");
        let path = models_path_in(&dir.0);
        write_text(
            &path,
            "# user comment\ndefaultModel: foo\nproviders:\n  other:\n    baseUrl: https://x\n    apiKey: sk-literal\n    custom: yes\n    models:\n      - id: gpt-6-luna\n        cost:\n          input: 9\n          output: 9\n          cacheRead: 0\n          cacheWrite: 0\n  wikivibe:\n    baseUrl: https://api.wikivibe.ru/v1\n    api: openai-completions\n    apiKey: OCTOPUS_KEY_WIKIVIBE\n    models:\n      - id: gpt-6-luna\n      - id: gpt-6-sol\n        cost:\n          input: 4\n          output: 4\n          cacheRead: 0\n          cacheWrite: 0\n",
        );

        set_model_cost_at(&path, "wikivibe", "gpt-6-luna", Some(&priced())).unwrap();
        let doc = load_doc(&path).unwrap();
        assert_eq!(doc["defaultModel"].as_str(), Some("foo"));
        assert_eq!(doc["providers"]["other"]["custom"].as_str(), Some("yes"));
        assert_eq!(doc["providers"]["other"]["models"][0]["cost"]["input"].as_f64(), Some(9.0));
        assert_eq!(doc["providers"]["wikivibe"]["models"][1]["cost"]["input"].as_f64(), Some(4.0));
        assert_eq!(doc["providers"]["wikivibe"]["models"][0]["cost"]["input"].as_f64(), Some(2.5));

        set_model_cost_at(&path, "wikivibe", "gpt-6-sol", None).unwrap();
        let doc = load_doc(&path).unwrap();
        assert!(doc["providers"]["wikivibe"]["models"][1].get("cost").is_none());
        assert_eq!(doc["providers"]["wikivibe"]["models"][0]["cost"]["input"].as_f64(), Some(2.5));
        assert_eq!(doc["providers"]["other"]["models"][0]["cost"]["input"].as_f64(), Some(9.0));
    }

    /// Answers one HTTP request on a local port with `response`; returns the base
    /// URL and a handle that yields the request head the server received.
    fn serve_once(response: impl AsRef<str> + Send + 'static) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            stream.write_all(response.as_ref().as_bytes()).unwrap();
            String::from_utf8_lossy(&buf[..n]).to_lowercase()
        });
        (url, handle)
    }

    fn ok_models() -> String {
        let body = r#"{"data":[{"id":"m-b"},{"id":"m-a"}]}"#;
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn discover_sends_bearer_key_and_parses_models() {
        let (url, req) = serve_once(ok_models());
        let ids = discover(&url, "openai-completions", "sk-test").unwrap();
        assert_eq!(ids, vec!["m-a", "m-b"]);
        let head = req.join().unwrap();
        assert!(head.starts_with("get /models "), "{head}");
        assert!(head.contains("authorization: bearer sk-test"), "{head}");
    }

    #[test]
    fn discover_uses_anthropic_headers() {
        let (url, req) = serve_once(ok_models());
        discover(&url, "anthropic-messages", "sk-ant").unwrap();
        let head = req.join().unwrap();
        assert!(head.contains("x-api-key: sk-ant"), "{head}");
        assert!(head.contains("anthropic-version: 2023-06-01"), "{head}");
        assert!(!head.contains("authorization:"), "{head}");
    }

    #[test]
    fn discover_reports_status_and_body_of_error_responses() {
        let (url, req) = serve_once(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 7\r\nConnection: close\r\n\r\nbad key",
        );
        let err = discover(&url, "openai-completions", "nope").unwrap_err();
        req.join().unwrap();
        assert!(err.contains("401") && err.contains("bad key"), "{err}");
    }

    #[test]
    fn discover_rejects_a_non_model_list() {
        let (url, req) = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\n<html>hi</html>",
        );
        let err = discover(&url, "openai-completions", "k").unwrap_err();
        req.join().unwrap();
        assert_eq!(err, "Сервер вернул не список моделей");
    }

    #[test]
    fn discover_reports_a_refused_connection() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let err = discover(&format!("http://127.0.0.1:{port}"), "openai-completions", "k")
            .unwrap_err();
        assert!(err.starts_with("Не удалось подключиться"), "{err}");
    }
}
