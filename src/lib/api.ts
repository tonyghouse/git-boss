import { invoke } from "@tauri-apps/api/core";
import type {
  BranchDiffResult,
  CommitResult,
  FileDiff,
  PushResult,
  RepositoryStatus,
} from "./types";

export const api = {
  getRepositoryStatus: () =>
    invoke<RepositoryStatus>("get_repository_status"),
  stageFile: (path: string) => invoke<void>("stage_file", { path }),
  unstageFile: (path: string) => invoke<void>("unstage_file", { path }),
  stageAll: () => invoke<void>("stage_all"),
  unstageAll: () => invoke<void>("unstage_all"),
  commit: (message: string) => invoke<CommitResult>("commit_changes", { message }),
  getFileDiff: (path: string, staged: boolean) =>
    invoke<FileDiff>("get_file_diff", { path, staged }),
  push: () => invoke<PushResult>("push_changes"),
  getBranchDiff: (baseRef: string, compareRef: string) =>
    invoke<BranchDiffResult>("get_branch_diff", { baseRef, compareRef }),
};
