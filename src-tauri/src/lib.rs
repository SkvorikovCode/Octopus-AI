mod keys;
mod launch;
mod mcp;
mod omp;
mod providers;
mod pty;
mod rules;
mod search;
mod shell;
mod sessions;
mod checkpoints;
mod files;
mod gitops;
mod instructions;
mod stats;
mod workspace;
mod worktrees;

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must come first: a second launch only brings the running app forward.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| launch::on_second_launch(app, args)))
        .plugin(
            // Size and position survive restarts; visibility doesn't (the app quits with the window hidden).
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(omp::OmpState::default())
        .manage(pty::PtyState::default())
        .manage(shell::ShellState::default())
        .manage(launch::LaunchState::default())
        .setup(|app| {
            launch::on_first_launch(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            omp::omp_locate,
            launch::app_take_launch_session,
            omp::omp_start,
            omp::omp_send,
            omp::omp_stop,
            sessions::sessions_list,
            sessions::sessions_list_many,
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
            pty::pty_open_login,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            stats::usage_stats,
            checkpoints::checkpoint_create,
            checkpoints::checkpoint_changes,
            checkpoints::checkpoint_restore,
            instructions::instructions_get,
            instructions::instructions_save,
            instructions::instructions_read_claude,
            rules::rules_list,
            rules::rule_save,
            rules::rule_delete,
            shell::app_set_busy,
            shell::app_quit,
        ])
        .on_window_event(|window, event| {
            shell::on_window_event(window, event);
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<omp::OmpState>().shutdown();
                window.state::<pty::PtyState>().shutdown();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| shell::on_run_event(app, &event));
}
