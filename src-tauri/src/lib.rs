mod git;
mod instance;
mod models;

use instance::{InstanceClaim, InstanceMessage, InstanceOwner, LaunchRequest};
use models::{
    BranchDiffResult, CommitResult, FileDiff, GitCommandFailure, PushResult, RepositoryStatus,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Manager, Window};

const MAIN_WINDOW_LABEL: &str = "main";
const INTERNAL_STATE_COMMAND: &str = "gitboss repository-window-state";

struct AppState {
    repositories: Mutex<HashMap<String, PathBuf>>,
    next_window_id: AtomicU64,
}

#[derive(Debug, PartialEq)]
enum WindowReservation {
    Existing(String),
    New(String),
}

impl AppState {
    fn new(initial_path: PathBuf) -> Self {
        Self {
            repositories: Mutex::new(HashMap::from([(
                MAIN_WINDOW_LABEL.to_string(),
                initial_path,
            )])),
            next_window_id: AtomicU64::new(1),
        }
    }

    fn repository_for_window(&self, label: &str) -> Result<PathBuf, GitCommandFailure> {
        let repositories = self.repositories.lock().map_err(|_| state_failure())?;

        repositories
            .get(label)
            .cloned()
            .ok_or_else(|| GitCommandFailure {
                command: INTERNAL_STATE_COMMAND.to_string(),
                error: format!("No repository context is registered for window {label:?}."),
            })
    }

    fn set_repository_for_window(&self, label: &str, path: PathBuf) -> Result<(), String> {
        let mut repositories = self.repositories.lock().map_err(|_| {
            "The repository window registry is unavailable because its lock was poisoned."
                .to_string()
        })?;
        repositories.insert(label.to_string(), path);

        Ok(())
    }

    fn reserve_window(&self, path: PathBuf) -> Result<WindowReservation, String> {
        let mut repositories = self.repositories.lock().map_err(|_| {
            "The repository window registry is unavailable because its lock was poisoned."
                .to_string()
        })?;

        if let Some((label, _)) = repositories
            .iter()
            .find(|(_, repository_path)| **repository_path == path)
        {
            return Ok(WindowReservation::Existing(label.clone()));
        }

        let window_id = self.next_window_id.fetch_add(1, Ordering::Relaxed);
        let label = format!("repo-{window_id}");
        repositories.insert(label.clone(), path);

        Ok(WindowReservation::New(label))
    }

    fn forget_window(&self, label: &str) -> Result<bool, String> {
        let mut repositories = self.repositories.lock().map_err(|_| {
            "The repository window registry is unavailable because its lock was poisoned."
                .to_string()
        })?;
        repositories.remove(label);

        Ok(repositories.is_empty())
    }

    fn any_window_label(&self) -> Result<Option<String>, String> {
        let repositories = self.repositories.lock().map_err(|_| {
            "The repository window registry is unavailable because its lock was poisoned."
                .to_string()
        })?;

        Ok(repositories
            .contains_key(MAIN_WINDOW_LABEL)
            .then(|| MAIN_WINDOW_LABEL.to_string())
            .or_else(|| repositories.keys().next().cloned()))
    }
}

#[tauri::command]
async fn get_repository_status(
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<RepositoryStatus, GitCommandFailure> {
    let (path_hint, app) = command_context(&window, &state)?;
    run_git_task(app, "get_repository_status", move || {
        git::repository_status(&path_hint)
    })
    .await
}

#[tauri::command]
async fn stage_file(
    window: Window,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), GitCommandFailure> {
    let (path_hint, app) = command_context(&window, &state)?;
    run_git_task(app, "stage_file", move || {
        git::stage_file(&path_hint, &path)
    })
    .await
}

#[tauri::command]
async fn unstage_file(
    window: Window,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), GitCommandFailure> {
    let (path_hint, app) = command_context(&window, &state)?;
    run_git_task(app, "unstage_file", move || {
        git::unstage_file(&path_hint, &path)
    })
    .await
}

#[tauri::command]
async fn stage_all(
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<(), GitCommandFailure> {
    let (path_hint, app) = command_context(&window, &state)?;
    run_git_task(app, "stage_all", move || git::stage_all(&path_hint)).await
}

#[tauri::command]
async fn unstage_all(
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<(), GitCommandFailure> {
    let (path_hint, app) = command_context(&window, &state)?;
    run_git_task(app, "unstage_all", move || git::unstage_all(&path_hint)).await
}

#[tauri::command]
async fn commit_changes(
    window: Window,
    state: tauri::State<'_, AppState>,
    message: String,
) -> Result<CommitResult, GitCommandFailure> {
    let (path_hint, app) = command_context(&window, &state)?;
    run_git_task(app, "commit_changes", move || {
        git::commit_changes(&path_hint, &message)
    })
    .await
}

#[tauri::command]
async fn get_file_diff(
    window: Window,
    state: tauri::State<'_, AppState>,
    path: String,
    staged: bool,
) -> Result<FileDiff, GitCommandFailure> {
    let (path_hint, app) = command_context(&window, &state)?;
    run_git_task(app, "get_file_diff", move || {
        git::file_diff(&path_hint, &path, staged)
    })
    .await
}

#[tauri::command]
async fn push_changes(
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<PushResult, GitCommandFailure> {
    let (path_hint, app) = command_context(&window, &state)?;
    run_git_task(app, "push_changes", move || git::push(&path_hint)).await
}

#[tauri::command]
async fn get_branch_diff(
    window: Window,
    state: tauri::State<'_, AppState>,
    base_ref: String,
    compare_ref: String,
) -> Result<BranchDiffResult, GitCommandFailure> {
    let (path_hint, app) = command_context(&window, &state)?;
    run_git_task(app, "get_branch_diff", move || {
        git::branch_diff(&path_hint, &base_ref, &compare_ref)
    })
    .await
}

fn command_context(
    window: &Window,
    state: &tauri::State<'_, AppState>,
) -> Result<(PathBuf, AppHandle), GitCommandFailure> {
    let app = window.app_handle().clone();

    match state.repository_for_window(window.label()) {
        Ok(path) => Ok((path, app)),
        Err(error) => {
            app.exit(1);
            Err(error)
        }
    }
}

async fn run_git_task<T, F>(
    app: AppHandle,
    task_name: &'static str,
    task: F,
) -> Result<T, GitCommandFailure>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, GitCommandFailure> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| GitCommandFailure {
            command: format!("gitboss {task_name}"),
            error: format!("Git worker task failed: {error}"),
        })
        .inspect_err(|_| app.exit(1))?
}

fn state_failure() -> GitCommandFailure {
    GitCommandFailure {
        command: INTERNAL_STATE_COMMAND.to_string(),
        error: "The repository window registry is unavailable because its lock was poisoned."
            .to_string(),
    }
}

fn normalized_repository_path(path_hint: &Path) -> PathBuf {
    if let Ok(repository_path) = git::resolve_repository_path(path_hint) {
        return repository_path;
    }

    std::fs::canonicalize(path_hint).unwrap_or_else(|_| path_hint.to_path_buf())
}

fn handle_launch_request(app: &AppHandle, request: LaunchRequest) {
    let Some(path_hint) = git::forwarded_path_hint(&request.args, Path::new(&request.cwd)) else {
        if let Err(error) = focus_any_window(app) {
            stop_after_internal_failure(app, error);
        }
        return;
    };
    let repository_path = normalized_repository_path(&path_hint);

    if let Err(error) = open_repository_window(app, repository_path) {
        stop_after_internal_failure(app, error);
    }
}

fn start_instance_dispatcher(app: AppHandle, owner: InstanceOwner) -> Result<(), String> {
    let InstanceOwner { guard, receiver } = owner;
    if !app.manage(guard) {
        return Err("The GitBoss process lock was already registered.".to_string());
    }

    std::thread::Builder::new()
        .name("gitboss-instance-dispatch".to_string())
        .spawn(move || {
            while let Ok(message) = receiver.recv() {
                match message {
                    InstanceMessage::Launch(request) => handle_launch_request(&app, request),
                    InstanceMessage::Fatal(error) => {
                        stop_after_internal_failure(&app, error);
                        return;
                    }
                }
            }

            stop_after_internal_failure(
                &app,
                "The local GitBoss IPC channel closed unexpectedly.".to_string(),
            );
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to start the GitBoss launch dispatcher: {error}"))
}

fn open_repository_window(app: &AppHandle, repository_path: PathBuf) -> Result<(), String> {
    let state = app.state::<AppState>();

    loop {
        match state.reserve_window(repository_path.clone())? {
            WindowReservation::Existing(label) => {
                if app.get_webview_window(&label).is_some() {
                    return focus_window(app, &label);
                }

                state.forget_window(&label)?;
            }
            WindowReservation::New(label) => {
                let title = repository_window_title(&repository_path);
                let window = tauri::WebviewWindowBuilder::new(
                    app,
                    &label,
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title(title)
                .inner_size(1120.0, 760.0)
                .min_inner_size(860.0, 620.0)
                .build()
                .map_err(|error| {
                    let _ = state.forget_window(&label);
                    format!("Failed to create repository window {label:?}: {error}")
                })?;

                window
                    .set_focus()
                    .map_err(|error| format!("Failed to focus window {label:?}: {error}"))?;
                return Ok(());
            }
        }
    }
}

fn focus_any_window(app: &AppHandle) -> Result<(), String> {
    let label = app
        .state::<AppState>()
        .any_window_label()?
        .ok_or_else(|| "The running GitBoss process has no repository windows.".to_string())?;

    focus_window(app, &label)
}

fn focus_window(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("Repository window {label:?} is not available."))?;

    window
        .unminimize()
        .map_err(|error| format!("Failed to restore window {label:?}: {error}"))?;
    window
        .show()
        .map_err(|error| format!("Failed to show window {label:?}: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus window {label:?}: {error}"))
}

fn repository_window_title(repository_path: &Path) -> String {
    repository_path
        .file_name()
        .map(|name| format!("{} — GitBoss", name.to_string_lossy()))
        .unwrap_or_else(|| "GitBoss".to_string())
}

fn stop_after_internal_failure(app: &AppHandle, error: String) {
    eprintln!("GitBoss stopped after an internal failure: {error}");
    app.exit(1);
}

pub fn run() {
    let instance_owner = match instance::claim_or_forward() {
        Ok(InstanceClaim::Primary(owner)) => owner,
        Ok(InstanceClaim::Forwarded) => return,
        Err(error) => {
            eprintln!("GitBoss refused to start: {error}");
            std::process::exit(1);
        }
    };
    let initial_path_hint = git::initial_path_hint();
    let initial_state_path =
        std::fs::canonicalize(&initial_path_hint).unwrap_or_else(|_| initial_path_hint.clone());

    let result = tauri::Builder::default()
        .manage(AppState::new(initial_state_path))
        .setup(move |app| {
            let initial_path = normalized_repository_path(&initial_path_hint);

            if let Err(error) = app
                .state::<AppState>()
                .set_repository_for_window(MAIN_WINDOW_LABEL, initial_path)
            {
                eprintln!("GitBoss refused to start: {error}");
                std::process::exit(1);
            }

            if let Err(error) = start_instance_dispatcher(app.handle().clone(), instance_owner) {
                eprintln!("GitBoss refused to start: {error}");
                std::process::exit(1);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }

            match window
                .app_handle()
                .state::<AppState>()
                .forget_window(window.label())
            {
                Ok(true) => window.app_handle().exit(0),
                Ok(false) => {}
                Err(error) => stop_after_internal_failure(window.app_handle(), error),
            }
        })
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
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("GitBoss failed to run: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{AppState, WindowReservation, MAIN_WINDOW_LABEL};
    use std::path::PathBuf;

    #[test]
    fn reuses_the_existing_window_for_the_same_repository() {
        let state = AppState::new(PathBuf::from("/repos/one"));

        assert_eq!(
            state.reserve_window(PathBuf::from("/repos/one")).unwrap(),
            WindowReservation::Existing(MAIN_WINDOW_LABEL.to_string())
        );
    }

    #[test]
    fn reserves_one_new_window_per_repository() {
        let state = AppState::new(PathBuf::from("/repos/one"));

        assert_eq!(
            state.reserve_window(PathBuf::from("/repos/two")).unwrap(),
            WindowReservation::New("repo-1".to_string())
        );
        assert_eq!(
            state.reserve_window(PathBuf::from("/repos/two")).unwrap(),
            WindowReservation::Existing("repo-1".to_string())
        );
    }

    #[test]
    fn reports_when_the_last_repository_window_is_removed() {
        let state = AppState::new(PathBuf::from("/repos/one"));

        assert!(state.forget_window(MAIN_WINDOW_LABEL).unwrap());
    }
}
