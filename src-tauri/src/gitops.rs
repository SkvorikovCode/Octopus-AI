//! Commit, push and pull-request steps for the project folder's git repository.
//! Commands run `git` and `gh` inside the folder; file paths must stay inside it.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

const MAX_MESSAGE_BYTES: usize = 10 * 1024;
const MAX_TITLE_BYTES: usize = 512;
const GH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const GH_MISSING: &str = "GitHub CLI (gh) не установлен или не авторизован";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// None when HEAD is detached.
    pub branch: Option<String>,
    /// Upstream of the current branch, e.g. "origin/main".
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// URL of `origin`, without embedded credentials.
    pub remote_url: Option<String>,
    /// `gh` is on PATH and `gh auth status` succeeds.
    pub has_gh: bool,
    pub default_branch: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn git_repo_info(cwd: String) -> Result<RepoInfo, String> {
    blocking(move || repo_info_sync(&cwd)).await
}

/// Stages `paths` (or everything under cwd when None) and commits. Returns the short hash.
#[tauri::command]
pub async fn git_commit(
    cwd: String,
    message: String,
    paths: Option<Vec<String>>,
) -> Result<String, String> {
    blocking(move || commit_sync(&cwd, &message, paths.as_deref())).await
}

/// Pushes the current branch; sets the upstream on first push. Never forces.
#[tauri::command]
pub async fn git_push(cwd: String) -> Result<(), String> {
    blocking(move || push_sync(&cwd)).await
}

/// Opens a pull request with `gh` and returns its URL.
#[tauri::command]
pub async fn gh_pr_create(
    cwd: String,
    title: String,
    body: String,
    base: Option<String>,
) -> Result<String, String> {
    blocking(move || pr_create_sync(&cwd, &title, &body, base.as_deref())).await
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
// Process plumbing
// ---------------------------------------------------------------------------

/// PATH of the user's login shell, so `gh` and credential helpers resolve as in a terminal.
fn shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let from_shell = Command::new(shell)
            .args(["-lc", "printf %s \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            // The login shell may print banners before PATH; PATH is the last line.
            .and_then(|s| s.lines().last().map(str::to_string))
            .filter(|p| !p.trim().is_empty());
        from_shell.unwrap_or_else(|| {
            let h = std::env::var("HOME").unwrap_or_default();
            format!(
                "/opt/homebrew/bin:/usr/local/bin:{h}/.bun/bin:{h}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            )
        })
    })
}

struct GitOut {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn git_raw(cwd: &str, args: &[&str]) -> Result<GitOut, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("PATH", shell_path())
        .env("LC_ALL", "C")
        // Never wait for a credential prompt; the app has no terminal.
        .env("GIT_TERMINAL_PROMPT", "0")
        // Paths given after `--` are file names, never globs.
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Не удалось запустить git".to_string())?;
    Ok(GitOut {
        success: out.status.success(),
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

/// Trimmed stdout of a successful git call; None on failure or empty output.
fn git_text(cwd: &str, args: &[&str]) -> Option<String> {
    let out = git_raw(cwd, args).ok()?;
    (out.success && !out.stdout.is_empty()).then_some(out.stdout)
}

/// Stdout of a successful git call. On failure: `failed` followed by the first useful line of git's output.
fn git_run(cwd: &str, args: &[&str], failed: &str) -> Result<String, String> {
    let out = git_raw(cwd, args)?;
    if out.success {
        Ok(out.stdout)
    } else {
        Err(format!("{failed}: {}", first_error_line(&out.stderr, &out.stdout)))
    }
}

/// The line that explains a failure: a "fatal:" or "error:" line when there is one.
fn first_error_line(stderr: &str, stdout: &str) -> String {
    let text = if stderr.is_empty() { stdout } else { stderr };
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let picked = lines
        .iter()
        .find(|l| l.starts_with("fatal:") || l.starts_with("error:"))
        .or(lines.first());
    match picked {
        Some(line) => line
            .trim_start_matches("fatal:")
            .trim_start_matches("error:")
            .trim()
            .to_string(),
        None => "Ошибка git".to_string(),
    }
}

fn ensure_repo(cwd: &str) -> Result<(), String> {
    if !Path::new(cwd).is_dir() {
        return Err("Папка проекта не найдена".to_string());
    }
    match git_text(cwd, &["rev-parse", "--is-inside-work-tree"]).as_deref() {
        Some("true") => Ok(()),
        _ => Err("Папка проекта не под git".to_string()),
    }
}

fn current_branch(cwd: &str) -> Option<String> {
    // Works on an unborn branch too; None only when HEAD is detached.
    git_text(cwd, &["symbolic-ref", "-q", "--short", "HEAD"])
}

fn has_head(cwd: &str) -> bool {
    git_raw(cwd, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok_and(|o| o.success)
}

fn has_upstream(cwd: &str) -> bool {
    git_text(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_some()
}

fn ref_exists(cwd: &str, full_ref: &str) -> bool {
    git_raw(cwd, &["show-ref", "--verify", "--quiet", full_ref]).is_ok_and(|o| o.success)
}

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

fn locate_gh() -> Option<PathBuf> {
    shell_path()
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join("gh"))
        .find(|p| p.is_file())
}

/// `gh auth status` succeeds within GH_CHECK_TIMEOUT.
fn gh_authenticated(gh: &Path) -> bool {
    let child = Command::new(gh)
        .args(["auth", "status"])
        .env("PATH", shell_path())
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return false;
    };
    let deadline = Instant::now() + GH_CHECK_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn gh_ready() -> bool {
    locate_gh().is_some_and(|gh| gh_authenticated(&gh))
}

// ---------------------------------------------------------------------------
// Repo info
// ---------------------------------------------------------------------------

fn repo_info_sync(cwd: &str) -> Result<RepoInfo, String> {
    ensure_repo(cwd)?;
    let branch = current_branch(cwd);
    let upstream = git_text(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let (ahead, behind) = match upstream {
        Some(_) => git_text(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])
            .and_then(|s| parse_counts(&s))
            .unwrap_or((0, 0)),
        None => (0, 0),
    };
    let remote_url = git_text(cwd, &["remote", "get-url", "origin"]).map(|u| strip_credentials(&u));
    Ok(RepoInfo {
        branch,
        upstream,
        ahead,
        behind,
        remote_url,
        has_gh: gh_ready(),
        default_branch: default_branch(cwd),
    })
}

/// "ahead<TAB>behind" from `rev-list --left-right --count HEAD...@{u}`.
fn parse_counts(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split_whitespace();
    let ahead = parts.next()?.parse().ok()?;
    let behind = parts.next()?.parse().ok()?;
    Some((ahead, behind))
}

/// Removes "user:password@" from an http(s)/ssh URL so a token never reaches the UI.
fn strip_credentials(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let rest_start = scheme_end + 3;
    let rest = &url[rest_start..];
    let authority_end = rest.find('/').unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{}{}", &url[..rest_start], &rest[at + 1..]),
        None => url.to_string(),
    }
}

/// `origin/HEAD` when set, else whichever of main/master exists.
fn default_branch(cwd: &str) -> Option<String> {
    if let Some(head) = git_text(cwd, &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]) {
        if let Some(name) = head.strip_prefix("origin/").filter(|n| !n.is_empty()) {
            return Some(name.to_string());
        }
    }
    ["main", "master"].into_iter().find_map(|name| {
        let remote = format!("refs/remotes/origin/{name}");
        let local = format!("refs/heads/{name}");
        (ref_exists(cwd, &remote) || ref_exists(cwd, &local)).then(|| name.to_string())
    })
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

fn commit_sync(cwd: &str, message: &str, paths: Option<&[String]>) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Пустое сообщение коммита".to_string());
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err("Сообщение коммита слишком длинное".to_string());
    }
    if message.contains('\0') {
        return Err("Некорректное сообщение коммита".to_string());
    }
    ensure_repo(cwd)?;

    let scope: Option<&[String]> = match paths {
        None => None,
        Some([]) => return Err("Нечего коммитить".to_string()),
        Some(list) => {
            for p in list {
                check_rel_path(p)?;
                resolve_inside(cwd, p)?;
            }
            Some(list)
        }
    };
    let failed = "Не удалось закоммитить";

    // Stage: the selected files, or every change under cwd. A path gone from both the
    // worktree and the index (the source of a staged rename) is only named in the commit.
    match scope {
        Some(list) => {
            let to_add: Vec<&str> = list
                .iter()
                .map(String::as_str)
                .filter(|p| {
                    let in_worktree = resolve_inside(cwd, p)
                        .is_ok_and(|abs| fs::symlink_metadata(abs).is_ok());
                    in_worktree || git_text(cwd, &["ls-files", "--", p]).is_some()
                })
                .collect();
            if !to_add.is_empty() {
                let mut args = vec!["add", "-A", "--"];
                args.extend(to_add);
                git_run(cwd, &args, failed)?;
            }
        }
        None => {
            git_run(cwd, &["add", "-A", "--", "."], failed)?;
        }
    }

    // Nothing staged for the scope means nothing to commit.
    let mut diff_args = vec!["diff", "--cached", "--quiet"];
    if let Some(list) = scope {
        diff_args.push("--");
        diff_args.extend(list.iter().map(String::as_str));
    }
    let staged = git_raw(cwd, &diff_args)?;
    if staged.success {
        return Err("Нечего коммитить".to_string());
    }
    if staged.code != Some(1) {
        return Err(format!("{failed}: {}", first_error_line(&staged.stderr, &staged.stdout)));
    }

    // With paths, `commit -- <paths>` commits only those files, leaving other staged files alone.
    let mut commit_args = vec!["commit", "-m", message];
    if let Some(list) = scope {
        commit_args.push("--");
        commit_args.extend(list.iter().map(String::as_str));
    }
    git_run(cwd, &commit_args, failed)?;

    git_run(cwd, &["rev-parse", "--short", "HEAD"], "Ошибка git").map(|hash| hash.trim().to_string())
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

fn push_sync(cwd: &str) -> Result<(), String> {
    ensure_repo(cwd)?;
    if !has_head(cwd) {
        return Err("Нет коммитов для отправки".to_string());
    }
    let branch = current_branch(cwd).ok_or_else(|| "Нет текущей ветки".to_string())?;
    if branch.starts_with('-') {
        return Err("Некорректное имя ветки".to_string());
    }
    let failed = "Не удалось запушить";
    if has_upstream(cwd) {
        git_run(cwd, &["push"], failed)?;
    } else {
        if git_text(cwd, &["remote", "get-url", "origin"]).is_none() {
            return Err("Не настроен remote origin".to_string());
        }
        git_run(cwd, &["push", "-u", "origin", &branch], failed)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pull request
// ---------------------------------------------------------------------------

fn pr_create_sync(
    cwd: &str,
    title: &str,
    body: &str,
    base: Option<&str>,
) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Не указан заголовок PR".to_string());
    }
    if title.len() > MAX_TITLE_BYTES {
        return Err("Заголовок PR слишком длинный".to_string());
    }
    if body.len() > MAX_MESSAGE_BYTES {
        return Err("Описание PR слишком длинное".to_string());
    }
    if title.contains('\0') || body.contains('\0') {
        return Err("Некорректный текст PR".to_string());
    }
    let base = match base.map(str::trim).filter(|b| !b.is_empty()) {
        None => None,
        Some(b) if b.starts_with('-') || b.contains(char::is_whitespace) => {
            return Err("Некорректная базовая ветка".to_string());
        }
        Some(b) => Some(b),
    };
    ensure_repo(cwd)?;

    let gh = locate_gh()
        .filter(|gh| gh_authenticated(gh))
        .ok_or_else(|| GH_MISSING.to_string())?;
    // `--flag=value` form, so a title or body starting with "-" is never read as a flag.
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        format!("--title={title}"),
        format!("--body={body}"),
    ];
    if let Some(b) = base {
        args.push(format!("--base={b}"));
    }
    let out = Command::new(&gh)
        .args(&args)
        .current_dir(cwd)
        .env("PATH", shell_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|_| GH_MISSING.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        return Err(format!(
            "Не удалось создать PR: {}",
            first_error_line(stderr.trim(), stdout.trim())
        ));
    }
    stdout
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| l.starts_with("http"))
        .map(str::to_string)
        .ok_or_else(|| "Не удалось создать PR: ссылка не найдена".to_string())
}

// ---------------------------------------------------------------------------
// Path safety (same rules as workspace.rs)
// ---------------------------------------------------------------------------

/// Accepts only relative paths made of normal components (and "."), with no "..".
/// Rejects "" and "." so that a commit can never target the whole tree by accident.
fn check_rel_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("Не указан путь к файлу".to_string());
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return Err("Абсолютные пути запрещены".to_string());
    }
    let mut has_name = false;
    for component in p.components() {
        match component {
            Component::Normal(_) => has_name = true,
            Component::CurDir => {}
            _ => return Err("Путь выходит за папку проекта".to_string()),
        }
    }
    if !has_name {
        return Err("Некорректный путь".to_string());
    }
    Ok(())
}

/// Joins a checked relative path onto the canonical cwd and verifies that the nearest
/// existing ancestor (after resolving symlinks) is still inside the cwd.
fn resolve_inside(cwd: &str, rel: &str) -> Result<PathBuf, String> {
    let outside = || "Путь выходит за папку проекта".to_string();
    let root = fs::canonicalize(cwd).map_err(|_| "Папка проекта не найдена".to_string())?;
    let target = root.join(rel);
    let mut ancestor = target.parent();
    while let Some(dir) = ancestor {
        if let Ok(real) = fs::canonicalize(dir) {
            return if real.starts_with(&root) {
                Ok(target.clone())
            } else {
                Err(outside())
            };
        }
        ancestor = dir.parent();
    }
    Err(outside())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "octopus-gitops-{name}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn git_test(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Repo with one commit of a.txt on branch main, identity set locally.
    fn repo_with_commit(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        git_test(&dir, &["init", "-q"]);
        git_test(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git_test(&dir, &["config", "user.name", "Test"]);
        git_test(&dir, &["config", "user.email", "test@example.com"]);
        git_test(&dir, &["config", "commit.gpgsign", "false"]);
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git_test(&dir, &["add", "a.txt"]);
        git_test(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    fn cwd_of(dir: &Path) -> String {
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn commit_all_changes() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit("all");
        let cwd = cwd_of(&dir);
        fs::write(dir.join("a.txt"), "two\n").unwrap();
        fs::write(dir.join("b.txt"), "new\n").unwrap();

        let hash = commit_sync(&cwd, "  feat: everything \n\nbody", None).unwrap();
        assert!(!hash.is_empty());
        assert_eq!(git_test(&dir, &["rev-parse", "--short", "HEAD"]), hash);
        assert_eq!(git_test(&dir, &["log", "-1", "--format=%s"]), "feat: everything");
        assert_eq!(git_test(&dir, &["status", "--porcelain"]), "");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_selected_paths_only() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit("paths");
        let cwd = cwd_of(&dir);
        fs::write(dir.join("a.txt"), "two\n").unwrap();
        fs::write(dir.join("b.txt"), "untracked\n").unwrap();
        // Already staged, but not selected: must stay staged, not join the commit.
        fs::write(dir.join("c.txt"), "staged\n").unwrap();
        git_test(&dir, &["add", "c.txt"]);

        let paths = vec!["a.txt".to_string()];
        commit_sync(&cwd, "only a", Some(paths.as_slice())).unwrap();

        assert_eq!(git_test(&dir, &["show", "--name-only", "--format=", "HEAD"]), "a.txt");
        let status = git_test(&dir, &["status", "--porcelain"]);
        assert!(status.contains("A  c.txt"), "{status}");
        assert!(status.contains("?? b.txt"), "{status}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_staged_rename_as_a_pair() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit("rename");
        let cwd = cwd_of(&dir);
        git_test(&dir, &["mv", "a.txt", "b.txt"]);
        // The frontend passes both the new and the source path of a rename.
        let paths = vec!["b.txt".to_string(), "a.txt".to_string()];
        commit_sync(&cwd, "rename", Some(paths.as_slice())).unwrap();
        assert_eq!(git_test(&dir, &["status", "--porcelain"]), "");
        assert!(git_test(&dir, &["show", "--name-status", "--format=", "HEAD"]).starts_with("R"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nothing_to_commit_is_an_error() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit("clean");
        let cwd = cwd_of(&dir);
        let err = commit_sync(&cwd, "empty", None).unwrap_err();
        assert_eq!(err, "Нечего коммитить");
        let paths = vec!["a.txt".to_string()];
        let err = commit_sync(&cwd, "empty", Some(paths.as_slice())).unwrap_err();
        assert_eq!(err, "Нечего коммитить");
        assert_eq!(git_test(&dir, &["rev-list", "--count", "HEAD"]), "1");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_input_rules() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit("rules");
        let cwd = cwd_of(&dir);
        fs::write(dir.join("a.txt"), "two\n").unwrap();
        assert!(commit_sync(&cwd, "   ", None).is_err());
        let long = "x".repeat(MAX_MESSAGE_BYTES + 1);
        assert!(commit_sync(&cwd, &long, None).is_err());
        let escape = vec!["../escape.txt".to_string()];
        assert!(commit_sync(&cwd, "bad", Some(escape.as_slice())).is_err());
        // Rejected calls changed nothing.
        assert_eq!(git_test(&dir, &["rev-list", "--count", "HEAD"]), "1");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn repo_info_without_upstream() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit("info");
        let cwd = cwd_of(&dir);
        let info = repo_info_sync(&cwd).unwrap();
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.upstream, None);
        assert_eq!((info.ahead, info.behind), (0, 0));
        assert_eq!(info.remote_url, None);
        assert_eq!(info.default_branch.as_deref(), Some("main"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn repo_info_outside_git_is_error() {
        if !git_available() {
            return;
        }
        let dir = temp_dir("plain");
        let err = repo_info_sync(&cwd_of(&dir)).unwrap_err();
        assert_eq!(err, "Папка проекта не под git");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn push_sets_upstream_then_tracks_it() {
        if !git_available() {
            return;
        }
        let remote = temp_dir("remote");
        git_test(&remote, &["init", "-q", "--bare"]);
        let dir = repo_with_commit("push");
        let cwd = cwd_of(&dir);
        let remote_path = cwd_of(&remote);
        git_test(&dir, &["remote", "add", "origin", &remote_path]);

        push_sync(&cwd).unwrap();
        assert_eq!(git_test(&dir, &["rev-parse", "--abbrev-ref", "@{u}"]), "origin/main");
        assert!(git_raw(&remote_path, &["rev-parse", "--verify", "-q", "refs/heads/main"])
            .unwrap()
            .success);

        let info = repo_info_sync(&cwd).unwrap();
        assert_eq!(info.upstream.as_deref(), Some("origin/main"));
        assert_eq!((info.ahead, info.behind), (0, 0));
        assert_eq!(info.remote_url.as_deref(), Some(remote_path.as_str()));

        fs::write(dir.join("a.txt"), "two\n").unwrap();
        commit_sync(&cwd, "second", None).unwrap();
        assert_eq!(repo_info_sync(&cwd).unwrap().ahead, 1);
        push_sync(&cwd).unwrap();
        assert_eq!(repo_info_sync(&cwd).unwrap().ahead, 0);

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&remote).ok();
    }

    #[test]
    fn push_without_origin_is_error() {
        if !git_available() {
            return;
        }
        let dir = repo_with_commit("noorigin");
        let err = push_sync(&cwd_of(&dir)).unwrap_err();
        assert_eq!(err, "Не настроен remote origin");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn credentials_are_stripped_from_urls() {
        assert_eq!(
            strip_credentials("https://user:token@github.com/a/b.git"),
            "https://github.com/a/b.git"
        );
        assert_eq!(strip_credentials("https://github.com/a/b.git"), "https://github.com/a/b.git");
        assert_eq!(strip_credentials("git@github.com:demo/my-app.git"), "git@github.com:demo/my-app.git");
    }

    #[test]
    fn counts_and_paths_parse() {
        assert_eq!(parse_counts("2\t1"), Some((2, 1)));
        assert_eq!(parse_counts("x"), None);
        assert!(check_rel_path("src/a.rs").is_ok());
        assert!(check_rel_path("../a").is_err());
        assert!(check_rel_path("/etc/passwd").is_err());
        assert!(check_rel_path(".").is_err());
    }

    #[test]
    fn pr_rejects_bad_input_before_calling_gh() {
        assert_eq!(
            pr_create_sync("/nonexistent-octopus-dir", "  ", "", None).unwrap_err(),
            "Не указан заголовок PR"
        );
        let long = "t".repeat(MAX_TITLE_BYTES + 1);
        assert_eq!(
            pr_create_sync("/nonexistent-octopus-dir", &long, "", None).unwrap_err(),
            "Заголовок PR слишком длинный"
        );
        assert_eq!(
            pr_create_sync("/nonexistent-octopus-dir", "ok", "", Some("--evil")).unwrap_err(),
            "Некорректная базовая ветка"
        );
    }
}
