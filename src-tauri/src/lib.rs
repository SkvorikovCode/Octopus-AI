mod keys;
mod mcp;
mod omp;
mod providers;
mod pty;
mod search;
mod sessions;
mod checkpoints;
mod files;
mod gitops;
mod stats;
mod workspace;
mod worktrees;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(omp::OmpState::default())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            omp::omp_locate,
            omp::omp_start,
            omp::omp_send,
            omp::omp_stop,
            sessions::sessions_list,
            sessions::session_delete,
            sessions::sessions_prune_empty,
            search::sessions_search,
            providers::providers_list,
            providers::provider_discover,
            providers::provider_save,
            providers::provider_remove,
            providers::model_cost_set,
            workspace::git_status,
            workspace::git_diff,
            workspace::git_restore,
            workspace::git_apply_hunk,
            gitops::git_repo_info,
            gitops::git_commit,
            gitops::git_push,
            gitops::gh_pr_create,
            mcp::mcp_list,
            mcp::mcp_save,
            mcp::mcp_remove,
            mcp::mcp_set_enabled,
            worktrees::worktree_create,
            worktrees::worktree_list,
            worktrees::worktree_apply,
            worktrees::worktree_remove,
            workspace::project_files,
            files::read_project_file,
            files::save_text_file,
            files::read_image_file,
            files::path_is_dir,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            stats::usage_stats,
            checkpoints::checkpoint_create,
            checkpoints::checkpoint_changes,
            checkpoints::checkpoint_restore,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<omp::OmpState>().shutdown();
                window.state::<pty::PtyState>().shutdown();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
