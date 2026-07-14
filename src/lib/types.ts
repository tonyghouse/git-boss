export interface GitFileChange {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  displayStatus: string;
  staged: boolean;
  unstaged: boolean;
}

export type GitRefKind = "localBranch" | "remoteBranch" | "tag";

export interface GitRef {
  name: string;
  kind: GitRefKind;
  isCurrent: boolean;
}

export interface RepositoryStatus {
  repoPath: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  stagedFiles: GitFileChange[];
  unstagedFiles: GitFileChange[];
  refs: GitRef[];
  defaultBranch: string | null;
  isClean: boolean;
}

export interface CommitResult {
  summary: string;
}

export interface FileDiff {
  path: string;
  staged: boolean;
  content: string;
}

export interface PushResult {
  summary: string;
}

export interface BranchDiffFile {
  path: string;
  originalPath: string | null;
  status: string;
}

export interface BranchDiffResult {
  baseRef: string;
  compareRef: string;
  summary: string;
  baseOnly: number;
  compareOnly: number;
  files: BranchDiffFile[];
  content: string;
}

export interface GitCommandFailure {
  command: string;
  error: string;
}
