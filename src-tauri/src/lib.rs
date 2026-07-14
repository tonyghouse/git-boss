mod git;
mod models;

use models::{
    BranchDiffResult, CommitResult, FileDiff, GitCommandFailure, PushResult, RepositoryStatus,
};
use std::path::PathBuf;

#[derive(Clone)]
struct AppState {
    path_hint: PathBuf,
}

#[tauri::command]
fn get_repository_status(
    state: tauri::State<'_, AppState>,
) -> Result<RepositoryStatus, GitCommandFailure> {
    git::repository_status(&state.path_hint)
}

#[tauri::command]
fn stage_file(state: tauri::State<'_, AppState>, path: String) -> Result<(), GitCommandFailure> {
    git::stage_file(&state.path_hint, &path)
}

#[tauri::command]
fn unstage_file(state: tauri::State<'_, AppState>, path: String) -> Result<(), GitCommandFailure> {
    git::unstage_file(&state.path_hint, &path)
}

#[tauri::command]
fn stage_all(state: tauri::State<'_, AppState>) -> Result<(), GitCommandFailure> {
    git::stage_all(&state.path_hint)
}

#[tauri::command]
fn unstage_all(state: tauri::State<'_, AppState>) -> Result<(), GitCommandFailure> {
    git::unstage_all(&state.path_hint)
}

#[tauri::command]
fn commit_changes(
    state: tauri::State<'_, AppState>,
    message: String,
) -> Result<CommitResult, GitCommandFailure> {
    git::commit_changes(&state.path_hint, &message)
}

#[tauri::command]
fn get_file_diff(
    state: tauri::State<'_, AppState>,
    path: String,
    staged: bool,
) -> Result<FileDiff, GitCommandFailure> {
    git::file_diff(&state.path_hint, &path, staged)
}

#[tauri::command]
fn push_changes(state: tauri::State<'_, AppState>) -> Result<PushResult, GitCommandFailure> {
    git::push(&state.path_hint)
}

#[tauri::command]
fn get_branch_diff(
    state: tauri::State<'_, AppState>,
    base_ref: String,
    compare_ref: String,
) -> Result<BranchDiffResult, GitCommandFailure> {
    git::branch_diff(&state.path_hint, &base_ref, &compare_ref)
}

pub fn run() {
    let path_hint = git::initial_path_hint();

    tauri::Builder::default()
        .manage(AppState { path_hint })
        .invoke_handler(tauri::generate_handler![
            get_repository_status,
            stage_file,
            unstage_file,
            stage_all,
            unstage_all,
            commit_changes,
            get_file_diff,
            push_changes,
            get_branch_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitBoss");
}
