//! Instruction files the agent reads: one global file (in the home folder) and one per project.
//! The engine reads exactly one file per level: the first existing non-empty candidate in
//! priority order. The editor shows and saves that active file, or the default file when no
//! candidate is active. Other existing candidates are reported as shadowed.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_yaml::Value;

const MAX_SIZE: u64 = 1024 * 1024;
const TOO_LARGE: &str = "Инструкции: файл слишком большой";
const UNKNOWN_FILE: &str = "Инструкции: неизвестный файл";
const PROJECT_CANDIDATES: [&str; 6] = [
    ".omp/AGENTS.md",
    ".claude/CLAUDE.md",
    ".agents/AGENTS.md",
    ".github/copilot-instructions.md",
    "AGENTS.md",
    "CLAUDE.md",
];
const PROJECT_DEFAULT: &str = "AGENTS.md";
const GLOBAL_DEFAULT: &str = ".omp/agent/AGENTS.md";
const CONFIG_PATH: &str = ".omp/agent/config.yml";
const CLAUDE_PATH: &str = ".claude/CLAUDE.md";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    /// Relative path (to the project folder, or to home for global) of the file the editor
    /// shows and saves: the active file if any, else the default file.
    pub target_rel: String,
    /// Absolute path of the target.
    pub target: String,
    /// The target exists on disk.
    pub exists: bool,
    /// Target content, "" when missing.
    pub content: String,
    /// Relative path of the file the engine reads now, None when no candidate is non-empty.
    pub active: Option<String>,
    /// Relative paths of other existing non-empty candidates the engine ignores, in priority order.
    pub shadowed: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instructions {
    pub global: Scope,
    /// None when no project folder is given.
    pub project: Option<Scope>,
    /// Absolute path of ~/.claude/CLAUDE.md when it exists and is non-empty.
    pub claude_import: Option<String>,
}

// ---------- paths and candidates ----------

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Инструкции: не найден $HOME".to_string())
}

fn cwd_of(cwd: &Option<String>) -> Option<PathBuf> {
    cwd.as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(PathBuf::from)
}

/// Whether the agent config enables the claude provider (`enabledProviders` contains
/// "claude", "*" or "all"). A missing or invalid config means no.
fn claude_enabled(home: &Path) -> bool {
    let Ok(text) = fs::read_to_string(home.join(CONFIG_PATH)) else {
        return false;
    };
    let Ok(doc) = serde_yaml::from_str::<Value>(&text) else {
        return false;
    };
    doc.get("enabledProviders")
        .and_then(Value::as_sequence)
        .is_some_and(|items| {
            items
                .iter()
                .any(|v| matches!(v.as_str(), Some("claude" | "*" | "all")))
        })
}

/// Global candidates in priority order. ~/.claude/CLAUDE.md is a candidate only when the
/// agent config enables the claude provider.
fn global_candidates(home: &Path) -> Vec<&'static str> {
    let mut out = vec![GLOBAL_DEFAULT, ".agents/AGENTS.md"];
    if claude_enabled(home) {
        out.insert(1, CLAUDE_PATH);
    }
    out
}

// ---------- reading ----------

/// A candidate is active when it is an existing file with any content (the engine checks
/// the raw content, so whitespace counts). Only metadata is read, so a large shadowed file
/// does not break the listing.
fn is_active_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0)
}

/// Reads a text file of at most 1 MB.
fn read_limited(path: &Path) -> Result<String, String> {
    let read_err = |e: io::Error| format!("Инструкции: не удалось прочитать файл: {e}");
    let file = fs::File::open(path).map_err(read_err)?;
    let mut buf = Vec::new();
    file.take(MAX_SIZE + 1)
        .read_to_end(&mut buf)
        .map_err(read_err)?;
    if buf.len() as u64 > MAX_SIZE {
        return Err(TOO_LARGE.to_string());
    }
    String::from_utf8(buf).map_err(|_| "Инструкции: файл не в кодировке UTF-8".to_string())
}

fn build_scope(base: &Path, candidates: &[&str], default: &str) -> Result<Scope, String> {
    let mut active: Option<&str> = None;
    let mut shadowed = Vec::new();
    for &rel in candidates {
        if !is_active_file(&base.join(rel)) {
            continue;
        }
        if active.is_none() {
            active = Some(rel);
        } else {
            shadowed.push(rel.to_string());
        }
    }
    let target_rel = active.unwrap_or(default);
    let target = base.join(target_rel);
    let exists = target.is_file();
    let content = if exists {
        read_limited(&target)?
    } else {
        String::new()
    };
    Ok(Scope {
        target_rel: target_rel.to_string(),
        target: target.to_string_lossy().into_owned(),
        exists,
        content,
        active: active.map(str::to_string),
        shadowed,
    })
}

fn claude_import_in(home: &Path) -> Option<String> {
    let path = home.join(CLAUDE_PATH);
    is_active_file(&path).then(|| path.to_string_lossy().into_owned())
}

fn get_in(home: &Path, cwd: Option<&Path>) -> Result<Instructions, String> {
    let global = build_scope(home, &global_candidates(home), GLOBAL_DEFAULT)?;
    let project = match cwd.filter(|c| !c.as_os_str().is_empty()) {
        Some(dir) => Some(build_scope(dir, &PROJECT_CANDIDATES, PROJECT_DEFAULT)?),
        None => None,
    };
    Ok(Instructions {
        global,
        project,
        claude_import: claude_import_in(home),
    })
}

fn read_claude_in(home: &Path) -> Result<String, String> {
    let path = home.join(CLAUDE_PATH);
    if !path.is_file() {
        return Err("Инструкции: файл Claude не найден".to_string());
    }
    read_limited(&path)
}

// ---------- saving ----------

/// Writes `text` through `<file>.octopus-tmp` and a rename, creating parent folders.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let save_err = |e: io::Error| format!("Инструкции: не удалось сохранить: {e}");
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

fn save_in(
    home: &Path,
    cwd: Option<&Path>,
    scope: &str,
    rel: &str,
    content: &str,
) -> Result<(), String> {
    let (base, candidates): (PathBuf, Vec<&str>) = match scope {
        "global" => (home.to_path_buf(), global_candidates(home)),
        "project" => {
            let dir = cwd
                .filter(|c| c.is_dir())
                .ok_or_else(|| "Инструкции: папка проекта не найдена".to_string())?;
            (dir.to_path_buf(), PROJECT_CANDIDATES.to_vec())
        }
        _ => return Err("Инструкции: неизвестная область".to_string()),
    };
    // Whitelist: the rel path must be exactly one candidate of this scope.
    if !candidates.contains(&rel) {
        return Err(UNKNOWN_FILE.to_string());
    }
    if content.len() as u64 > MAX_SIZE {
        return Err(TOO_LARGE.to_string());
    }
    let path = base.join(rel);
    if content.is_empty() && !path.exists() {
        return Ok(());
    }
    let text = if content.is_empty() {
        String::new()
    } else {
        format!("{}\n", content.trim_end_matches('\n'))
    };
    write_atomic(&path, &text)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn instructions_get(cwd: Option<String>) -> Result<Instructions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = cwd_of(&cwd);
        get_in(&home_dir()?, cwd.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn instructions_save(
    scope: String,
    cwd: Option<String>,
    rel: String,
    content: String,
) -> Result<(), String> {
    let cwd = cwd_of(&cwd);
    save_in(&home_dir()?, cwd.as_deref(), &scope, &rel, &content)
}

#[tauri::command]
pub async fn instructions_read_claude() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| read_claude_in(&home_dir()?))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "octopus-instructions-test-{}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        /// Home folder for the test.
        fn home(&self) -> PathBuf {
            let home = self.0.join("home");
            fs::create_dir_all(&home).unwrap();
            home
        }

        /// Project folder for the test.
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

    fn shadowed(scope: &Scope) -> Vec<&str> {
        scope.shadowed.iter().map(String::as_str).collect()
    }

    fn project_scope(home: &Path, project: &Path) -> Scope {
        get_in(home, Some(project)).unwrap().project.unwrap()
    }

    fn global_scope(home: &Path) -> Scope {
        get_in(home, None).unwrap().global
    }

    fn enable_claude(home: &Path) {
        write(home, CONFIG_PATH, "enabledProviders:\n  - claude\n");
    }

    #[test]
    fn project_claude_beats_root_agents() {
        let dir = TempDir::new("claude-beats-agents");
        let (home, project) = (dir.home(), dir.project());
        write(&project, ".claude/CLAUDE.md", "claude");
        write(&project, "AGENTS.md", "agents");
        let s = project_scope(&home, &project);
        assert_eq!(s.active.as_deref(), Some(".claude/CLAUDE.md"));
        assert_eq!(s.target_rel, ".claude/CLAUDE.md");
        assert_eq!(s.content, "claude");
        assert!(s.exists);
        assert_eq!(shadowed(&s), vec!["AGENTS.md"]);
    }

    #[test]
    fn project_copilot_beats_root_agents() {
        let dir = TempDir::new("copilot-beats-agents");
        let (home, project) = (dir.home(), dir.project());
        write(&project, ".github/copilot-instructions.md", "copilot");
        write(&project, "AGENTS.md", "agents");
        let s = project_scope(&home, &project);
        assert_eq!(s.active.as_deref(), Some(".github/copilot-instructions.md"));
        assert_eq!(s.target_rel, ".github/copilot-instructions.md");
        assert_eq!(shadowed(&s), vec!["AGENTS.md"]);
    }

    #[test]
    fn project_empty_higher_candidate_is_skipped() {
        let dir = TempDir::new("empty-skipped");
        let (home, project) = (dir.home(), dir.project());
        write(&project, ".omp/AGENTS.md", "");
        write(&project, ".agents/AGENTS.md", "agents");
        write(&project, "CLAUDE.md", "claude");
        let s = project_scope(&home, &project);
        assert_eq!(s.active.as_deref(), Some(".agents/AGENTS.md"));
        assert_eq!(shadowed(&s), vec!["CLAUDE.md"]);
    }

    #[test]
    fn project_shadowed_list_is_in_priority_order() {
        let dir = TempDir::new("shadow-order");
        let (home, project) = (dir.home(), dir.project());
        for rel in PROJECT_CANDIDATES {
            write(&project, rel, "x");
        }
        let s = project_scope(&home, &project);
        assert_eq!(s.active.as_deref(), Some(".omp/AGENTS.md"));
        assert_eq!(
            shadowed(&s),
            vec![
                ".claude/CLAUDE.md",
                ".agents/AGENTS.md",
                ".github/copilot-instructions.md",
                "AGENTS.md",
                "CLAUDE.md",
            ]
        );
    }

    #[test]
    fn project_default_target_when_nothing_exists() {
        let dir = TempDir::new("project-default");
        let (home, project) = (dir.home(), dir.project());
        let s = project_scope(&home, &project);
        assert_eq!(s.active, None);
        assert_eq!(s.target_rel, "AGENTS.md");
        assert!(s.target.ends_with("AGENTS.md"));
        assert!(!s.exists);
        assert_eq!(s.content, "");
        assert!(s.shadowed.is_empty());
    }

    #[test]
    fn project_empty_default_file_counts_as_existing() {
        let dir = TempDir::new("project-empty-default");
        let (home, project) = (dir.home(), dir.project());
        write(&project, "AGENTS.md", "");
        let s = project_scope(&home, &project);
        assert_eq!(s.active, None);
        assert_eq!(s.target_rel, "AGENTS.md");
        assert!(s.exists);
        assert_eq!(s.content, "");
    }

    #[test]
    fn project_is_none_without_cwd() {
        let dir = TempDir::new("project-none");
        let home = dir.home();
        assert!(get_in(&home, None).unwrap().project.is_none());
        assert!(get_in(&home, Some(Path::new(""))).unwrap().project.is_none());
        assert!(cwd_of(&Some("   ".to_string())).is_none());
        assert!(cwd_of(&None).is_none());
    }

    #[test]
    fn global_claude_file_ignored_without_enabled_provider() {
        let dir = TempDir::new("global-claude-disabled");
        let home = dir.home();
        write(&home, ".claude/CLAUDE.md", "claude");
        write(&home, ".agents/AGENTS.md", "agents");
        write(&home, CONFIG_PATH, "enabledProviders:\n  - openai\n");
        let s = global_scope(&home);
        assert_eq!(s.active.as_deref(), Some(".agents/AGENTS.md"));
        assert!(s.shadowed.is_empty());
    }

    #[test]
    fn global_claude_file_is_candidate_when_enabled() {
        let dir = TempDir::new("global-claude-enabled");
        let home = dir.home();
        write(&home, ".claude/CLAUDE.md", "claude");
        write(&home, ".agents/AGENTS.md", "agents");
        enable_claude(&home);
        let s = global_scope(&home);
        assert_eq!(s.active.as_deref(), Some(".claude/CLAUDE.md"));
        assert_eq!(shadowed(&s), vec![".agents/AGENTS.md"]);
    }

    #[test]
    fn global_claude_candidate_with_star_or_all() {
        let dir = TempDir::new("global-star-all");
        let home = dir.home();
        write(&home, ".claude/CLAUDE.md", "claude");
        write(&home, CONFIG_PATH, "enabledProviders: [\"*\"]\n");
        assert_eq!(global_scope(&home).active.as_deref(), Some(".claude/CLAUDE.md"));
        write(&home, CONFIG_PATH, "enabledProviders: [all]\n");
        assert_eq!(global_scope(&home).active.as_deref(), Some(".claude/CLAUDE.md"));
    }

    #[test]
    fn global_invalid_config_is_not_a_candidate() {
        let dir = TempDir::new("global-invalid-config");
        let home = dir.home();
        write(&home, ".claude/CLAUDE.md", "claude");
        write(&home, CONFIG_PATH, "enabledProviders: [claude\n");
        let s = global_scope(&home);
        assert_eq!(s.active, None);
        assert_eq!(s.target_rel, GLOBAL_DEFAULT);
        write(&home, CONFIG_PATH, "enabledProviders: claude\n");
        assert_eq!(global_scope(&home).active, None);
    }

    #[test]
    fn global_omp_file_beats_claude_file() {
        let dir = TempDir::new("global-omp-first");
        let home = dir.home();
        write(&home, ".omp/agent/AGENTS.md", "omp");
        write(&home, ".claude/CLAUDE.md", "claude");
        write(&home, ".agents/AGENTS.md", "agents");
        enable_claude(&home);
        let s = global_scope(&home);
        assert_eq!(s.active.as_deref(), Some(".omp/agent/AGENTS.md"));
        assert_eq!(shadowed(&s), vec![".claude/CLAUDE.md", ".agents/AGENTS.md"]);
    }

    #[test]
    fn global_default_target_when_nothing_exists() {
        let dir = TempDir::new("global-default");
        let home = dir.home();
        let s = global_scope(&home);
        assert_eq!(s.active, None);
        assert_eq!(s.target_rel, GLOBAL_DEFAULT);
        assert!(!s.exists);
        assert!(s.target.starts_with(home.to_str().unwrap()));
    }

    #[test]
    fn claude_import_present_absent_or_empty() {
        let dir = TempDir::new("claude-import");
        let home = dir.home();
        assert_eq!(get_in(&home, None).unwrap().claude_import, None);
        write(&home, ".claude/CLAUDE.md", "");
        assert_eq!(get_in(&home, None).unwrap().claude_import, None);
        write(&home, ".claude/CLAUDE.md", "rules");
        let import = get_in(&home, None).unwrap().claude_import.unwrap();
        assert!(Path::new(&import).is_absolute());
        assert!(import.ends_with(".claude/CLAUDE.md"));
    }

    #[test]
    fn read_claude_missing_and_present() {
        let dir = TempDir::new("read-claude");
        let home = dir.home();
        assert!(read_claude_in(&home).is_err());
        write(&home, ".claude/CLAUDE.md", "Привет\n");
        assert_eq!(read_claude_in(&home).unwrap(), "Привет\n");
    }

    #[test]
    fn save_rejects_rel_outside_whitelist() {
        let dir = TempDir::new("save-whitelist");
        let (home, project) = (dir.home(), dir.project());
        let bad = [
            "../x.md",
            "src/AGENTS.md",
            "/etc/passwd",
            "/tmp/x.md",
            "./AGENTS.md",
            "",
            ".omp/agent/AGENTS.md",
        ];
        for rel in bad {
            assert_eq!(
                save_in(&home, Some(&project), "project", rel, "x").unwrap_err(),
                UNKNOWN_FILE,
                "project rel {rel:?}"
            );
        }
        // Project-only candidates are not valid for the global scope.
        assert_eq!(
            save_in(&home, None, "global", ".omp/AGENTS.md", "x").unwrap_err(),
            UNKNOWN_FILE
        );
        assert!(!dir.0.join("x.md").exists());
        assert!(!project.join("src").exists());
    }

    #[test]
    fn save_rejects_unknown_scope_and_missing_project() {
        let dir = TempDir::new("save-scope");
        let (home, project) = (dir.home(), dir.project());
        assert!(save_in(&home, Some(&project), "user", "AGENTS.md", "x").is_err());
        assert!(save_in(&home, None, "project", "AGENTS.md", "x").is_err());
        assert!(save_in(&home, Some(Path::new("")), "project", "AGENTS.md", "x").is_err());
        let missing = dir.0.join("no-such-folder");
        assert!(save_in(&home, Some(&missing), "project", "AGENTS.md", "x").is_err());
        assert!(save_in(&home, None, "project", "AGENTS.md", "").is_err());
    }

    #[test]
    fn save_empty_without_file_does_nothing() {
        let dir = TempDir::new("save-empty-noop");
        let (home, project) = (dir.home(), dir.project());
        save_in(&home, Some(&project), "project", "AGENTS.md", "").unwrap();
        save_in(&home, None, "global", GLOBAL_DEFAULT, "").unwrap();
        assert!(!project.join("AGENTS.md").exists());
        assert!(!home.join(GLOBAL_DEFAULT).exists());
        assert!(!home.join(".omp").exists());
    }

    #[test]
    fn save_empty_clears_existing_file() {
        let dir = TempDir::new("save-empty-clears");
        let (home, project) = (dir.home(), dir.project());
        write(&project, "AGENTS.md", "abc\n");
        save_in(&home, Some(&project), "project", "AGENTS.md", "").unwrap();
        let s = project_scope(&home, &project);
        assert!(s.exists);
        assert_eq!(s.active, None);
        assert_eq!(s.content, "");
    }

    #[test]
    fn save_creates_parent_dirs_and_leaves_no_temp_file() {
        let dir = TempDir::new("save-parents");
        let (home, project) = (dir.home(), dir.project());
        save_in(
            &home,
            Some(&project),
            "project",
            ".github/copilot-instructions.md",
            "правила",
        )
        .unwrap();
        let path = project.join(".github/copilot-instructions.md");
        assert_eq!(fs::read_to_string(&path).unwrap(), "правила\n");
        assert!(!project.join(".github/copilot-instructions.md.octopus-tmp").exists());
        save_in(&home, None, "global", ".agents/AGENTS.md", "g").unwrap();
        assert_eq!(fs::read_to_string(home.join(".agents/AGENTS.md")).unwrap(), "g\n");
    }

    #[test]
    fn save_normalizes_trailing_newline() {
        let dir = TempDir::new("save-newline");
        let (home, project) = (dir.home(), dir.project());
        let cases = [
            ("a\n\n\n", "a\n"),
            ("a", "a\n"),
            ("a\nb", "a\nb\n"),
            ("  x  \n", "  x  \n"),
            ("\n", "\n"),
        ];
        for (input, expected) in cases {
            save_in(&home, Some(&project), "project", "AGENTS.md", input).unwrap();
            assert_eq!(fs::read_to_string(project.join("AGENTS.md")).unwrap(), expected);
        }
    }

    #[test]
    fn save_preserves_other_bytes() {
        let dir = TempDir::new("save-bytes");
        let (home, project) = (dir.home(), dir.project());
        let text = "# Правила\r\n\tотступ  \r\n\r\nemoji 🐙\nсреди\n\n";
        save_in(&home, Some(&project), "project", "AGENTS.md", text).unwrap();
        let written = fs::read(project.join("AGENTS.md")).unwrap();
        assert_eq!(written, "# Правила\r\n\tотступ  \r\n\r\nemoji 🐙\nсреди\n".as_bytes());
    }

    #[test]
    fn size_limits_for_save_and_read() {
        let dir = TempDir::new("size-limits");
        let (home, project) = (dir.home(), dir.project());

        let too_big = "a".repeat(MAX_SIZE as usize + 1);
        assert_eq!(
            save_in(&home, Some(&project), "project", "AGENTS.md", &too_big).unwrap_err(),
            TOO_LARGE
        );
        assert!(!project.join("AGENTS.md").exists());

        // A too-large target cannot be read.
        write(&project, "AGENTS.md", &"b".repeat(MAX_SIZE as usize + 1));
        assert_eq!(get_in(&home, Some(&project)).err().as_deref(), Some(TOO_LARGE));

        // A too-large file that is only shadowed does not break the listing.
        fs::remove_file(project.join("AGENTS.md")).unwrap();
        write(&project, "AGENTS.md", &"c".repeat(2 * MAX_SIZE as usize));
        write(&project, ".claude/CLAUDE.md", "small");
        let s = project_scope(&home, &project);
        assert_eq!(s.active.as_deref(), Some(".claude/CLAUDE.md"));
        assert_eq!(shadowed(&s), vec!["AGENTS.md"]);

        write(&home, ".claude/CLAUDE.md", &"d".repeat(MAX_SIZE as usize + 1));
        assert_eq!(read_claude_in(&home).unwrap_err(), TOO_LARGE);
    }

    #[test]
    fn error_messages_do_not_name_the_engine() {
        let dir = TempDir::new("error-wording");
        let (home, project) = (dir.home(), dir.project());
        let errors = [
            save_in(&home, Some(&project), "project", "../x", "x").unwrap_err(),
            save_in(&home, None, "user", "AGENTS.md", "x").unwrap_err(),
            save_in(&home, None, "project", "AGENTS.md", "x").unwrap_err(),
            read_claude_in(&home).unwrap_err(),
        ];
        for e in errors {
            assert!(e.starts_with("Инструкции: "), "{e}");
            let lower = e.to_lowercase();
            assert!(!lower.contains("omp") && !lower.contains(".omp"), "{e}");
        }
    }
}
