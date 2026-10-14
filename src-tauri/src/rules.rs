//! Rules: Markdown files with YAML frontmatter that the agent engine reads. Own rules live in
//! `<project>/.omp/rules/*.md` and `<home>/.omp/agent/rules/*.md`; rules of other tools
//! (`.cursor/rules`, `.agents/rules`, `.agent/rules`) are listed read-only. A rule is saved with
//! its frontmatter keys the editor does not know kept as they are.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

const MAX_SIZE: u64 = 1024 * 1024;
const NAME_MAX: usize = 64;
const TOO_LARGE: &str = "Правила: файл слишком большой";
const NOT_FOUND: &str = "Правила: правило не найдено";
const CONFLICT: &str = "Правила: правило с таким именем уже есть";
const BAD_NAME: &str =
    "Правила: имя может содержать латинские строчные буквы, цифры, «-» и «_» (до 64 символов)";
const NEEDS_DESCRIPTION: &str = "Правила: правилу «по теме» нужно описание";
const NO_PROJECT: &str = "Правила: папка проекта не найдена";
const UNKNOWN_SCOPE: &str = "Правила: неизвестная область";
const PROJECT_RULES: &str = ".omp/rules";
const GLOBAL_RULES: &str = ".omp/agent/rules";
/// Rules of other tools that the engine also reads: folder and file extensions.
const FOREIGN_FOLDERS: [(&str, &[&str]); 3] = [
    (".cursor/rules", &["mdc", "md"]),
    (".agents/rules", &["md"]),
    (".agent/rules", &["md"]),
];
/// Frontmatter keys that make a rule a special stream-triggered rule.
const SPECIAL_KEYS: [&str; 3] = ["condition", "astCondition", "question"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub name: String,
    /// "project", "global" or "foreign".
    pub scope: String,
    /// Foreign only: path relative to the project. For own rules "<name>.md".
    pub rel: String,
    pub always: bool,
    pub description: Option<String>,
    pub globs: Vec<String>,
    pub enabled: bool,
    /// Has condition, astCondition or question.
    pub special: bool,
    /// Enabled, not always, no description and not special: the engine never uses it.
    pub ignored: bool,
    /// A global rule whose name also exists as a project rule.
    pub overridden: bool,
    /// Content after the frontmatter. Empty when the file is larger than 1 MB.
    pub body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesList {
    pub project: Vec<Rule>,
    pub global: Vec<Rule>,
    pub foreign: Vec<Rule>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleInput {
    pub name: String,
    pub always: bool,
    pub description: String,
    pub globs: Vec<String>,
    pub enabled: bool,
    pub body: String,
}

// ---------- paths and names ----------

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Правила: не найден $HOME".to_string())
}

fn cwd_of(cwd: &Option<String>) -> Option<PathBuf> {
    cwd.as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(PathBuf::from)
}

/// Folder of the own rules a save or delete writes to.
fn rules_dir(home: &Path, cwd: Option<&Path>, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(home.join(GLOBAL_RULES)),
        "project" => cwd
            .filter(|dir| dir.is_dir())
            .map(|dir| dir.join(PROJECT_RULES))
            .ok_or_else(|| NO_PROJECT.to_string()),
        _ => Err(UNKNOWN_SCOPE.to_string()),
    }
}

/// 1 to 64 characters: a-z, 0-9, "-" and "_", the first one a-z or 0-9.
fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() <= NAME_MAX
        && bytes
            .first()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
}

/// The name of the file being edited: any plain file name, so that a rule created by hand
/// (with capitals, for example) can still be edited.
fn plain_stem(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

// ---------- reading ----------

/// Reads the first 1 MB of a file as text. The flag tells whether the file is larger.
/// Invalid UTF-8 is replaced, so that the file still shows up in the list.
fn read_capped(path: &Path) -> io::Result<(String, bool)> {
    let mut buf = Vec::new();
    fs::File::open(path)?
        .take(MAX_SIZE + 1)
        .read_to_end(&mut buf)?;
    let oversized = buf.len() as u64 > MAX_SIZE;
    buf.truncate(MAX_SIZE as usize);
    Ok((String::from_utf8_lossy(&buf).into_owned(), oversized))
}

fn is_delimiter(line: &str) -> bool {
    line.trim_end_matches(['\r', '\n']) == "---"
}

/// Splits a file into its frontmatter text (None without a frontmatter block) and the rest.
/// The frontmatter starts at a first line "---" and ends at the next line "---".
fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    let Some(first) = text.split_inclusive('\n').next() else {
        return (None, text);
    };
    if !is_delimiter(first) {
        return (None, text);
    }
    let yaml_start = first.len();
    let mut pos = yaml_start;
    for line in text[yaml_start..].split_inclusive('\n') {
        if is_delimiter(line) {
            return (Some(&text[yaml_start..pos]), &text[pos + line.len()..]);
        }
        pos += line.len();
    }
    (None, text)
}

/// Frontmatter as a mapping. Invalid YAML or a non-mapping counts as empty.
fn parse_frontmatter(yaml: Option<&str>) -> Mapping {
    match yaml.map(serde_yaml::from_str::<Value>) {
        Some(Ok(Value::Mapping(map))) => map,
        _ => Mapping::new(),
    }
}

/// Trims, drops empty entries.
fn clean_globs<'a>(items: impl Iterator<Item = &'a str>) -> Vec<String> {
    items
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .map(str::to_string)
        .collect()
}

fn load_rule(name: String, scope: &str, rel: String, path: &Path) -> Rule {
    let (text, oversized) = read_capped(path).unwrap_or_default();
    let (yaml, rest) = split_frontmatter(&text);
    let fm = parse_frontmatter(yaml);

    let always = fm.get("alwaysApply").and_then(Value::as_bool) == Some(true);
    let description = fm
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string);
    let globs = match fm.get("globs") {
        Some(Value::Sequence(items)) => clean_globs(items.iter().filter_map(Value::as_str)),
        Some(Value::String(one)) => clean_globs(std::iter::once(one.as_str())),
        _ => Vec::new(),
    };
    let enabled = fm.get("enabled").and_then(Value::as_bool) != Some(false);
    let special = SPECIAL_KEYS.iter().any(|key| fm.contains_key(*key));
    let no_description = description.as_deref().is_none_or(|d| d.trim().is_empty());
    let ignored = enabled && !always && no_description && !special;
    let body = if oversized {
        String::new()
    } else {
        rest.trim_start_matches(['\r', '\n']).to_string()
    };

    Rule {
        name,
        scope: scope.to_string(),
        rel,
        always,
        description,
        globs,
        enabled,
        special,
        ignored,
        overridden: false,
        body,
    }
}

/// Files in `dir` with one of the extensions, as (file name, name without extension, path).
fn rule_files(dir: &Path, exts: &[&str]) -> Vec<(String, String, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let file = entry.file_name().into_string().ok()?;
            let (stem, ext) = file.rsplit_once('.')?;
            if stem.is_empty() || !exts.contains(&ext) {
                return None;
            }
            let stem = stem.to_string();
            let path = entry.path();
            fs::metadata(&path)
                .ok()?
                .is_file()
                .then_some((file, stem, path))
        })
        .collect()
}

fn scan_own(dir: &Path, scope: &str) -> Vec<Rule> {
    rule_files(dir, &["md"])
        .into_iter()
        .map(|(file, name, path)| load_rule(name, scope, file, &path))
        .collect()
}

fn scan_foreign(project: &Path) -> Vec<Rule> {
    FOREIGN_FOLDERS
        .iter()
        .flat_map(|&(folder, exts)| {
            rule_files(&project.join(folder), exts)
                .into_iter()
                .map(move |(file, name, path)| {
                    load_rule(name, "foreign", format!("{folder}/{file}"), &path)
                })
        })
        .collect()
}

fn sort_rules(rules: &mut [Rule]) {
    rules.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.rel.cmp(&b.rel)));
}

/// Lists the rules. Unreadable or invalid files are listed with what can be read.
fn list_in(home: &Path, cwd: Option<&Path>) -> RulesList {
    let mut global = scan_own(&home.join(GLOBAL_RULES), "global");
    let mut project = cwd
        .map(|dir| scan_own(&dir.join(PROJECT_RULES), "project"))
        .unwrap_or_default();
    let mut foreign = cwd.map(scan_foreign).unwrap_or_default();

    for rule in &mut global {
        // A disabled project rule is not loaded, so the general one applies again
        // (verified against the engine); an ignored-but-enabled one still hides it.
        rule.overridden = project.iter().any(|p| p.name == rule.name && p.enabled);
    }
    for list in [&mut global, &mut project, &mut foreign] {
        sort_rules(list);
    }
    RulesList {
        project,
        global,
        foreign,
    }
}

fn read_error(e: io::Error) -> String {
    if e.kind() == io::ErrorKind::NotFound {
        NOT_FOUND.to_string()
    } else {
        format!("Правила: не удалось прочитать файл: {e}")
    }
}

// ---------- saving ----------

/// Writes `text` through `<file>.octopus-tmp` and a rename, creating parent folders.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let save_err = |e: io::Error| format!("Правила: не удалось сохранить: {e}");
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(save_err)?;
    }
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".octopus-tmp");
    let tmp = PathBuf::from(tmp_name);
    let result = (|| -> io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        save_err(e)
    })
}

/// Sets a known key, or removes it when `value` is None. Replacing a key keeps its place.
fn set_key(fm: &mut Mapping, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            fm.insert(Value::String(key.to_string()), value);
        }
        None => {
            fm.shift_remove(key);
        }
    }
}

/// `---`, the frontmatter, `---`, a blank line and the body. No frontmatter block when the
/// mapping is empty.
fn render(fm: &Mapping, body: &str) -> Result<String, String> {
    let mut out = String::new();
    if !fm.is_empty() {
        let yaml = serde_yaml::to_string(fm)
            .map_err(|e| format!("Правила: не удалось собрать frontmatter: {e}"))?;
        out.push_str("---\n");
        out.push_str(&yaml);
        out.push_str("---\n");
        if !body.is_empty() {
            out.push('\n');
        }
    }
    if !body.is_empty() {
        out.push_str(body);
        out.push('\n');
    }
    Ok(out)
}

fn save_in(
    home: &Path,
    cwd: Option<&Path>,
    scope: &str,
    original: Option<&str>,
    rule: &RuleInput,
) -> Result<(), String> {
    let dir = rules_dir(home, cwd, scope)?;
    if !valid_name(&rule.name) {
        return Err(BAD_NAME.to_string());
    }
    let description = rule.description.trim();
    if !rule.always && description.is_empty() {
        return Err(NEEDS_DESCRIPTION.to_string());
    }
    if rule.body.len() as u64 > MAX_SIZE {
        return Err(TOO_LARGE.to_string());
    }
    let target = dir.join(format!("{}.md", rule.name));

    // The file being edited (renamed when its name differs) and its frontmatter.
    let (source, mut fm) = match original {
        Some(orig) => {
            if !plain_stem(orig) {
                return Err(NOT_FOUND.to_string());
            }
            let source = dir.join(format!("{orig}.md"));
            let (text, oversized) = read_capped(&source).map_err(read_error)?;
            // A larger file is not rewritten: its body is not in the editor.
            if oversized {
                return Err(TOO_LARGE.to_string());
            }
            if orig != rule.name && target.exists() {
                return Err(CONFLICT.to_string());
            }
            (Some(source), parse_frontmatter(split_frontmatter(&text).0))
        }
        None => {
            if target.exists() {
                return Err(CONFLICT.to_string());
            }
            (None, Mapping::new())
        }
    };

    set_key(
        &mut fm,
        "alwaysApply",
        rule.always.then_some(Value::Bool(true)),
    );
    set_key(
        &mut fm,
        "description",
        (!description.is_empty()).then(|| Value::String(description.to_string())),
    );
    let globs = clean_globs(rule.globs.iter().map(String::as_str));
    set_key(
        &mut fm,
        "globs",
        (!globs.is_empty())
            .then(|| Value::Sequence(globs.into_iter().map(Value::String).collect())),
    );
    set_key(
        &mut fm,
        "enabled",
        (!rule.enabled).then_some(Value::Bool(false)),
    );

    let content = render(&fm, rule.body.trim_matches(['\r', '\n']))?;
    if content.len() as u64 > MAX_SIZE {
        return Err(TOO_LARGE.to_string());
    }
    write_atomic(&target, &content)?;
    if let Some(source) = source.filter(|s| *s != target) {
        fs::remove_file(&source)
            .map_err(|e| format!("Правила: не удалось удалить старый файл: {e}"))?;
    }
    Ok(())
}

fn delete_in(home: &Path, cwd: Option<&Path>, scope: &str, name: &str) -> Result<(), String> {
    let dir = rules_dir(home, cwd, scope)?;
    if !valid_name(name) {
        return Err(BAD_NAME.to_string());
    }
    fs::remove_file(dir.join(format!("{name}.md"))).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            NOT_FOUND.to_string()
        } else {
            format!("Правила: не удалось удалить: {e}")
        }
    })
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn rules_list(cwd: Option<String>) -> Result<RulesList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = cwd_of(&cwd);
        Ok(list_in(&home_dir()?, cwd.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn rule_save(
    scope: String,
    cwd: Option<String>,
    original: Option<String>,
    rule: RuleInput,
) -> Result<(), String> {
    let cwd = cwd_of(&cwd);
    save_in(
        &home_dir()?,
        cwd.as_deref(),
        &scope,
        original.as_deref(),
        &rule,
    )
}

#[tauri::command]
pub fn rule_delete(scope: String, cwd: Option<String>, name: String) -> Result<(), String> {
    let cwd = cwd_of(&cwd);
    delete_in(&home_dir()?, cwd.as_deref(), &scope, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("octopus-rules-test-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn home(&self) -> PathBuf {
            let home = self.0.join("home");
            fs::create_dir_all(&home).unwrap();
            home
        }

        fn project(&self) -> PathBuf {
            let project = self.0.join("project");
            fs::create_dir_all(&project).unwrap();
            project
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(base: &Path, rel: &str, content: &str) {
        let path = base.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn read(base: &Path, rel: &str) -> String {
        fs::read_to_string(base.join(rel)).unwrap()
    }

    fn input(name: &str, always: bool, description: &str, body: &str) -> RuleInput {
        RuleInput {
            name: name.to_string(),
            always,
            description: description.to_string(),
            globs: Vec::new(),
            enabled: true,
            body: body.to_string(),
        }
    }

    fn global_list(home: &Path) -> Vec<Rule> {
        list_in(home, None).global
    }

    fn find<'a>(rules: &'a [Rule], name: &str) -> &'a Rule {
        rules.iter().find(|r| r.name == name).unwrap()
    }

    fn keys(text: &str) -> Vec<String> {
        let (yaml, _) = split_frontmatter(text);
        parse_frontmatter(yaml)
            .keys()
            .map(|k| k.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn file_without_frontmatter_is_ignored_rule() {
        let dir = TempDir::new("no-frontmatter");
        let home = dir.home();
        write(&home, ".omp/agent/rules/plain.md", "Просто текст\n");
        let rules = global_list(&home);
        let r = find(&rules, "plain");
        assert_eq!(r.scope, "global");
        assert_eq!(r.rel, "plain.md");
        assert!(!r.always && r.enabled && !r.special);
        assert_eq!(r.description, None);
        assert!(r.ignored);
        assert_eq!(r.body, "Просто текст\n");
    }

    #[test]
    fn parses_always_and_description() {
        let dir = TempDir::new("always-desc");
        let home = dir.home();
        write(
            &home,
            ".omp/agent/rules/a.md",
            "---\nalwaysApply: true\n---\n\n# Всегда\n",
        );
        write(
            &home,
            ".omp/agent/rules/b.md",
            "---\ndescription: Про код\n---\nтекст\n",
        );
        let rules = global_list(&home);
        let a = find(&rules, "a");
        assert!(a.always && !a.ignored);
        assert_eq!(a.body, "# Всегда\n");
        let b = find(&rules, "b");
        assert!(!b.always && !b.ignored);
        assert_eq!(b.description.as_deref(), Some("Про код"));
        assert_eq!(b.body, "текст\n");
    }

    #[test]
    fn globs_as_string_and_as_list() {
        let dir = TempDir::new("globs");
        let home = dir.home();
        write(
            &home,
            ".omp/agent/rules/s.md",
            "---\nglobs: \"*.rs\"\n---\n",
        );
        write(
            &home,
            ".omp/agent/rules/l.md",
            "---\nglobs:\n  - a\n  - \" b \"\n  - \"\"\n---\n",
        );
        let rules = global_list(&home);
        assert_eq!(find(&rules, "s").globs, vec!["*.rs"]);
        assert_eq!(find(&rules, "l").globs, vec!["a", "b"]);
    }

    #[test]
    fn enabled_false_disables_and_is_not_ignored() {
        let dir = TempDir::new("enabled-false");
        let home = dir.home();
        write(
            &home,
            ".omp/agent/rules/off.md",
            "---\nenabled: false\n---\nтекст\n",
        );
        let rules = global_list(&home);
        let r = find(&rules, "off");
        assert!(!r.enabled && !r.ignored);
    }

    #[test]
    fn special_keys_mark_special_rules() {
        let dir = TempDir::new("special");
        let home = dir.home();
        write(&home, ".omp/agent/rules/c.md", "---\ncondition: x\n---\n");
        write(
            &home,
            ".omp/agent/rules/ast.md",
            "---\nastCondition: y\n---\n",
        );
        write(&home, ".omp/agent/rules/q.md", "---\nquestion: z\n---\n");
        let rules = global_list(&home);
        for name in ["c", "ast", "q"] {
            let r = find(&rules, name);
            assert!(r.special, "{name}");
            assert!(!r.ignored, "{name}");
        }
    }

    #[test]
    fn ignored_only_for_plain_topic_rule_without_description() {
        let dir = TempDir::new("ignored");
        let home = dir.home();
        write(
            &home,
            ".omp/agent/rules/blank.md",
            "---\ndescription: \"  \"\n---\n",
        );
        write(
            &home,
            ".omp/agent/rules/empty.md",
            "---\nagents: [a]\n---\n",
        );
        write(
            &home,
            ".omp/agent/rules/desc.md",
            "---\ndescription: x\n---\n",
        );
        write(
            &home,
            ".omp/agent/rules/always.md",
            "---\nalwaysApply: true\n---\n",
        );
        let rules = global_list(&home);
        assert!(find(&rules, "blank").ignored);
        assert!(find(&rules, "empty").ignored);
        assert!(!find(&rules, "desc").ignored);
        assert!(!find(&rules, "always").ignored);
    }

    #[test]
    fn invalid_yaml_counts_as_empty_frontmatter() {
        let dir = TempDir::new("invalid-yaml");
        let home = dir.home();
        write(&home, ".omp/agent/rules/bad.md", "---\nfoo: [\n---\nтело\n");
        let rules = global_list(&home);
        let r = find(&rules, "bad");
        assert_eq!(r.body, "тело\n");
        assert_eq!(r.description, None);
        assert!(r.ignored);
    }

    #[test]
    fn body_leading_newlines_are_trimmed() {
        let dir = TempDir::new("body-trim");
        let home = dir.home();
        write(
            &home,
            ".omp/agent/rules/t.md",
            "---\nalwaysApply: true\n---\n\n\n  отступ\n",
        );
        assert_eq!(find(&global_list(&home), "t").body, "  отступ\n");
    }

    #[test]
    fn global_rule_overridden_by_project_rule_of_same_name() {
        let dir = TempDir::new("overridden");
        let (home, project) = (dir.home(), dir.project());
        write(
            &project,
            ".omp/rules/shared.md",
            "---\nalwaysApply: true\n---\n",
        );
        write(
            &home,
            ".omp/agent/rules/shared.md",
            "---\nalwaysApply: true\n---\n",
        );
        write(
            &home,
            ".omp/agent/rules/solo.md",
            "---\nalwaysApply: true\n---\n",
        );
        let list = list_in(&home, Some(&project));
        assert!(find(&list.global, "shared").overridden);
        assert!(!find(&list.global, "solo").overridden);
        assert!(!find(&list.project, "shared").overridden);
        assert_eq!(list.project[0].scope, "project");
        assert_eq!(list.project[0].rel, "shared.md");
    }

    #[test]
    fn disabled_project_rule_does_not_override() {
        let dir = TempDir::new("overridden-off");
        let (home, project) = (dir.home(), dir.project());
        write(&project, ".omp/rules/off.md", "---
alwaysApply: true
enabled: false
---
");
        write(&project, ".omp/rules/ign.md", "---
globs: [\"x\"]\n---\n");
        write(&home, ".omp/agent/rules/off.md", "---
alwaysApply: true
---
");
        write(&home, ".omp/agent/rules/ign.md", "---
alwaysApply: true
---
");
        let list = list_in(&home, Some(&project));
        assert!(!find(&list.global, "off").overridden);
        assert!(find(&list.global, "ign").overridden);
    }

    #[test]
    fn foreign_rules_from_three_folders_are_listed_read_only() {
        let dir = TempDir::new("foreign");
        let (home, project) = (dir.home(), dir.project());
        write(
            &project,
            ".cursor/rules/c.mdc",
            "---\ndescription: Cursor\n---\n",
        );
        write(
            &project,
            ".cursor/rules/d.md",
            "---\nalwaysApply: true\n---\n",
        );
        write(&project, ".cursor/rules/skip.txt", "x");
        write(&project, ".agents/rules/e.md", "tail");
        write(&project, ".agents/rules/g.mdc", "not read");
        write(&project, ".agent/rules/f.md", "---\nglobs: x\n---\n");
        let list = list_in(&home, Some(&project));
        let rels: Vec<&str> = list.foreign.iter().map(|r| r.rel.as_str()).collect();
        assert_eq!(
            rels,
            vec![
                ".cursor/rules/c.mdc",
                ".cursor/rules/d.md",
                ".agents/rules/e.md",
                ".agent/rules/f.md",
            ]
        );
        assert!(list.foreign.iter().all(|r| r.scope == "foreign"));
        let c = find(&list.foreign, "c");
        assert_eq!(c.description.as_deref(), Some("Cursor"));
        assert!(!c.ignored);
        assert!(list_in(&home, None).foreign.is_empty());
        assert!(list_in(&home, None).project.is_empty());
    }

    #[test]
    fn lists_are_sorted_by_name() {
        let dir = TempDir::new("sorting");
        let home = dir.home();
        for name in ["z", "a", "m"] {
            write(&home, &format!(".omp/agent/rules/{name}.md"), "x");
        }
        let names: Vec<String> = global_list(&home).into_iter().map(|r| r.name).collect();
        assert_eq!(names, vec!["a", "m", "z"]);
    }

    #[test]
    fn oversized_file_is_listed_with_frontmatter_and_empty_body() {
        let dir = TempDir::new("oversized-list");
        let home = dir.home();
        let text = format!(
            "---\ndescription: Большое\n---\n{}",
            "x".repeat(MAX_SIZE as usize)
        );
        write(&home, ".omp/agent/rules/big.md", &text);
        let rules = global_list(&home);
        let r = find(&rules, "big");
        assert_eq!(r.description.as_deref(), Some("Большое"));
        assert_eq!(r.body, "");
        assert!(!r.ignored);
    }

    #[test]
    fn invalid_utf8_file_is_listed_with_replaced_text() {
        let dir = TempDir::new("bad-utf8");
        let home = dir.home();
        let path = home.join(".omp/agent/rules/bin.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"\xff\xfe text").unwrap();
        let rules = global_list(&home);
        assert!(find(&rules, "bin").body.contains("text"));
    }

    #[test]
    fn save_new_project_rule_writes_exact_file_and_creates_folder() {
        let dir = TempDir::new("save-new");
        let project = dir.project();
        save_in(
            dir.home().as_path(),
            Some(&project),
            "project",
            None,
            &input("new-rule", true, "", "Текст\n\n"),
        )
        .unwrap();
        assert_eq!(
            read(&project, ".omp/rules/new-rule.md"),
            "---\nalwaysApply: true\n---\n\nТекст\n"
        );
        let list = list_in(&dir.home(), Some(&project));
        let r = find(&list.project, "new-rule");
        assert!(r.always);
        assert_eq!(r.body, "Текст\n");
    }

    #[test]
    fn topic_rule_round_trips_with_globs_and_enabled() {
        let dir = TempDir::new("round-trip");
        let home = dir.home();
        let mut rule = input("topic", false, "  Тесты  ", "тело");
        rule.globs = vec![" *.rs ".to_string(), String::new()];
        rule.enabled = false;
        save_in(&home, None, "global", None, &rule).unwrap();
        let rules = global_list(&home);
        let r = find(&rules, "topic");
        assert_eq!(r.description.as_deref(), Some("Тесты"));
        assert_eq!(r.globs, vec!["*.rs"]);
        assert!(!r.enabled && !r.ignored && !r.always);
        assert_eq!(r.body, "тело\n");
    }

    #[test]
    fn name_validation_rejects_bad_names_and_writes_nothing() {
        let dir = TempDir::new("bad-names");
        let (home, project) = (dir.home(), dir.project());
        let too_long = "a".repeat(65);
        let bad = [
            "../x",
            "A",
            "a b",
            "",
            too_long.as_str(),
            "-a",
            "x/y",
            "Ab",
            "a.b",
        ];
        for name in bad {
            assert_eq!(
                save_in(
                    &home,
                    Some(&project),
                    "project",
                    None,
                    &input(name, true, "", "x")
                )
                .unwrap_err(),
                BAD_NAME,
                "name {name:?}"
            );
            assert_eq!(
                delete_in(&home, Some(&project), "project", name).unwrap_err(),
                BAD_NAME,
                "delete {name:?}"
            );
        }
        assert!(!project.join(".omp").exists());
        let ok_name = "a".repeat(64);
        save_in(
            &home,
            Some(&project),
            "project",
            None,
            &input(&ok_name, true, "", "x"),
        )
        .unwrap();
        assert!(project.join(format!(".omp/rules/{ok_name}.md")).exists());
    }

    #[test]
    fn topic_rule_needs_description() {
        let dir = TempDir::new("needs-description");
        let (home, project) = (dir.home(), dir.project());
        assert_eq!(
            save_in(
                &home,
                Some(&project),
                "project",
                None,
                &input("t", false, "   ", "x")
            )
            .unwrap_err(),
            NEEDS_DESCRIPTION
        );
        assert!(!project.join(".omp").exists());
        save_in(
            &home,
            Some(&project),
            "project",
            None,
            &input("t", true, "", "x"),
        )
        .unwrap();
    }

    #[test]
    fn save_rejects_existing_name_on_create_and_rename() {
        let dir = TempDir::new("conflicts");
        let (home, project) = (dir.home(), dir.project());
        write(&project, ".omp/rules/a.md", "A");
        write(&project, ".omp/rules/b.md", "B");
        let rule_b = input("b", true, "", "new");
        assert_eq!(
            save_in(&home, Some(&project), "project", Some("a"), &rule_b).unwrap_err(),
            CONFLICT
        );
        assert_eq!(
            save_in(
                &home,
                Some(&project),
                "project",
                None,
                &input("a", true, "", "x")
            )
            .unwrap_err(),
            CONFLICT
        );
        assert_eq!(read(&project, ".omp/rules/a.md"), "A");
        assert_eq!(read(&project, ".omp/rules/b.md"), "B");
        assert_eq!(
            save_in(
                &home,
                Some(&project),
                "project",
                Some("ghost"),
                &input("g", true, "", "x")
            )
            .unwrap_err(),
            NOT_FOUND
        );
        assert_eq!(
            save_in(
                &home,
                Some(&project),
                "project",
                Some("../a"),
                &input("g", true, "", "x")
            )
            .unwrap_err(),
            NOT_FOUND
        );
    }

    #[test]
    fn save_keeps_unknown_keys_in_order_and_body() {
        let dir = TempDir::new("keep-unknown");
        let home = dir.home();
        write(
            &home,
            ".omp/agent/rules/keep.md",
            "---\nscope: custom\nalwaysApply: true\nagents:\n  - build\ncondition: x\n---\nстарое\n",
        );
        save_in(
            &home,
            None,
            "global",
            Some("keep"),
            &input("keep", false, "Новое", "новое тело"),
        )
        .unwrap();
        let text = read(&home, ".omp/agent/rules/keep.md");
        assert_eq!(
            keys(&text),
            vec!["scope", "agents", "condition", "description"]
        );
        assert!(text.ends_with("---\n\nновое тело\n"), "{text}");
        let rules = global_list(&home);
        let r = find(&rules, "keep");
        assert!(!r.always);
        assert_eq!(r.body, "новое тело\n");
    }

    #[test]
    fn rename_moves_file_and_keeps_unknown_keys() {
        let dir = TempDir::new("rename");
        let project = dir.project();
        let home = dir.home();
        write(
            &project,
            ".omp/rules/old-name.md",
            "---\nagents: [a]\nenabled: false\n---\nтело\n",
        );
        let mut rule = input("new-name", true, "", "тело 2");
        rule.enabled = true;
        save_in(&home, Some(&project), "project", Some("old-name"), &rule).unwrap();
        assert!(!project.join(".omp/rules/old-name.md").exists());
        let text = read(&project, ".omp/rules/new-name.md");
        assert_eq!(
            text,
            "---\nagents:\n- a\nalwaysApply: true\n---\n\nтело 2\n"
        );
    }

    #[test]
    fn toggling_off_removes_known_keys() {
        let dir = TempDir::new("toggles");
        let home = dir.home();
        write(
            &home,
            ".omp/agent/rules/t.md",
            "---\nalwaysApply: true\ndescription: d\nglobs: [x]\nenabled: false\n---\nтело\n",
        );
        let mut rule = input("t", false, "d2", "тело");
        save_in(&home, None, "global", Some("t"), &rule).unwrap();
        let text = read(&home, ".omp/agent/rules/t.md");
        assert_eq!(keys(&text), vec!["description"]);
        assert_eq!(text, "---\ndescription: d2\n---\n\nтело\n");

        rule.always = true;
        rule.description = String::new();
        save_in(&home, None, "global", Some("t"), &rule).unwrap();
        let text = read(&home, ".omp/agent/rules/t.md");
        assert_eq!(text, "---\nalwaysApply: true\n---\n\nтело\n");
    }

    #[test]
    fn body_size_limit_on_save_and_oversized_file_is_not_rewritten() {
        let dir = TempDir::new("size-save");
        let (home, project) = (dir.home(), dir.project());
        let huge = "a".repeat(MAX_SIZE as usize + 1);
        assert_eq!(
            save_in(
                &home,
                Some(&project),
                "project",
                None,
                &input("big", true, "", &huge)
            )
            .unwrap_err(),
            TOO_LARGE
        );
        assert!(!project.join(".omp/rules/big.md").exists());

        write(
            &project,
            ".omp/rules/big.md",
            &"b".repeat(MAX_SIZE as usize + 1),
        );
        assert_eq!(
            save_in(
                &home,
                Some(&project),
                "project",
                Some("big"),
                &input("big", true, "", "x")
            )
            .unwrap_err(),
            TOO_LARGE
        );
        assert_eq!(
            fs::metadata(project.join(".omp/rules/big.md"))
                .unwrap()
                .len(),
            MAX_SIZE + 1
        );
    }

    #[test]
    fn project_scope_needs_existing_folder_and_scope_is_checked() {
        let dir = TempDir::new("scopes");
        let (home, project) = (dir.home(), dir.project());
        let rule = input("x", true, "", "x");
        assert_eq!(
            save_in(&home, None, "project", None, &rule).unwrap_err(),
            NO_PROJECT
        );
        let missing = dir.0.join("no-such-folder");
        assert_eq!(
            save_in(&home, Some(&missing), "project", None, &rule).unwrap_err(),
            NO_PROJECT
        );
        assert_eq!(
            save_in(&home, Some(&project), "foreign", None, &rule).unwrap_err(),
            UNKNOWN_SCOPE
        );
        assert_eq!(
            delete_in(&home, None, "project", "x").unwrap_err(),
            NO_PROJECT
        );
        assert!(list_in(&home, Some(&missing)).project.is_empty());
    }

    #[test]
    fn delete_removes_rule_and_reports_missing() {
        let dir = TempDir::new("delete");
        let (home, project) = (dir.home(), dir.project());
        write(&project, ".omp/rules/gone.md", "x");
        write(&home, ".omp/agent/rules/gone.md", "x");
        delete_in(&home, Some(&project), "project", "gone").unwrap();
        assert!(!project.join(".omp/rules/gone.md").exists());
        assert_eq!(
            delete_in(&home, Some(&project), "project", "gone").unwrap_err(),
            NOT_FOUND
        );
        delete_in(&home, None, "global", "gone").unwrap();
        assert!(!home.join(".omp/agent/rules/gone.md").exists());
    }

    #[test]
    fn error_messages_do_not_name_the_engine() {
        let dir = TempDir::new("error-wording");
        let (home, project) = (dir.home(), dir.project());
        let rule = input("x", true, "", "x");
        let errors = [
            save_in(
                &home,
                Some(&project),
                "project",
                None,
                &input("../x", true, "", "x"),
            )
            .unwrap_err(),
            save_in(&home, None, "user", None, &rule).unwrap_err(),
            save_in(&home, None, "project", None, &rule).unwrap_err(),
            save_in(
                &home,
                Some(&project),
                "global",
                None,
                &input("x", false, " ", "x"),
            )
            .unwrap_err(),
            delete_in(&home, None, "global", "nope").unwrap_err(),
            delete_in(&home, Some(&project), "project", "nope").unwrap_err(),
        ];
        for e in errors {
            assert!(e.starts_with("Правила: "), "{e}");
            let lower = e.to_lowercase();
            assert!(
                !["omp", ".omp", "oh-my-pi", "models.yml"]
                    .iter()
                    .any(|bad| lower.contains(bad)),
                "{e}"
            );
        }
    }
}
