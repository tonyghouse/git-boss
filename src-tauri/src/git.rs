use crate::models::{
    BranchDiffFile, BranchDiffResult, CommitResult, FileDiff, GitCommandFailure, GitFileChange,
    GitRef, PushResult, RepositoryStatus,
};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

pub fn resolve_repository_path(path_hint: &Path) -> Result<PathBuf, GitCommandFailure> {
    let output = run_git_raw(path_hint, &["rev-parse", "--show-toplevel"])?;
    let repo_path = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if repo_path.is_empty() {
        return Err(GitCommandFailure {
            command: display_command(path_hint, &["rev-parse", "--show-toplevel"]),
            error: "Git did not return a repository root.".to_string(),
        });
    }

    Ok(PathBuf::from(repo_path))
}

pub fn repository_status(path_hint: &Path) -> Result<RepositoryStatus, GitCommandFailure> {
    let repo_path = resolve_repository_path(path_hint)?;
    let output = run_git_raw(&repo_path, &["status", "--porcelain=v1", "--branch", "-z"])?;
    let status_output = String::from_utf8_lossy(&output.stdout);
    let parsed = parse_status(&status_output);
    let refs = list_refs(&repo_path)?;
    let default_branch = default_branch(&repo_path, &refs);
    let mut staged_files = Vec::new();
    let mut unstaged_files = Vec::new();

    for change in parsed.files {
        if change.staged {
            staged_files.push(change.clone());
        }

        if change.unstaged {
            unstaged_files.push(change);
        }
    }

    let is_clean = staged_files.is_empty() && unstaged_files.is_empty();

    Ok(RepositoryStatus {
        repo_path: repo_path.to_string_lossy().to_string(),
        branch: parsed.branch,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        staged_files,
        unstaged_files,
        refs,
        default_branch,
        is_clean,
    })
}

pub fn stage_file(path_hint: &Path, path: &str) -> Result<(), GitCommandFailure> {
    let repo_path = resolve_repository_path(path_hint)?;
    run_git_raw(&repo_path, &["add", "--", path])?;
    Ok(())
}

pub fn unstage_file(path_hint: &Path, path: &str) -> Result<(), GitCommandFailure> {
    let repo_path = resolve_repository_path(path_hint)?;

    if repository_has_head(&repo_path) {
        run_git_raw(&repo_path, &["restore", "--staged", "--", path])?;
    } else {
        run_git_raw(&repo_path, &["rm", "--cached", "--", path])?;
    }

    Ok(())
}

pub fn stage_all(path_hint: &Path) -> Result<(), GitCommandFailure> {
    let repo_path = resolve_repository_path(path_hint)?;
    run_git_raw(&repo_path, &["add", "-A"])?;
    Ok(())
}

pub fn unstage_all(path_hint: &Path) -> Result<(), GitCommandFailure> {
    let repo_path = resolve_repository_path(path_hint)?;

    if repository_has_head(&repo_path) {
        run_git_raw(&repo_path, &["restore", "--staged", "--", "."])?;
    } else {
        run_git_raw(&repo_path, &["rm", "--cached", "-r", "--", "."])?;
    }

    Ok(())
}

pub fn commit_changes(path_hint: &Path, message: &str) -> Result<CommitResult, GitCommandFailure> {
    let repo_path = resolve_repository_path(path_hint)?;
    let trimmed_message = message.trim();

    if trimmed_message.is_empty() {
        return Err(GitCommandFailure {
            command: display_command(&repo_path, &["commit", "-m", ""]),
            error: "Commit message cannot be empty.".to_string(),
        });
    }

    ensure_staged_changes(&repo_path)?;

    let output = run_git_raw(&repo_path, &["commit", "-m", trimmed_message])?;
    let summary = first_output_line(&output).unwrap_or_else(|| "Commit created.".to_string());

    Ok(CommitResult { summary })
}

pub fn file_diff(
    path_hint: &Path,
    path: &str,
    staged: bool,
) -> Result<FileDiff, GitCommandFailure> {
    let repo_path = resolve_repository_path(path_hint)?;
    let output = if staged {
        run_git_raw(&repo_path, &["diff", "--cached", "--", path])?
    } else if is_untracked_file(&repo_path, path)? {
        let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };

        run_git_raw_allow_exit_codes(
            &repo_path,
            &["diff", "--no-index", "--", null_path, path],
            &[0, 1],
        )?
    } else {
        run_git_raw(&repo_path, &["diff", "--", path])?
    };

    Ok(FileDiff {
        path: path.to_string(),
        staged,
        content: String::from_utf8_lossy(&output.stdout).to_string(),
    })
}

pub fn push(path_hint: &Path) -> Result<PushResult, GitCommandFailure> {
    let repo_path = resolve_repository_path(path_hint)?;
    let output = run_git_raw(&repo_path, &["push"])?;
    let summary = first_output_line(&output).unwrap_or_else(|| "Push completed.".to_string());

    Ok(PushResult { summary })
}

pub fn branch_diff(
    path_hint: &Path,
    base_ref: &str,
    compare_ref: &str,
) -> Result<BranchDiffResult, GitCommandFailure> {
    let repo_path = resolve_repository_path(path_hint)?;
    let base_ref = base_ref.trim();
    let compare_ref = compare_ref.trim();

    if base_ref.is_empty() || compare_ref.is_empty() {
        return Err(GitCommandFailure {
            command: display_command(&repo_path, &["diff", "--find-renames"]),
            error: "Choose both refs before comparing.".to_string(),
        });
    }

    ensure_commit_ref(&repo_path, base_ref)?;
    ensure_commit_ref(&repo_path, compare_ref)?;

    let range = branch_diff_range(&repo_path, base_ref, compare_ref)?;
    let files_output = run_git_raw(
        &repo_path,
        &["diff", "--name-status", "-z", "--find-renames", &range],
    )?;
    let files = parse_branch_diff_files(&String::from_utf8_lossy(&files_output.stdout));
    let summary_output = run_git_raw(
        &repo_path,
        &["diff", "--shortstat", "--find-renames", &range],
    )?;
    let summary = first_output_line(&summary_output)
        .unwrap_or_else(|| "No file changes between these refs.".to_string());
    let counts = branch_distance(&repo_path, base_ref, compare_ref)?;
    let content_output = run_git_raw(
        &repo_path,
        &["diff", "--patch", "--find-renames", "--no-ext-diff", &range],
    )?;

    Ok(BranchDiffResult {
        base_ref: base_ref.to_string(),
        compare_ref: compare_ref.to_string(),
        summary,
        base_only: counts.0,
        compare_only: counts.1,
        files,
        content: String::from_utf8_lossy(&content_output.stdout).to_string(),
    })
}

struct ParsedStatus {
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<GitFileChange>,
}

fn parse_status(output: &str) -> ParsedStatus {
    let records: Vec<&str> = output
        .split('\0')
        .filter(|record| !record.is_empty())
        .collect();
    let mut parsed = ParsedStatus {
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    };
    let mut index = 0;

    while index < records.len() {
        let record = records[index];

        if let Some(branch_record) = record.strip_prefix("## ") {
            parse_branch_record(branch_record, &mut parsed);
            index += 1;
            continue;
        }

        let bytes = record.as_bytes();
        if bytes.len() < 4 {
            index += 1;
            continue;
        }

        let index_status = bytes[0] as char;
        let worktree_status = bytes[1] as char;
        let path = record[3..].to_string();
        let mut original_path = None;

        if matches!(index_status, 'R' | 'C') || matches!(worktree_status, 'R' | 'C') {
            if let Some(next_record) = records.get(index + 1) {
                original_path = Some((*next_record).to_string());
                index += 1;
            }
        }

        let staged = index_status != ' ' && index_status != '?';
        let unstaged = worktree_status != ' ' || index_status == '?';
        let display_status = display_status(index_status, worktree_status);

        parsed.files.push(GitFileChange {
            path,
            original_path,
            index_status: index_status.to_string(),
            worktree_status: worktree_status.to_string(),
            display_status,
            staged,
            unstaged,
        });

        index += 1;
    }

    parsed
}

fn parse_branch_record(record: &str, parsed: &mut ParsedStatus) {
    parse_ahead_behind(record, parsed);

    let without_counts = record
        .split_once(" [")
        .map(|(branch_part, _)| branch_part)
        .unwrap_or(record);

    if let Some(branch) = without_counts.strip_prefix("No commits yet on ") {
        parsed.branch = Some(branch.to_string());
        return;
    }

    if without_counts == "HEAD (no branch)" {
        parsed.branch = Some("HEAD".to_string());
        return;
    }

    if let Some((branch, upstream)) = without_counts.split_once("...") {
        parsed.branch = Some(branch.to_string());
        parsed.upstream = Some(upstream.to_string());
        return;
    }

    parsed.branch = without_counts
        .split_whitespace()
        .next()
        .map(|branch| branch.to_string());
}

fn parse_ahead_behind(record: &str, parsed: &mut ParsedStatus) {
    let Some((_, counts)) = record.split_once('[') else {
        return;
    };
    let counts = counts.trim_end_matches(']');

    for count in counts.split(',').map(str::trim) {
        if let Some(value) = count.strip_prefix("ahead ") {
            parsed.ahead = value.parse().unwrap_or(0);
        }

        if let Some(value) = count.strip_prefix("behind ") {
            parsed.behind = value.parse().unwrap_or(0);
        }
    }
}

fn display_status(index_status: char, worktree_status: char) -> String {
    if index_status == '?' && worktree_status == '?' {
        return "??".to_string();
    }

    let index_display = if index_status == ' ' {
        '.'
    } else {
        index_status
    };
    let worktree_display = if worktree_status == ' ' {
        '.'
    } else {
        worktree_status
    };

    format!("{index_display}{worktree_display}")
}

fn list_refs(repo_path: &Path) -> Result<Vec<GitRef>, GitCommandFailure> {
    let output = run_git_raw(
        repo_path,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(HEAD)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    let refs_output = String::from_utf8_lossy(&output.stdout);
    let mut refs = Vec::new();

    for line in refs_output.lines() {
        let fields: Vec<&str> = line.split('\0').collect();
        let [full_name, name, head_marker, ..] = fields.as_slice() else {
            continue;
        };

        if name.is_empty() || name.ends_with("/HEAD") {
            continue;
        }

        let kind = if full_name.starts_with("refs/heads/") {
            "localBranch"
        } else if full_name.starts_with("refs/remotes/") {
            "remoteBranch"
        } else if full_name.starts_with("refs/tags/") {
            "tag"
        } else {
            continue;
        };

        refs.push(GitRef {
            name: (*name).to_string(),
            kind: kind.to_string(),
            is_current: *head_marker == "*",
        });
    }

    refs.sort_by(|left, right| {
        ref_kind_order(&left.kind)
            .cmp(&ref_kind_order(&right.kind))
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(refs)
}

fn ref_kind_order(kind: &str) -> u8 {
    match kind {
        "localBranch" => 0,
        "remoteBranch" => 1,
        "tag" => 2,
        _ => 3,
    }
}

fn default_branch(repo_path: &Path, refs: &[GitRef]) -> Option<String> {
    if let Ok(output) = run_git_raw_allow_exit_codes(
        repo_path,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        &[0, 1],
    ) {
        if output.status.success() {
            let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

            if refs.iter().any(|git_ref| git_ref.name == branch) {
                return Some(branch);
            }
        }
    }

    [
        "origin/main",
        "origin/master",
        "upstream/main",
        "upstream/master",
        "main",
        "master",
        "develop",
    ]
    .into_iter()
    .find(|candidate| refs.iter().any(|git_ref| git_ref.name == *candidate))
    .map(str::to_string)
}

fn ensure_commit_ref(repo_path: &Path, reference: &str) -> Result<(), GitCommandFailure> {
    let commit_ref = format!("{reference}^{{commit}}");
    run_git_raw(repo_path, &["rev-parse", "--verify", &commit_ref])?;
    Ok(())
}

fn branch_distance(
    repo_path: &Path,
    base_ref: &str,
    compare_ref: &str,
) -> Result<(u32, u32), GitCommandFailure> {
    let range = format!("{base_ref}...{compare_ref}");
    let output = run_git_raw(repo_path, &["rev-list", "--left-right", "--count", &range])?;
    let counts = String::from_utf8_lossy(&output.stdout);
    let mut parts = counts.split_whitespace();
    let base_only = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let compare_only = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);

    Ok((base_only, compare_only))
}

fn branch_diff_range(
    repo_path: &Path,
    base_ref: &str,
    compare_ref: &str,
) -> Result<String, GitCommandFailure> {
    let output = run_git_raw_allow_exit_codes(
        repo_path,
        &["merge-base", base_ref, compare_ref],
        &[0, 1],
    )?;

    if output.status.code() == Some(0) {
        Ok(format!("{base_ref}...{compare_ref}"))
    } else {
        Ok(format!("{base_ref}..{compare_ref}"))
    }
}

fn parse_branch_diff_files(output: &str) -> Vec<BranchDiffFile> {
    let records: Vec<&str> = output
        .split('\0')
        .filter(|record| !record.is_empty())
        .collect();
    let mut files = Vec::new();
    let mut index = 0;

    while index < records.len() {
        let status = records[index].to_string();
        index += 1;

        if status.starts_with('R') || status.starts_with('C') {
            let Some(original_path) = records.get(index) else {
                break;
            };
            let Some(path) = records.get(index + 1) else {
                break;
            };

            files.push(BranchDiffFile {
                path: (*path).to_string(),
                original_path: Some((*original_path).to_string()),
                status,
            });
            index += 2;
            continue;
        }

        let Some(path) = records.get(index) else {
            break;
        };

        files.push(BranchDiffFile {
            path: (*path).to_string(),
            original_path: None,
            status,
        });
        index += 1;
    }

    files
}

fn ensure_staged_changes(repo_path: &Path) -> Result<(), GitCommandFailure> {
    let args = ["diff", "--cached", "--quiet", "--exit-code"];
    let command = display_command(repo_path, &args);
    let status = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .status()
        .map_err(|err| GitCommandFailure {
            command: command.clone(),
            error: err.to_string(),
        })?;

    match status.code() {
        Some(0) => Err(GitCommandFailure {
            command,
            error: "There are no staged changes to commit.".to_string(),
        }),
        Some(1) => Ok(()),
        Some(code) => Err(GitCommandFailure {
            command,
            error: format!("Git exited with status code {code}."),
        }),
        None => Err(GitCommandFailure {
            command,
            error: "Git terminated before reporting an exit code.".to_string(),
        }),
    }
}

fn repository_has_head(repo_path: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["rev-parse", "--verify", "HEAD"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn is_untracked_file(repo_path: &Path, path: &str) -> Result<bool, GitCommandFailure> {
    let output = run_git_raw(
        repo_path,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            path,
        ],
    )?;

    Ok(!output.stdout.is_empty())
}

fn run_git_raw(repo_path: &Path, args: &[&str]) -> Result<Output, GitCommandFailure> {
    run_git_raw_allow_exit_codes(repo_path, args, &[0])
}

fn run_git_raw_allow_exit_codes(
    repo_path: &Path,
    args: &[&str],
    allowed_exit_codes: &[i32],
) -> Result<Output, GitCommandFailure> {
    let command = display_command(repo_path, args);
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|err| GitCommandFailure {
            command: command.clone(),
            error: err.to_string(),
        })?;

    if output
        .status
        .code()
        .is_some_and(|code| allowed_exit_codes.contains(&code))
    {
        return Ok(output);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let error = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!(
            "Git exited with status code {}.",
            output
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string())
        )
    };

    Err(GitCommandFailure { command, error })
}

fn first_output_line(output: &Output) -> Option<String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

pub fn initial_path_hint() -> PathBuf {
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let path_arg = std::env::args_os().skip(1).find(is_project_arg);
    let path = path_arg.map(PathBuf::from).unwrap_or(current_dir.clone());

    resolve_path_hint(path, &current_dir)
}

pub fn forwarded_path_hint(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let current_dir = if cwd.as_os_str().is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        cwd.to_path_buf()
    };
    let path = args
        .iter()
        .skip(1)
        .map(OsString::from)
        .find(is_project_arg)
        .map(PathBuf::from)?;

    Some(resolve_path_hint(path, &current_dir))
}

fn resolve_path_hint(path: PathBuf, current_dir: &Path) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        current_dir.join(path)
    }
}

fn is_project_arg(arg: &OsString) -> bool {
    let value = arg.to_string_lossy();

    !value.is_empty() && value != "--" && !value.starts_with("--") && !value.starts_with("-psn_")
}

fn display_command(repo_path: &Path, args: &[&str]) -> String {
    let mut parts = vec![
        "git".to_string(),
        "-C".to_string(),
        quote_arg(repo_path.to_string_lossy().as_ref()),
    ];

    parts.extend(args.iter().map(|arg| quote_arg(arg)));
    parts.join(" ")
}

fn quote_arg(value: &str) -> String {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "/._-:".contains(character))
    {
        return value.to_string();
    }

    format!("{value:?}")
}

#[cfg(test)]
mod tests {
    use super::forwarded_path_hint;
    use std::path::{Path, PathBuf};

    #[test]
    fn resolves_forwarded_relative_repository_from_launch_directory() {
        let args = vec!["gitboss".to_string(), "projects/example".to_string()];

        assert_eq!(
            forwarded_path_hint(&args, Path::new("/workspace")),
            Some(PathBuf::from("/workspace/projects/example"))
        );
    }

    #[test]
    fn ignores_launch_metadata_without_creating_repository_context() {
        let args = vec![
            "gitboss".to_string(),
            "--".to_string(),
            "-psn_0_12345".to_string(),
        ];

        assert_eq!(forwarded_path_hint(&args, Path::new("/workspace")), None);
    }
}
