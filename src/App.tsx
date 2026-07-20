import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  CircleDot,
  Eye,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Minus,
  Moon,
  Plus,
  RefreshCw,
  Settings,
  SquareTerminal,
  Sun,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import appIcon from "../src-tauri/icons/icon.png";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { api } from "./lib/api";
import type {
  BranchDiffFile,
  BranchDiffResult,
  GitCommandFailure,
  GitFileChange,
  GitRef,
  RepositoryStatus,
} from "./lib/types";
import { cn, folderNameFromPath } from "./lib/utils";

type ToastState = {
  id: number;
  title: string;
  description: string;
  command?: string;
  tone: "success" | "error";
};

type Theme = "dark" | "light";
type ActiveView = "committer" | "branch-diff";
type FileLane = "unstaged" | "staged";
type DiffMode = "inline" | "split";

type SelectedFile = {
  path: string;
  lane: FileLane;
};

type DiffState = {
  loading: boolean;
  file: SelectedFile | null;
  content: string;
  failure: GitCommandFailure | null;
};

type BranchDiffState = {
  loading: boolean;
  result: BranchDiffResult | null;
  failure: GitCommandFailure | null;
};

type BranchDiffPreset = {
  id: string;
  label: string;
  baseRef: string | null;
  compareRef: string | null;
};

const themeStorageKey = "gitboss.theme";
const dragMimeType = "application/x-gitboss-file";

const statusNames: Record<string, string> = {
  A: "Added",
  C: "Copied",
  D: "Deleted",
  M: "Modified",
  R: "Renamed",
  T: "Type",
  U: "Conflict",
  "?": "Untracked",
};

function initialTheme(): Theme {
  if (typeof window === "undefined") {
    return "dark";
  }

  const savedTheme = window.localStorage.getItem(themeStorageKey);

  if (savedTheme === "light" || savedTheme === "dark") {
    return savedTheme;
  }

  return "dark";
}

function persistTheme(theme: Theme) {
  window.localStorage.setItem(themeStorageKey, theme);
}

function normalizeFailure(err: unknown): GitCommandFailure {
  if (
    typeof err === "object" &&
    err !== null &&
    "command" in err &&
    "error" in err
  ) {
    const failure = err as { command: unknown; error: unknown };

    return {
      command: String(failure.command),
      error: String(failure.error),
    };
  }

  if (typeof err === "string") {
    try {
      const parsed = JSON.parse(err) as Partial<GitCommandFailure>;

      if (parsed.command && parsed.error) {
        return {
          command: parsed.command,
          error: parsed.error,
        };
      }
    } catch {
      return {
        command: "gitboss",
        error: err,
      };
    }
  }

  return {
    command: "gitboss",
    error: err instanceof Error ? err.message : String(err),
  };
}

function statusLabel(change: GitFileChange) {
  if (change.displayStatus === "??") {
    return "Untracked";
  }

  const status = change.staged ? change.indexStatus : change.worktreeStatus;
  return statusNames[status] ?? change.displayStatus;
}

function branchSummary(status: RepositoryStatus) {
  const parts = [];

  if (status.upstream) {
    parts.push(status.upstream);
  }

  if (status.ahead > 0) {
    parts.push(`ahead ${status.ahead}`);
  }

  if (status.behind > 0) {
    parts.push(`behind ${status.behind}`);
  }

  return parts.join(" · ");
}

function defaultBranchDiffBase(status: RepositoryStatus) {
  return (
    status.defaultBranch ??
    status.upstream ??
    (status.refs.some((gitRef) => gitRef.name === "origin/develop")
      ? "origin/develop"
      : status.refs[0]?.name) ??
    ""
  );
}

function defaultBranchDiffCompare(status: RepositoryStatus) {
  return status.branch ?? "HEAD";
}

function refKindLabel(kind: GitRef["kind"]) {
  if (kind === "localBranch") {
    return "Local";
  }

  if (kind === "remoteBranch") {
    return "Remote";
  }

  return "Tag";
}

function branchDiffStatusLabel(file: BranchDiffFile) {
  const status = file.status[0] ?? file.status;

  if (status === "R") {
    return "Renamed";
  }

  if (status === "C") {
    return "Copied";
  }

  return statusNames[status] ?? file.status;
}

function selectedFileKey(file: SelectedFile | null) {
  return file ? `${file.lane}:${file.path}` : null;
}

function splitRepoPath(path: string) {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

  if (separatorIndex < 0) {
    return {
      directory: "",
      filename: path,
    };
  }

  return {
    directory: path.slice(0, separatorIndex + 1),
    filename: path.slice(separatorIndex + 1),
  };
}

function RepoPathText({ path, className }: { path: string; className?: string }) {
  const { directory, filename } = splitRepoPath(path);

  return (
    <span
      title={path}
      className={cn("flex min-w-0 items-baseline", className)}
    >
      {directory ? (
        <span className="min-w-0 truncate text-current opacity-75">
          {directory}
        </span>
      ) : null}
      <span className="shrink-0">{filename || path}</span>
    </span>
  );
}

function isFileLane(value: unknown): value is FileLane {
  return value === "staged" || value === "unstaged";
}

function useBodyScrollLock() {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);
}

function App() {
  const [status, setStatus] = useState<RepositoryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [failure, setFailure] = useState<GitCommandFailure | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("committer");
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [draggingFile, setDraggingFile] = useState<SelectedFile | null>(null);
  const [dragOverLane, setDragOverLane] = useState<FileLane | null>(null);
  const [stagingPanePercent, setStagingPanePercent] = useState(35);
  const [diffMode, setDiffMode] = useState<DiffMode>("inline");
  const [branchDiffBaseRef, setBranchDiffBaseRef] = useState("");
  const [branchDiffCompareRef, setBranchDiffCompareRef] = useState("");
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [diffState, setDiffState] = useState<DiffState>({
    loading: false,
    file: null,
    content: "",
    failure: null,
  });
  const [branchDiffState, setBranchDiffState] = useState<BranchDiffState>({
    loading: false,
    result: null,
    failure: null,
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    persistTheme(theme);
  }, [theme]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      const hasOnlyPrimaryModifier =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;

      if (event.key === "Escape" && settingsOpen) {
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }

      if (hasOnlyPrimaryModifier && key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setToast((currentToast) =>
        currentToast?.id === toast.id ? null : currentToast,
      );
    }, 6500);

    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  useEffect(() => {
    if (!status) {
      setSelectedFile(null);
      return;
    }

    if (selectedFile) {
      const files =
        selectedFile.lane === "staged"
          ? status.stagedFiles
          : status.unstagedFiles;
      const selectedStillExists = files.some(
        (file) => file.path === selectedFile.path,
      );

      if (selectedStillExists) {
        return;
      }
    }

    const nextUnstagedFile = status.unstagedFiles[0];
    const nextStagedFile = status.stagedFiles[0];

    if (nextUnstagedFile) {
      setSelectedFile({ path: nextUnstagedFile.path, lane: "unstaged" });
      return;
    }

    if (nextStagedFile) {
      setSelectedFile({ path: nextStagedFile.path, lane: "staged" });
      return;
    }

    setSelectedFile(null);
  }, [selectedFile, status]);

  useEffect(() => {
    if (!status) {
      setBranchDiffBaseRef("");
      setBranchDiffCompareRef("");
      setBranchDiffState({
        loading: false,
        result: null,
        failure: null,
      });
      return;
    }

    setBranchDiffBaseRef((currentRef) =>
      currentRef || defaultBranchDiffBase(status),
    );
    setBranchDiffCompareRef((currentRef) =>
      currentRef || defaultBranchDiffCompare(status),
    );
  }, [status]);

  useEffect(() => {
    let cancelled = false;

    if (!status || !selectedFile) {
      setDiffState({
        loading: false,
        file: null,
        content: "",
        failure: null,
      });
      return;
    }

    setDiffState({
      loading: true,
      file: selectedFile,
      content: "",
      failure: null,
    });

    void api
      .getFileDiff(selectedFile.path, selectedFile.lane === "staged")
      .then((diff) => {
        if (!cancelled) {
          setDiffState({
            loading: false,
            file: selectedFile,
            content: diff.content,
            failure: null,
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDiffState({
            loading: false,
            file: selectedFile,
            content: "",
            failure: normalizeFailure(err),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFile, status]);

  const repoName = useMemo(
    () => (status ? folderNameFromPath(status.repoPath) : "GitBoss"),
    [status],
  );

  function showToast(
    title: string,
    description: string,
    tone: ToastState["tone"],
    command?: string,
  ) {
    setToast({
      id: Date.now(),
      title,
      description,
      command,
      tone,
    });
  }

  async function loadStatus(showInitialLoading = false) {
    if (showInitialLoading) {
      setLoading(true);
    }

    try {
      const nextStatus = await api.getRepositoryStatus();
      setStatus(nextStatus);
      setFailure(null);
    } catch (err) {
      const nextFailure = normalizeFailure(err);
      setFailure(nextFailure);
      showToast("Git command failed", nextFailure.error, "error", nextFailure.command);
    } finally {
      if (showInitialLoading) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void loadStatus(true);
  }, []);

  async function runGitAction(
    actionId: string,
    action: () => Promise<unknown>,
    successMessage?: string,
  ) {
    setBusyAction(actionId);

    try {
      await action();
      await loadStatus();

      if (successMessage) {
        showToast("Done", successMessage, "success");
      }
    } catch (err) {
      const nextFailure = normalizeFailure(err);
      showToast("Git command failed", nextFailure.error, "error", nextFailure.command);
    } finally {
      setBusyAction(null);
    }
  }

  async function moveFile(path: string, targetLane: FileLane) {
    const actionId = targetLane === "staged" ? `stage:${path}` : `unstage:${path}`;

    await runGitAction(actionId, async () => {
      if (targetLane === "staged") {
        await api.stageFile(path);
      } else {
        await api.unstageFile(path);
      }

      setSelectedFile({ path, lane: targetLane });
    });
  }

  async function stageAllChanges() {
    const firstUnstagedPath = status?.unstagedFiles[0]?.path;

    await runGitAction(
      "stage-all",
      async () => {
        await api.stageAll();

        if (firstUnstagedPath) {
          setSelectedFile({ path: firstUnstagedPath, lane: "staged" });
        }
      },
      `${unstagedCount} ${unstagedCount === 1 ? "file" : "files"} staged`,
    );
  }

  async function unstageAllChanges() {
    const firstStagedPath = status?.stagedFiles[0]?.path;

    await runGitAction(
      "unstage-all",
      async () => {
        await api.unstageAll();

        if (firstStagedPath) {
          setSelectedFile({ path: firstStagedPath, lane: "unstaged" });
        }
      },
      `${stagedCount} ${stagedCount === 1 ? "file" : "files"} unstaged`,
    );
  }

  async function commitChanges() {
    const message = commitMessage.trim();

    if (!message) {
      showToast("Commit message required", "Write a commit message before committing.", "error");
      return;
    }

    await runGitAction(
      "commit",
      async () => {
        const result = await api.commit(message);
        setCommitMessage("");
        showToast("Committed", result.summary, "success");
      },
    );
  }

  async function pushChanges() {
    await runGitAction("push", async () => {
      const result = await api.push();
      showToast("Pushed", result.summary, "success");
    });
  }

  async function compareBranchRefs(
    baseRef = branchDiffBaseRef,
    compareRef = branchDiffCompareRef,
  ) {
    const nextBaseRef = baseRef.trim();
    const nextCompareRef = compareRef.trim();

    if (!nextBaseRef || !nextCompareRef) {
      showToast(
        "Refs required",
        "Choose both refs before comparing.",
        "error",
      );
      return;
    }

    setBranchDiffBaseRef(nextBaseRef);
    setBranchDiffCompareRef(nextCompareRef);
    setBranchDiffState({
      loading: true,
      result: null,
      failure: null,
    });

    try {
      const result = await api.getBranchDiff(nextBaseRef, nextCompareRef);
      setBranchDiffState({
        loading: false,
        result,
        failure: null,
      });
    } catch (err) {
      const nextFailure = normalizeFailure(err);
      setBranchDiffState({
        loading: false,
        result: null,
        failure: nextFailure,
      });
      showToast("Git command failed", nextFailure.error, "error", nextFailure.command);
    }
  }

  function clearBranchDiffResult() {
    setBranchDiffState((currentState) =>
      currentState.loading
        ? currentState
        : {
            loading: false,
            result: null,
            failure: null,
          },
    );
  }

  function updateBranchDiffBaseRef(ref: string) {
    setBranchDiffBaseRef(ref);
    clearBranchDiffResult();
  }

  function updateBranchDiffCompareRef(ref: string) {
    setBranchDiffCompareRef(ref);
    clearBranchDiffResult();
  }

  function applyBranchDiffPreset(preset: BranchDiffPreset) {
    if (!preset.baseRef || !preset.compareRef) {
      return;
    }

    setBranchDiffBaseRef(preset.baseRef);
    setBranchDiffCompareRef(preset.compareRef);
    void compareBranchRefs(preset.baseRef, preset.compareRef);
  }

  function swapBranchDiffRefs() {
    setBranchDiffBaseRef(branchDiffCompareRef);
    setBranchDiffCompareRef(branchDiffBaseRef);
    clearBranchDiffResult();
  }

  function handleFileDragStart(
    event: DragEvent<HTMLElement>,
    file: GitFileChange,
    lane: FileLane,
  ) {
    const payload = { path: file.path, lane };
    event.dataTransfer.setData(dragMimeType, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
    setDraggingFile(payload);
  }

  function handleLaneDragOver(event: DragEvent<HTMLElement>, lane: FileLane) {
    if (busyAction !== null || !draggingFile || draggingFile.lane === lane) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverLane(lane);
  }

  function handleLaneDrop(event: DragEvent<HTMLElement>, lane: FileLane) {
    event.preventDefault();
    setDragOverLane(null);

    if (busyAction !== null) {
      return;
    }

    const payload = readDragPayload(event);

    if (!payload || payload.lane === lane) {
      return;
    }

    void moveFile(payload.path, lane);
  }

  function handleLaneDragLeave(event: DragEvent<HTMLElement>) {
    const relatedTarget = event.relatedTarget;

    if (
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget)
    ) {
      return;
    }

    setDragOverLane(null);
  }

  function handleDragEnd() {
    setDraggingFile(null);
    setDragOverLane(null);
  }

  function startWorkspaceResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const workspace = workspaceRef.current;

    if (!workspace) {
      return;
    }

    event.preventDefault();

    const workspaceRect = workspace.getBoundingClientRect();

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextPercent =
        ((moveEvent.clientY - workspaceRect.top) / workspaceRect.height) * 100;

      setStagingPanePercent(Math.min(65, Math.max(24, nextPercent)));
    }

    function handlePointerUp() {
      document.removeEventListener("pointermove", handlePointerMove);
    }

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp, { once: true });
  }

  const stagedCount = status?.stagedFiles.length ?? 0;
  const unstagedCount = status?.unstagedFiles.length ?? 0;
  const totalCount = stagedCount + unstagedCount;
  const branchDetails = status ? branchSummary(status) : "";
  const selectedChange = selectedFile
    ? (selectedFile.lane === "staged"
        ? status?.stagedFiles
        : status?.unstagedFiles
      )?.find((file) => file.path === selectedFile.path) ?? null
    : null;
  const syncLabel = status
    ? status.upstream
      ? status.ahead > 0 || status.behind > 0
        ? `${status.ahead} up · ${status.behind} down`
        : "In sync"
      : "No upstream"
    : "No repo";
  const currentBranchRef = status ? defaultBranchDiffCompare(status) : null;
  const hasOriginDevelop =
    status?.refs.some((gitRef) => gitRef.name === "origin/develop") ?? false;
  const branchDiffPresets: BranchDiffPreset[] = status
    ? [
        {
          id: "origin-develop",
          label: "Current vs origin/develop",
          baseRef: hasOriginDevelop ? "origin/develop" : null,
          compareRef: currentBranchRef,
        },
        {
          id: "upstream",
          label: "Current vs upstream",
          baseRef: status.upstream,
          compareRef: currentBranchRef,
        },
        {
          id: "default",
          label: "Current vs default branch",
          baseRef: status.defaultBranch,
          compareRef: currentBranchRef,
        },
      ]
    : [];
  const activeViewTitle =
    activeView === "branch-diff" ? "Goated Branch Diff" : "Committer";

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <div className="flex h-screen min-h-screen w-full overflow-hidden">
        <aside className="flex w-14 shrink-0 flex-col items-center border-r border-slate-800 bg-slate-950 py-3 text-slate-400">
          <div
            className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]"
            title="GitBoss"
          >
            <img src={appIcon} alt="" className="h-7 w-7 rounded-md" />
          </div>

          <ActivityButton
            active={!settingsOpen && activeView === "committer"}
            icon={GitCommitHorizontal}
            title="Committer"
            onClick={() => setActiveView("committer")}
          />

          <ActivityButton
            active={!settingsOpen && activeView === "branch-diff"}
            icon={ArrowLeftRight}
            title="Goated Branch Diff"
            onClick={() => setActiveView("branch-diff")}
          />

          <div className="mt-auto">
            <ActivityButton
              active={settingsOpen}
              icon={Settings}
              title="Settings"
              onClick={() => setSettingsOpen(true)}
            />
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="z-20 flex shrink-0 flex-col gap-2 border-b border-slate-200 bg-white/90 px-4 py-2 shadow-[0_16px_40px_-36px_rgba(15,23,42,0.85)] backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/90 dark:shadow-black/50 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600 shadow-sm shadow-slate-950/5 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:shadow-black/20 md:hidden">
                  <SquareTerminal className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">{repoName}</h2>
                  <p className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">
                    {activeViewTitle}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {status?.branch ? (
                <Badge className="gap-1.5 border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
                  <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                  {status.branch}
                </Badge>
              ) : null}
              {branchDetails ? (
                <Badge className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
                  {branchDetails}
                </Badge>
              ) : null}
              {status ? (
                <Badge>
                  {status.isClean ? "Clean" : `${totalCount} changed`}
                </Badge>
              ) : null}
              <HeaderActionButton
                title="Refresh"
                icon={RefreshCw}
                iconClassName={loading ? "animate-spin" : undefined}
                disabled={loading || busyAction !== null}
                onClick={() => void loadStatus(true)}
              />
              <HeaderActionButton
                title="Settings"
                icon={Settings}
                onClick={() => setSettingsOpen(true)}
                className="md:hidden"
              />
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-hidden px-4 py-4 sm:px-5">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-hidden="true" />
              </div>
            ) : failure && !status ? (
              <section className="flex h-full items-center justify-center">
                <Card className="w-full max-w-2xl p-5">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden="true" />
                    <div className="min-w-0 space-y-3">
                      <div>
                        <h2 className="text-base font-semibold">Repository unavailable</h2>
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                          Open a Git working tree with <code className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-800 dark:bg-slate-900 dark:text-slate-200">gitboss .</code>
                        </p>
                      </div>
                      <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
                        <p className="break-words font-mono text-xs text-slate-600 dark:text-slate-300">
                          {failure.command}
                        </p>
                        <p className="whitespace-pre-wrap text-red-600 dark:text-red-300">
                          {failure.error}
                        </p>
                      </div>
                    </div>
                  </div>
                </Card>
              </section>
            ) : status ? (
              activeView === "committer" ? (
              <section className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-3">
                <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/80 px-2.5 py-2 shadow-sm shadow-slate-950/5 dark:border-slate-800 dark:bg-slate-950/70 dark:shadow-black/20">
                  <MetricPill label="Changed" value={String(totalCount)} />
                  <MetricPill label="Unstaged" value={String(unstagedCount)} />
                  <MetricPill label="Staged" value={String(stagedCount)} />
                  <MetricPill label="Upstream" value={syncLabel} />
                </div>

                <div ref={workspaceRef} className="flex min-h-0 flex-1 flex-col">
                  <div
                    className="grid min-h-0 shrink-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_22rem]"
                    style={{ height: `${stagingPanePercent}%` }}
                  >
                    <FileLanePanel
                      lane="unstaged"
                      title="Working Changes"
                      subtitle="Unstaged"
                      files={status.unstagedFiles}
                      emptyText={status.isClean ? "Working tree clean" : "No unstaged files"}
                      selectedFile={selectedFile}
                      busyAction={busyAction}
                      draggingFile={draggingFile}
                      dragOverLane={dragOverLane}
                      bulkAction={
                        unstagedCount > 0 ? (
                          <Button
                            variant="secondary"
                            onClick={() => void stageAllChanges()}
                            disabled={busyAction !== null}
                          >
                            <Plus className="h-4 w-4" aria-hidden="true" />
                            Stage all
                          </Button>
                        ) : null
                      }
                      onSelect={(file) => setSelectedFile({ path: file.path, lane: "unstaged" })}
                      onMoveFile={(path) => void moveFile(path, "staged")}
                      onDragStart={handleFileDragStart}
                      onDragEnd={handleDragEnd}
                      onDragOver={handleLaneDragOver}
                      onDragLeave={handleLaneDragLeave}
                      onDrop={handleLaneDrop}
                    />

                    <FileLanePanel
                      lane="staged"
                      title="Staged"
                      subtitle="Next commit"
                      files={status.stagedFiles}
                      emptyText="No staged files"
                      selectedFile={selectedFile}
                      busyAction={busyAction}
                      draggingFile={draggingFile}
                      dragOverLane={dragOverLane}
                      bulkAction={
                        stagedCount > 0 ? (
                          <Button
                            variant="secondary"
                            onClick={() => void unstageAllChanges()}
                            disabled={busyAction !== null}
                          >
                            <Minus className="h-4 w-4" aria-hidden="true" />
                            Unstage all
                          </Button>
                        ) : null
                      }
                      onSelect={(file) => setSelectedFile({ path: file.path, lane: "staged" })}
                      onMoveFile={(path) => void moveFile(path, "unstaged")}
                      onDragStart={handleFileDragStart}
                      onDragEnd={handleDragEnd}
                      onDragOver={handleLaneDragOver}
                      onDragLeave={handleLaneDragLeave}
                      onDrop={handleLaneDrop}
                    />

                    <CommitPanel
                      status={status}
                      commitMessage={commitMessage}
                      busyAction={busyAction}
                      onCommitMessageChange={setCommitMessage}
                      onCommit={() => void commitChanges()}
                      onPush={() => void pushChanges()}
                    />
                  </div>

                  <ResizeHandle
                    percent={stagingPanePercent}
                    onPointerDown={startWorkspaceResize}
                  />

                  <DiffPanel
                    selectedFile={selectedFile}
                    selectedChange={selectedChange}
                    diffState={diffState}
                    busyAction={busyAction}
                    mode={diffMode}
                    onModeChange={setDiffMode}
                    onMoveFile={(path, lane) => void moveFile(path, lane)}
                  />
                </div>
              </section>
              ) : (
                <BranchDiffWorkspace
                  status={status}
                  baseRef={branchDiffBaseRef}
                  compareRef={branchDiffCompareRef}
                  presets={branchDiffPresets}
                  branchDiffState={branchDiffState}
                  mode={diffMode}
                  onBaseRefChange={updateBranchDiffBaseRef}
                  onCompareRefChange={updateBranchDiffCompareRef}
                  onModeChange={setDiffMode}
                  onCompare={() => void compareBranchRefs()}
                  onPresetSelect={applyBranchDiffPreset}
                  onSwapRefs={swapBranchDiffRefs}
                />
              )
            ) : null}
          </div>
        </section>
      </div>

      {settingsOpen ? (
        <SettingsPanel
          theme={theme}
          onClose={() => setSettingsOpen(false)}
          onSave={(nextTheme) => {
            setTheme(nextTheme);
            setSettingsOpen(false);
          }}
        />
      ) : null}

      {toast ? (
        <Toast toast={toast} />
      ) : null}
    </main>
  );
}

function BranchDiffWorkspace({
  status,
  baseRef,
  compareRef,
  presets,
  branchDiffState,
  mode,
  onBaseRefChange,
  onCompareRefChange,
  onModeChange,
  onCompare,
  onPresetSelect,
  onSwapRefs,
}: {
  status: RepositoryStatus;
  baseRef: string;
  compareRef: string;
  presets: BranchDiffPreset[];
  branchDiffState: BranchDiffState;
  mode: DiffMode;
  onBaseRefChange: (ref: string) => void;
  onCompareRefChange: (ref: string) => void;
  onModeChange: (mode: DiffMode) => void;
  onCompare: () => void;
  onPresetSelect: (preset: BranchDiffPreset) => void;
  onSwapRefs: () => void;
}) {
  const result = branchDiffState.result;
  const [selectedBranchDiffPath, setSelectedBranchDiffPath] = useState<string | null>(null);
  const branchDiffFileElementsRef = useRef(new Map<string, HTMLElement>());
  const canCompare =
    baseRef.trim().length > 0 &&
    compareRef.trim().length > 0 &&
    !branchDiffState.loading;

  useEffect(() => {
    if (
      selectedBranchDiffPath &&
      (!result ||
        !result.files.some((file) =>
          branchDiffFileMatchesPath(file, selectedBranchDiffPath),
        ))
    ) {
      setSelectedBranchDiffPath(null);
    }
  }, [result, selectedBranchDiffPath]);

  useEffect(() => {
    if (!selectedBranchDiffPath) {
      return;
    }

    window.requestAnimationFrame(() => {
      scrollBranchDiffFileIntoView(selectedBranchDiffPath);
    });
  }, [mode, selectedBranchDiffPath]);

  function scrollBranchDiffFileIntoView(path: string) {
    branchDiffFileElementsRef.current
      .get(path)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleBranchDiffFileSelect(file: BranchDiffFile) {
    setSelectedBranchDiffPath(file.path);
    window.requestAnimationFrame(() => {
      scrollBranchDiffFileIntoView(file.path);
    });
  }

  function registerBranchDiffFileElement(
    file: ParsedDiffFile,
    element: HTMLElement | null,
  ) {
    diffFilePathKeys(file).forEach((path) => {
      if (element) {
        branchDiffFileElementsRef.current.set(path, element);
      } else {
        branchDiffFileElementsRef.current.delete(path);
      }
    });
  }

  return (
    <section className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-3">
      <div className="grid shrink-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <MetricPill label="Base" value={(result?.baseRef ?? baseRef) || "None"} />
        <MetricPill label="Compare" value={(result?.compareRef ?? compareRef) || "None"} />
        <MetricPill label="Changed" value={String(result?.files.length ?? 0)} />
        <MetricPill
          label="Distance"
          value={
            result
              ? `${result.compareOnly} ahead · ${result.baseOnly} behind`
              : "Not compared"
          }
        />
      </div>

      <Card className="relative z-20 shrink-0 overflow-visible">
        <div className="grid gap-3 p-3 xl:grid-cols-[1fr_auto_1fr_auto] xl:items-end">
          <RefInput
            label="Base ref"
            value={baseRef}
            refs={status.refs}
            onChange={onBaseRefChange}
          />

          <Button
            variant="secondary"
            title="Swap refs"
            aria-label="Swap refs"
            onClick={onSwapRefs}
            disabled={branchDiffState.loading}
            className="h-10 px-3 xl:mb-0.5"
          >
            <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
          </Button>

          <RefInput
            label="Compare ref"
            value={compareRef}
            refs={status.refs}
            onChange={onCompareRefChange}
          />

          <Button
            onClick={onCompare}
            disabled={!canCompare}
            className="h-10 xl:mb-0.5"
          >
            {branchDiffState.loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
            Compare
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-slate-200 bg-slate-50/70 px-3 py-3 dark:border-slate-800 dark:bg-slate-900/50">
          {presets.map((preset) => {
            const disabled =
              branchDiffState.loading || !preset.baseRef || !preset.compareRef;

            return (
              <Button
                key={preset.id}
                variant="secondary"
                disabled={disabled}
                title={
                  disabled
                    ? "Required ref is not available in this repository"
                    : `${preset.baseRef} → ${preset.compareRef}`
                }
                onClick={() => onPresetSelect(preset)}
              >
                <GitBranch className="h-4 w-4" aria-hidden="true" />
                {preset.label}
              </Button>
            );
          })}
        </div>
      </Card>

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[25rem_minmax(0,1fr)]">
        <BranchDiffFilesPanel
          files={result?.files ?? []}
          loading={branchDiffState.loading}
          hasResult={result !== null}
          selectedPath={selectedBranchDiffPath}
          onFileSelect={handleBranchDiffFileSelect}
        />

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Eye className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                <h2 className="truncate text-sm font-semibold">Branch Diff</h2>
              </div>
              <p className="mt-0.5 truncate text-xs font-medium text-slate-500 dark:text-slate-400">
                {result
                  ? `${result.baseRef} → ${result.compareRef}`
                  : "No comparison loaded"}
              </p>
            </div>

            <div
              className="grid h-9 grid-cols-2 rounded-md border border-slate-200 bg-slate-100 p-1 dark:border-slate-800 dark:bg-slate-900"
              aria-label="Diff view"
            >
              <DiffModeButton
                active={mode === "inline"}
                label="Inline"
                onClick={() => onModeChange("inline")}
              />
              <DiffModeButton
                active={mode === "split"}
                label="Split"
                onClick={() => onModeChange("split")}
              />
            </div>
          </div>

          {result ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/70 px-4 py-2 dark:border-slate-800 dark:bg-slate-900/50">
              <Badge>{result.summary}</Badge>
              <Badge className="border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/45 dark:text-sky-200">
                {result.compareOnly} compare only
              </Badge>
              <Badge className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-200">
                {result.baseOnly} base only
              </Badge>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 bg-white dark:bg-slate-950">
            {branchDiffState.loading ? (
              <div className="flex h-full min-h-0 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-hidden="true" />
              </div>
            ) : branchDiffState.failure ? (
              <GitFailurePanel
                title="Branch diff unavailable"
                failure={branchDiffState.failure}
              />
            ) : result?.content.trim() ? (
              <DiffViewer
                content={result.content}
                mode={mode}
                showFileHeaders
                activeFilePath={selectedBranchDiffPath}
                onFileElement={registerBranchDiffFileElement}
              />
            ) : result ? (
              <EmptyDiffState title="No diff output" />
            ) : (
              <EmptyDiffState title="Choose refs to compare" />
            )}
          </div>
        </Card>
      </div>
    </section>
  );
}

function RefInput({
  label,
  value,
  refs,
  onChange,
}: {
  label: string;
  value: string;
  refs: GitRef[];
  onChange: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const normalizedValue = value.trim().toLowerCase();
  const suggestions = [
    {
      name: "HEAD",
      kind: "Current",
      isCurrent: true,
    },
    ...refs.map((gitRef) => ({
      name: gitRef.name,
      kind: refKindLabel(gitRef.kind),
      isCurrent: gitRef.isCurrent,
    })),
  ].filter((suggestion) =>
    normalizedValue
      ? suggestion.name.toLowerCase().includes(normalizedValue)
      : true,
  );
  const visibleSuggestions = suggestions.slice(0, 30);

  function selectRef(ref: string) {
    onChange(ref);
    setOpen(false);
  }

  return (
    <div
      className="relative min-w-0 space-y-1"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <label>
        <span className="block text-xs font-semibold text-slate-500 dark:text-slate-400">
          {label}
        </span>
        <Input
          value={value}
          placeholder="branch, tag, or commit SHA"
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          className="font-mono"
        />
      </label>

      {open ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-xl shadow-slate-950/15 dark:border-slate-700 dark:bg-slate-950 dark:shadow-black/50">
          {visibleSuggestions.length > 0 ? (
            visibleSuggestions.map((suggestion) => (
              <button
                key={`${suggestion.kind}:${suggestion.name}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectRef(suggestion.name)}
                className={cn(
                  "flex w-full min-w-0 items-center justify-between gap-3 px-3 py-2 text-left text-sm text-slate-900 transition-colors hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-none dark:text-slate-100 dark:hover:bg-slate-800 dark:focus-visible:bg-slate-800",
                  value === suggestion.name &&
                    "bg-sky-50 text-sky-900 dark:bg-sky-950/50 dark:text-sky-100",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[13px] font-semibold">
                    {suggestion.name}
                  </span>
                  <span className="mt-0.5 block text-xs font-medium text-slate-500 dark:text-slate-400">
                    {suggestion.kind}
                    {suggestion.isCurrent ? " · current" : ""}
                  </span>
                </span>
                {value === suggestion.name ? (
                  <Check className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-300" aria-hidden="true" />
                ) : null}
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
              No matching refs
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function BranchDiffFilesPanel({
  files,
  loading,
  hasResult,
  selectedPath,
  onFileSelect,
}: {
  files: BranchDiffFile[];
  loading: boolean;
  hasResult: boolean;
  selectedPath: string | null;
  onFileSelect: (file: BranchDiffFile) => void;
}) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold">Changed Files</h2>
            <Badge>{files.length}</Badge>
          </div>
          <p className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            Ref-to-ref summary
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {loading ? (
          <div className="flex h-full min-h-0 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-slate-400" aria-hidden="true" />
          </div>
        ) : files.length === 0 ? (
          <div className="flex h-full min-h-0 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-sm text-slate-500 dark:border-slate-800 dark:bg-white/[0.02] dark:text-slate-400">
            {hasResult ? "No changed files" : "No comparison loaded"}
          </div>
        ) : (
          <ul className="space-y-2">
            {files.map((file) => {
              const isSelected =
                selectedPath !== null &&
                branchDiffFileMatchesPath(file, selectedPath);

              return (
                <li key={`${file.status}:${file.originalPath ?? ""}:${file.path}`}>
                  <button
                    type="button"
                    aria-current={isSelected ? "location" : undefined}
                    onClick={() => onFileSelect(file)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:focus-visible:ring-slate-700",
                      isSelected
                        ? "border-sky-300 bg-sky-50 shadow-sm shadow-sky-950/5 dark:border-sky-800 dark:bg-sky-950/25"
                        : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-slate-700 dark:hover:bg-slate-900/80",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                      <RepoPathText
                        path={file.path}
                        className="text-[13px] font-semibold leading-5"
                      />
                    </div>
                    {file.originalPath ? (
                      <span className="mt-1 flex min-w-0 items-center gap-1 pl-6 text-[11px] text-slate-500 dark:text-slate-400">
                        <span className="shrink-0">from</span>
                        <RepoPathText path={file.originalPath} className="flex-1" />
                      </span>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
                      <Badge className={branchDiffStatusClassName(file.status)}>
                        {branchDiffStatusLabel(file)}
                      </Badge>
                      <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                        {file.status}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

function branchDiffStatusClassName(status: string) {
  const code = status[0] ?? status;

  if (code === "A") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-200";
  }

  if (code === "D") {
    return "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-200";
  }

  if (code === "R" || code === "C") {
    return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/45 dark:text-sky-200";
  }

  return "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200";
}

function branchDiffFileMatchesPath(file: BranchDiffFile, path: string) {
  return file.path === path || file.originalPath === path;
}

function GitFailurePanel({
  title,
  failure,
}: {
  title: string;
  failure: GitCommandFailure;
}) {
  return (
    <div className="p-4">
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/80 dark:bg-red-950/25">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-300" aria-hidden="true" />
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-semibold text-red-900 dark:text-red-100">
              {title}
            </p>
            <p className="break-words rounded bg-white px-2 py-1 font-mono text-xs text-red-800 dark:bg-black/20 dark:text-red-100">
              {failure.command}
            </p>
            <p className="whitespace-pre-wrap text-sm text-red-700 dark:text-red-200">
              {failure.error}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function readDragPayload(event: DragEvent<HTMLElement>): SelectedFile | null {
  const rawPayload = event.dataTransfer.getData(dragMimeType);

  if (!rawPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawPayload) as Partial<SelectedFile>;

    if (typeof parsed.path === "string" && isFileLane(parsed.lane)) {
      return {
        path: parsed.path,
        lane: parsed.lane,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function ResizeHandle({
  percent,
  onPointerDown,
}: {
  percent: number;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 py-2">
      <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
      <button
        type="button"
        title="Resize staging area"
        aria-label="Resize staging area"
        onPointerDown={onPointerDown}
        className="group flex h-5 w-36 cursor-row-resize items-center justify-center rounded-full border border-slate-200 bg-white shadow-sm shadow-slate-950/5 transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:border-slate-800 dark:bg-slate-950 dark:shadow-black/20 dark:hover:border-slate-700 dark:hover:bg-slate-900 dark:focus-visible:ring-slate-700"
      >
        <span className="h-1 w-12 rounded-full bg-slate-300 transition-colors group-hover:bg-slate-400 dark:bg-slate-700 dark:group-hover:bg-slate-500" />
        <span className="sr-only">{Math.round(percent)}%</span>
      </button>
      <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
    </div>
  );
}

function FileLanePanel({
  lane,
  title,
  subtitle,
  files,
  emptyText,
  selectedFile,
  busyAction,
  draggingFile,
  dragOverLane,
  bulkAction,
  onSelect,
  onMoveFile,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  lane: FileLane;
  title: string;
  subtitle: string;
  files: GitFileChange[];
  emptyText: string;
  selectedFile: SelectedFile | null;
  busyAction: string | null;
  draggingFile: SelectedFile | null;
  dragOverLane: FileLane | null;
  bulkAction: ReactNode;
  onSelect: (file: GitFileChange) => void;
  onMoveFile: (path: string) => void;
  onDragStart: (
    event: DragEvent<HTMLElement>,
    file: GitFileChange,
    lane: FileLane,
  ) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLElement>, lane: FileLane) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>, lane: FileLane) => void;
}) {
  const selectedKey = selectedFileKey(selectedFile);
  const targetLane = lane === "unstaged" ? "staged" : "unstaged";
  const actionLabel = lane === "unstaged" ? "Stage" : "Unstage";
  const isDropTarget = dragOverLane === lane && draggingFile?.lane !== lane;
  const ActionIcon = lane === "unstaged" ? Plus : Minus;

  return (
    <Card
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden transition-all",
        isDropTarget &&
          "border-sky-300 ring-2 ring-sky-200 dark:border-sky-700 dark:ring-sky-900/70",
      )}
      onDragOver={(event) => onDragOver(event, lane)}
      onDragLeave={onDragLeave}
      onDrop={(event) => onDrop(event, lane)}
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            <Badge>{files.length}</Badge>
          </div>
          <p className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
        </div>
        {bulkAction}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {files.length === 0 ? (
          <div className="flex h-full min-h-0 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-sm text-slate-500 dark:border-slate-800 dark:bg-white/[0.02] dark:text-slate-400">
            {isDropTarget ? actionLabel : emptyText}
          </div>
        ) : (
          <ul className="space-y-2">
            {files.map((file) => {
              const rowKey = `${lane}:${file.path}`;
              const isActive = selectedKey === rowKey;
              const actionId =
                targetLane === "staged"
                  ? `stage:${file.path}`
                  : `unstage:${file.path}`;
              const isBusy = busyAction === actionId;

              return (
                <li key={`${rowKey}:${file.indexStatus}:${file.worktreeStatus}`}>
                  <div
                    role="button"
                    tabIndex={0}
                    draggable={busyAction === null}
                    aria-pressed={isActive}
                    onClick={() => onSelect(file)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(file);
                      }
                    }}
                    onDragStart={(event) => onDragStart(event, file, lane)}
                    onDragEnd={onDragEnd}
                    className={cn(
                      "group grid w-full grid-cols-[1fr_auto] gap-3 rounded-lg border px-3 py-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:focus-visible:ring-slate-700",
                      isActive
                        ? "border-sky-300 bg-sky-50 shadow-sm shadow-sky-950/5 dark:border-sky-800 dark:bg-sky-950/25"
                        : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-slate-700 dark:hover:bg-slate-900/80",
                      busyAction === null && "cursor-grab active:cursor-grabbing",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                        <RepoPathText
                          path={file.path}
                          className="text-[13px] font-semibold leading-5"
                        />
                      </span>
                      {file.originalPath ? (
                        <span className="mt-1 flex min-w-0 items-center gap-1 pl-6 text-[11px] text-slate-500 dark:text-slate-400">
                          <span className="shrink-0">from</span>
                          <RepoPathText path={file.originalPath} className="flex-1" />
                        </span>
                      ) : null}
                      <span className="mt-2 flex flex-wrap items-center gap-2 pl-6">
                        <Badge className="gap-1 border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900">
                          <CircleDot className="h-3 w-3" aria-hidden="true" />
                          {statusLabel(file)}
                        </Badge>
                        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                          {file.displayStatus}
                        </span>
                      </span>
                    </span>

                    <Button
                      variant="ghost"
                      className="h-8 w-8 p-0 text-slate-500 group-hover:bg-white group-hover:text-slate-950 dark:text-slate-400 dark:group-hover:bg-slate-950 dark:group-hover:text-slate-50"
                      title={actionLabel}
                      aria-label={`${actionLabel} ${file.path}`}
                      disabled={busyAction !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        onMoveFile(file.path);
                      }}
                    >
                      {isBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <ActionIcon className="h-4 w-4" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {isDropTarget ? (
        <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-sky-300 bg-sky-50/90 text-sm font-semibold text-sky-700 shadow-sm backdrop-blur-sm dark:border-sky-800 dark:bg-sky-950/80 dark:text-sky-200">
          <span className="inline-flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
            {actionLabel}
          </span>
        </div>
      ) : null}
    </Card>
  );
}

function DiffPanel({
  selectedFile,
  selectedChange,
  diffState,
  busyAction,
  mode,
  onModeChange,
  onMoveFile,
}: {
  selectedFile: SelectedFile | null;
  selectedChange: GitFileChange | null;
  diffState: DiffState;
  busyAction: string | null;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  onMoveFile: (path: string, lane: FileLane) => void;
}) {
  const targetLane = selectedFile?.lane === "staged" ? "unstaged" : "staged";
  const actionLabel = targetLane === "staged" ? "Stage" : "Unstage";
  const ActionIcon = targetLane === "staged" ? Plus : Minus;
  const actionId = selectedFile
    ? targetLane === "staged"
      ? `stage:${selectedFile.path}`
      : `unstage:${selectedFile.path}`
    : null;

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Eye className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            <h2 className="truncate text-sm font-semibold">Diff Preview</h2>
          </div>
          <p className="mt-0.5 truncate text-xs font-medium text-slate-500 dark:text-slate-400">
            {selectedFile?.path ?? "No file selected"}
          </p>
        </div>

        {selectedFile && selectedChange ? (
          <div className="flex shrink-0 items-center gap-2">
            <div
              className="grid h-9 grid-cols-2 rounded-md border border-slate-200 bg-slate-100 p-1 dark:border-slate-800 dark:bg-slate-900"
              aria-label="Diff view"
            >
              <DiffModeButton
                active={mode === "inline"}
                label="Inline"
                onClick={() => onModeChange("inline")}
              />
              <DiffModeButton
                active={mode === "split"}
                label="Split"
                onClick={() => onModeChange("split")}
              />
            </div>
            <Badge className="hidden border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900 sm:inline-flex">
              {selectedFile.lane === "staged" ? "Staged" : "Unstaged"}
            </Badge>
            <Button
              variant="secondary"
              disabled={busyAction !== null}
              onClick={() => onMoveFile(selectedFile.path, targetLane)}
            >
              {busyAction === actionId ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <ActionIcon className="h-4 w-4" aria-hidden="true" />
              )}
              {actionLabel}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 bg-white dark:bg-slate-950">
        {!selectedFile ? (
          <EmptyDiffState title="No diff selected" />
        ) : diffState.loading ? (
          <div className="flex h-full min-h-0 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-hidden="true" />
          </div>
        ) : diffState.failure ? (
          <div className="p-4">
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/80 dark:bg-red-950/25">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-300" aria-hidden="true" />
                <div className="min-w-0 space-y-2">
                  <p className="text-sm font-semibold text-red-900 dark:text-red-100">
                    Diff unavailable
                  </p>
                  <p className="break-words rounded bg-white px-2 py-1 font-mono text-xs text-red-800 dark:bg-black/20 dark:text-red-100">
                    {diffState.failure.command}
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-red-700 dark:text-red-200">
                    {diffState.failure.error}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : diffState.content.trim() ? (
          <DiffViewer content={diffState.content} mode={mode} showFileHeaders={false} />
        ) : (
          <EmptyDiffState title="No diff output" />
        )}
      </div>
    </Card>
  );
}

function EmptyDiffState({ title }: { title: string }) {
  return (
    <div className="grid h-full min-h-0 place-items-center px-4 text-center">
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-300">
        {title}
      </div>
    </div>
  );
}

function DiffModeButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:focus-visible:ring-slate-700",
        active
          ? "bg-white text-slate-950 shadow-sm dark:bg-slate-100 dark:text-slate-950"
          : "text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-slate-100",
      )}
    >
      {label}
    </button>
  );
}

function DiffViewer({
  content,
  mode,
  showFileHeaders,
  activeFilePath = null,
  onFileElement,
}: {
  content: string;
  mode: DiffMode;
  showFileHeaders: boolean;
  activeFilePath?: string | null;
  onFileElement?: (file: ParsedDiffFile, element: HTMLElement | null) => void;
}) {
  const files = useMemo(() => parseDiff(content), [content]);

  if (mode === "split") {
    return (
      <SplitDiffViewer
        files={files}
        showFileHeaders={showFileHeaders}
        activeFilePath={activeFilePath}
        onFileElement={onFileElement}
      />
    );
  }

  return (
    <InlineDiffViewer
      files={files}
      showFileHeaders={showFileHeaders}
      activeFilePath={activeFilePath}
      onFileElement={onFileElement}
    />
  );
}

type DiffLineKind = "context" | "add" | "delete";

type DiffContentRow =
  | {
      type: "hunk";
      text: string;
      oldStart: number;
      newStart: number;
    }
  | {
      type: "line";
      kind: DiffLineKind;
      oldNumber: number | null;
      newNumber: number | null;
      text: string;
    }
  | {
      type: "note";
      text: string;
    };

type ParsedDiffFile = {
  key: string;
  oldPath: string | null;
  newPath: string | null;
  notes: string[];
  rows: DiffContentRow[];
};

function InlineDiffViewer({
  files,
  showFileHeaders,
  activeFilePath,
  onFileElement,
}: {
  files: ParsedDiffFile[];
  showFileHeaders: boolean;
  activeFilePath: string | null;
  onFileElement?: (file: ParsedDiffFile, element: HTMLElement | null) => void;
}) {
  const shouldShowFileHeaders = showFileHeaders || files.length > 1;

  return (
    <div className="h-full min-h-0 overflow-auto bg-white dark:bg-slate-950">
      <div className="min-w-full pb-3 font-mono text-xs leading-5">
        {files.map((file, fileIndex) => (
          <section
            key={file.key}
            ref={(element) => onFileElement?.(file, element)}
            className={cn(
              "scroll-mt-10",
              fileIndex > 0 && "border-t border-slate-200 dark:border-white/10",
            )}
          >
            {shouldShowFileHeaders ? (
              <DiffFileHeader file={file} active={diffFileMatchesPath(file, activeFilePath)} />
            ) : null}
            {file.notes.length > 0 ? <DiffFileNotes notes={file.notes} /> : null}
            <div className="min-w-max">
              {file.rows.map((row, rowIndex) => (
                <InlineDiffRow key={`${file.key}:${rowIndex}`} row={row} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

type SplitDiffCell = {
  lineNumber: number | null;
  marker: string;
  text: string;
};

type SplitDiffLineKind = DiffLineKind | "change";

type SplitDiffRow =
  | {
      type: "hunk";
      text: string;
    }
  | {
      type: "line";
      kind: SplitDiffLineKind;
      left: SplitDiffCell | null;
      right: SplitDiffCell | null;
    }
  | {
      type: "note";
      text: string;
    };

function SplitDiffViewer({
  files,
  showFileHeaders,
  activeFilePath,
  onFileElement,
}: {
  files: ParsedDiffFile[];
  showFileHeaders: boolean;
  activeFilePath: string | null;
  onFileElement?: (file: ParsedDiffFile, element: HTMLElement | null) => void;
}) {
  const shouldShowFileHeaders = showFileHeaders || files.length > 1;

  return (
    <div className="h-full min-h-0 overflow-auto bg-white dark:bg-slate-950">
      <div className="grid min-w-[920px] grid-cols-2 border-b border-slate-200 bg-slate-100 font-mono text-[11px] font-semibold uppercase text-slate-500 dark:border-white/10 dark:bg-slate-900 dark:text-slate-400">
        <div className="border-r border-slate-200 px-4 py-2 dark:border-white/10">Before</div>
        <div className="px-4 py-2">After</div>
      </div>
      <div className="min-w-[920px] pb-3 font-mono text-xs leading-5">
        {files.map((file, fileIndex) => (
          <section
            key={file.key}
            ref={(element) => onFileElement?.(file, element)}
            className={cn(
              "scroll-mt-10",
              fileIndex > 0 && "border-t border-slate-200 dark:border-white/10",
            )}
          >
            {shouldShowFileHeaders ? (
              <DiffFileHeader file={file} active={diffFileMatchesPath(file, activeFilePath)} />
            ) : null}
            {file.notes.length > 0 ? <DiffFileNotes notes={file.notes} /> : null}
            {splitDiffRows(file.rows).map((row, rowIndex) => (
              <SplitDiffRowView key={`${file.key}:${rowIndex}`} row={row} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function InlineDiffRow({ row }: { row: DiffContentRow }) {
  if (row.type === "hunk") {
    return (
      <div className="grid min-w-max grid-cols-[3.25rem_3.25rem_1.5rem_minmax(32rem,1fr)] border-y border-sky-100 bg-sky-50 text-sky-800 dark:border-sky-950/70 dark:bg-sky-950/40 dark:text-sky-200">
        <span className="select-none border-r border-sky-100 px-2 text-right dark:border-sky-900/60" />
        <span className="select-none border-r border-sky-100 px-2 text-right dark:border-sky-900/60" />
        <code className="col-span-2 whitespace-pre px-3 py-0.5">{row.text}</code>
      </div>
    );
  }

  if (row.type === "note") {
    return (
      <div className="grid min-w-max grid-cols-[3.25rem_3.25rem_1.5rem_minmax(32rem,1fr)] bg-slate-50 text-slate-500 dark:bg-slate-900/70 dark:text-slate-400">
        <span className="select-none border-r border-slate-200 px-2 text-right dark:border-white/10" />
        <span className="select-none border-r border-slate-200 px-2 text-right dark:border-white/10" />
        <code className="col-span-2 whitespace-pre px-3 py-0.5">{row.text}</code>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid min-w-max grid-cols-[3.25rem_3.25rem_1.5rem_minmax(32rem,1fr)]",
        inlineDiffLineClassName(row.kind),
      )}
    >
      <DiffLineNumber value={row.oldNumber} kind={row.kind} />
      <DiffLineNumber value={row.newNumber} kind={row.kind} />
      <span className="select-none text-center">{diffLineMarker(row.kind)}</span>
      <code className="whitespace-pre pr-4">{row.text || " "}</code>
    </div>
  );
}

function SplitDiffRowView({ row }: { row: SplitDiffRow }) {
  if (row.type === "hunk") {
    return (
      <div className="grid grid-cols-2 border-y border-sky-100 bg-sky-50 text-sky-800 dark:border-sky-950/70 dark:bg-sky-950/40 dark:text-sky-200">
        <code className="border-r border-sky-100 px-4 py-0.5 dark:border-sky-900/60">
          {row.text}
        </code>
        <code className="px-4 py-0.5">{row.text}</code>
      </div>
    );
  }

  if (row.type === "note") {
    return (
      <div className="border-b border-slate-100 bg-slate-50 px-4 py-1 text-slate-500 dark:border-white/[0.03] dark:bg-slate-900/70 dark:text-slate-400">
        <code className="whitespace-pre">{row.text}</code>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 border-b border-slate-100 dark:border-white/[0.03]">
      <SplitDiffCellView cell={row.left} kind={row.kind} side="left" />
      <SplitDiffCellView cell={row.right} kind={row.kind} side="right" />
    </div>
  );
}

function SplitDiffCellView({
  cell,
  kind,
  side,
}: {
  cell: SplitDiffCell | null;
  kind: SplitDiffLineKind;
  side: "left" | "right";
}) {
  return (
    <code
      className={cn(
        "grid min-h-5 grid-cols-[3.25rem_1.5rem_minmax(0,1fr)]",
        side === "left" && "border-r border-slate-200 dark:border-white/10",
        splitDiffCellClassName(kind, side),
      )}
    >
      <span className="select-none border-r border-current/10 px-2 text-right opacity-70">
        {cell?.lineNumber ?? ""}
      </span>
      <span className="select-none text-center">{cell?.marker ?? ""}</span>
      <span className="whitespace-pre pr-4">{cell?.text || " "}</span>
    </code>
  );
}

function DiffLineNumber({
  value,
  kind,
}: {
  value: number | null;
  kind: DiffLineKind;
}) {
  return (
    <span
      className={cn(
        "select-none border-r px-2 text-right text-slate-400 dark:text-slate-500",
        kind === "add" &&
          "border-emerald-100 bg-emerald-100/80 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/60 dark:text-emerald-300",
        kind === "delete" &&
          "border-red-100 bg-red-100/80 text-red-700 dark:border-red-900/60 dark:bg-red-950/60 dark:text-red-300",
        kind === "context" && "border-slate-200 dark:border-white/10",
      )}
    >
      {value ?? ""}
    </span>
  );
}

function DiffFileHeader({
  file,
  active,
}: {
  file: ParsedDiffFile;
  active: boolean;
}) {
  const path = diffFilePath(file);
  const hasRename = file.oldPath && file.newPath && file.oldPath !== file.newPath;

  return (
    <div
      className={cn(
        "sticky top-0 z-10 flex min-w-max items-center gap-2 border-b px-4 py-2 font-sans text-xs text-slate-700 dark:text-slate-200",
        active
          ? "border-sky-200 bg-sky-50 dark:border-sky-900/70 dark:bg-sky-950/55"
          : "border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-slate-900",
      )}
    >
      <FileText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      <RepoPathText path={path} className="font-semibold" />
      {hasRename ? (
        <span className="text-slate-400 dark:text-slate-500">
          from {file.oldPath}
        </span>
      ) : null}
    </div>
  );
}

function DiffFileNotes({ notes }: { notes: string[] }) {
  return (
    <div className="flex min-w-max flex-wrap gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-2 font-sans text-xs text-slate-500 dark:border-white/[0.05] dark:bg-slate-900/50 dark:text-slate-400">
      {notes.map((note) => (
        <span
          key={note}
          className="rounded border border-slate-200 bg-white px-2 py-0.5 dark:border-slate-700 dark:bg-slate-950"
        >
          {note}
        </span>
      ))}
    </div>
  );
}

function splitDiffRows(diffRows: DiffContentRow[]): SplitDiffRow[] {
  const splitRows: SplitDiffRow[] = [];
  const pendingDeletes: Extract<DiffContentRow, { type: "line" }>[] = [];

  function flushDeletes() {
    while (pendingDeletes.length > 0) {
      const deletedLine = pendingDeletes.shift();

      if (!deletedLine) {
        continue;
      }

      splitRows.push({
        type: "line",
        kind: "delete",
        left: diffCellForLine(deletedLine),
        right: null,
      });
    }
  }

  for (const row of diffRows) {
    if (row.type === "hunk" || row.type === "note") {
      flushDeletes();
      splitRows.push(row);
      continue;
    }

    if (row.kind === "delete") {
      pendingDeletes.push(row);
      continue;
    }

    if (row.kind === "add") {
      if (pendingDeletes.length > 0) {
        const deletedLine = pendingDeletes.shift();

        if (!deletedLine) {
          continue;
        }

        splitRows.push({
          type: "line",
          kind: "change",
          left: diffCellForLine(deletedLine),
          right: diffCellForLine(row),
        });
      } else {
        splitRows.push({
          type: "line",
          kind: "add",
          left: null,
          right: diffCellForLine(row),
        });
      }

      continue;
    }

    flushDeletes();

    splitRows.push({
      type: "line",
      kind: "context",
      left: diffCellForLine(row),
      right: diffCellForLine(row, "right"),
    });
  }

  flushDeletes();

  return splitRows;
}

function splitDiffCellClassName(
  kind: SplitDiffLineKind,
  side: "left" | "right",
) {
  if (kind === "change") {
    return side === "left"
      ? "bg-red-50 text-red-800 dark:bg-red-950/35 dark:text-red-200"
      : "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/35 dark:text-emerald-200";
  }

  if (kind === "delete" && side === "left") {
    return "bg-red-50 text-red-800 dark:bg-red-950/35 dark:text-red-200";
  }

  if (kind === "add" && side === "right") {
    return "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/35 dark:text-emerald-200";
  }

  return "text-slate-700 dark:text-slate-300";
}

function parseDiff(content: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let currentFile: ParsedDiffFile | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;
  let inHunk = false;

  function ensureFile() {
    if (!currentFile) {
      currentFile = {
        key: "standalone",
        oldPath: null,
        newPath: null,
        notes: [],
        rows: [],
      };
      files.push(currentFile);
    }

    return currentFile;
  }

  function startFile(line: string) {
    const paths = parseDiffGitHeader(line);
    currentFile = {
      key: `${files.length}:${line}`,
      oldPath: paths.oldPath,
      newPath: paths.newPath,
      notes: [],
      rows: [],
    };
    files.push(currentFile);
    oldLineNumber = 0;
    newLineNumber = 0;
    inHunk = false;
  }

  const lines = content.replace(/\n$/, "").split("\n");

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      startFile(line);
      continue;
    }

    const file = ensureFile();

    if (line.startsWith("index ")) {
      continue;
    }

    if (line.startsWith("--- ")) {
      file.oldPath = normalizeDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith("+++ ")) {
      file.newPath = normalizeDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith("new file mode")) {
      addDiffNote(file, "New file");
      continue;
    }

    if (line.startsWith("deleted file mode")) {
      addDiffNote(file, "Deleted file");
      continue;
    }

    if (line.startsWith("old mode") || line.startsWith("new mode")) {
      addDiffNote(file, "File mode changed");
      continue;
    }

    if (line.startsWith("similarity index ")) {
      addDiffNote(file, `${line.slice("similarity index ".length)} similar`);
      continue;
    }

    if (line.startsWith("rename from ")) {
      file.oldPath = line.slice("rename from ".length);
      continue;
    }

    if (line.startsWith("rename to ")) {
      file.newPath = line.slice("rename to ".length);
      addDiffNote(file, "Renamed");
      continue;
    }

    if (line.startsWith("copy from ")) {
      file.oldPath = line.slice("copy from ".length);
      continue;
    }

    if (line.startsWith("copy to ")) {
      file.newPath = line.slice("copy to ".length);
      addDiffNote(file, "Copied");
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);

    if (hunk) {
      oldLineNumber = Number(hunk[1]);
      newLineNumber = Number(hunk[2]);
      inHunk = true;
      file.rows.push({
        type: "hunk",
        text: line,
        oldStart: oldLineNumber,
        newStart: newLineNumber,
      });
      continue;
    }

    if (line.startsWith("\\ ")) {
      file.rows.push({ type: "note", text: line.slice(2) });
      continue;
    }

    if (inHunk) {
      if (line.startsWith("+")) {
        file.rows.push({
          type: "line",
          kind: "add",
          oldNumber: null,
          newNumber: newLineNumber,
          text: line.slice(1),
        });
        newLineNumber += 1;
        continue;
      }

      if (line.startsWith("-")) {
        file.rows.push({
          type: "line",
          kind: "delete",
          oldNumber: oldLineNumber,
          newNumber: null,
          text: line.slice(1),
        });
        oldLineNumber += 1;
        continue;
      }

      file.rows.push({
        type: "line",
        kind: "context",
        oldNumber: oldLineNumber,
        newNumber: newLineNumber,
        text: line.startsWith(" ") ? line.slice(1) : line,
      });
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }

    if (line.trim()) {
      file.rows.push({ type: "note", text: humanizeDiffNote(line) });
    }
  }

  return files.length > 0 ? files : [];
}

function parseDiffGitHeader(line: string) {
  const quoted = line.match(/^diff --git "a\/(.+)" "b\/(.+)"$/);

  if (quoted) {
    return {
      oldPath: quoted[1],
      newPath: quoted[2],
    };
  }

  const unquoted = line.match(/^diff --git a\/(.+) b\/(.+)$/);

  if (unquoted) {
    return {
      oldPath: unquoted[1],
      newPath: unquoted[2],
    };
  }

  return {
    oldPath: null,
    newPath: null,
  };
}

function normalizeDiffPath(path: string) {
  let normalized = path.trim();

  if (normalized.startsWith("\"") && normalized.endsWith("\"")) {
    normalized = normalized.slice(1, -1);
  }

  if (normalized === "/dev/null") {
    return null;
  }

  return normalized.replace(/^[ab]\//, "");
}

function addDiffNote(file: ParsedDiffFile, note: string) {
  if (!file.notes.includes(note)) {
    file.notes.push(note);
  }
}

function humanizeDiffNote(line: string) {
  if (line.startsWith("Binary files ")) {
    return "Binary file changed";
  }

  return line;
}

function diffFilePath(file: ParsedDiffFile) {
  return file.newPath ?? file.oldPath ?? "File changed";
}

function diffFilePathKeys(file: ParsedDiffFile) {
  return Array.from(
    new Set([file.newPath, file.oldPath].filter((path): path is string => Boolean(path))),
  );
}

function diffFileMatchesPath(file: ParsedDiffFile, path: string | null) {
  return path !== null && diffFilePathKeys(file).includes(path);
}

function diffLineMarker(kind: DiffLineKind) {
  if (kind === "add") {
    return "+";
  }

  if (kind === "delete") {
    return "-";
  }

  return "";
}

function inlineDiffLineClassName(kind: DiffLineKind) {
  if (kind === "add") {
    return "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-100";
  }

  if (kind === "delete") {
    return "bg-red-50 text-red-900 dark:bg-red-950/35 dark:text-red-100";
  }

  return "text-slate-700 dark:text-slate-300";
}

function diffCellForLine(
  row: Extract<DiffContentRow, { type: "line" }>,
  side: "left" | "right" = row.kind === "add" ? "right" : "left",
): SplitDiffCell {
  return {
    lineNumber: side === "right" ? row.newNumber : row.oldNumber,
    marker: diffLineMarker(row.kind),
    text: row.text,
  };
}

function CommitPanel({
  status,
  commitMessage,
  busyAction,
  onCommitMessageChange,
  onCommit,
  onPush,
}: {
  status: RepositoryStatus;
  commitMessage: string;
  busyAction: string | null;
  onCommitMessageChange: (message: string) => void;
  onCommit: () => void;
  onPush: () => void;
}) {
  const stagedCount = status.stagedFiles.length;
  const canCommit =
    busyAction === null && stagedCount > 0 && commitMessage.trim().length > 0;
  const pushLabel = status.ahead > 0 ? `Push ${status.ahead}` : "Push";

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Commit</h2>
            <p className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">
              {stagedCount} staged {stagedCount === 1 ? "file" : "files"}
            </p>
          </div>
          <Badge>{status.branch ?? "HEAD"}</Badge>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <Textarea
          value={commitMessage}
          onChange={(event) => onCommitMessageChange(event.target.value)}
          placeholder="Commit message"
          disabled={busyAction !== null}
          className="min-h-16 flex-1"
        />

        <div className="grid shrink-0 grid-cols-2 gap-2">
          <Button
            onClick={onCommit}
            disabled={!canCommit}
            className="w-full"
          >
            {busyAction === "commit" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="h-4 w-4" aria-hidden="true" />
            )}
            Commit
          </Button>
          <Button
            variant="secondary"
            onClick={onPush}
            disabled={busyAction !== null}
            className="w-full"
          >
            {busyAction === "push" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="h-4 w-4" aria-hidden="true" />
            )}
            {pushLabel}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function MetricPill({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 text-xs dark:border-slate-800 dark:bg-white/[0.03]">
      <span className="font-medium text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <span className="max-w-40 truncate font-semibold text-slate-900 dark:text-slate-100">
        {value}
      </span>
    </div>
  );
}

function ActivityButton({
  active,
  icon,
  title,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  title: string;
  onClick?: () => void;
}) {
  const Icon = icon;

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "relative flex h-11 w-11 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500",
        active
          ? "bg-white/[0.08] text-white"
          : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-100",
      )}
    >
      {active ? (
        <span className="absolute left-0 h-6 w-0.5 rounded-r bg-sky-400" />
      ) : null}
      <Icon className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

function HeaderActionButton({
  title,
  icon,
  iconClassName,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "variant"> & {
  title: string;
  icon: LucideIcon;
  iconClassName?: string;
}) {
  const Icon = icon;

  return (
    <Button
      variant="ghost"
      title={title}
      aria-label={title}
      className={cn(
        "h-9 w-9 rounded-lg border border-slate-200/80 bg-white/70 p-0 text-slate-600 shadow-sm shadow-slate-950/5 transition-all hover:border-slate-300 hover:bg-white hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-300 dark:shadow-black/20 dark:hover:border-white/15 dark:hover:bg-white/[0.07] dark:hover:text-white dark:focus-visible:ring-slate-700",
        className,
      )}
      {...props}
    >
      <Icon className={cn("h-4 w-4", iconClassName)} aria-hidden="true" />
    </Button>
  );
}

function SettingsPanel({
  theme,
  onClose,
  onSave,
}: {
  theme: Theme;
  onClose: () => void;
  onSave: (theme: Theme) => void;
}) {
  const [draftTheme, setDraftTheme] = useState<Theme>(theme);

  useBodyScrollLock();

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/35 dark:bg-black/50">
      <aside className="ml-auto flex h-full w-full max-w-[28rem] flex-col border-l border-slate-200 bg-white shadow-2xl shadow-slate-950/20 dark:border-slate-800 dark:bg-slate-950 dark:shadow-black/50">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Settings</h2>
          </div>
          <Button
            variant="ghost"
            title="Close settings"
            aria-label="Close settings"
            onClick={onClose}
            className="h-9 w-9 shrink-0 p-0"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100/70 px-5 py-5 dark:bg-slate-900/35">
          <SettingsSection
            icon={draftTheme === "dark" ? Moon : Sun}
            title="Theme"
          >
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={draftTheme === "dark" ? "primary" : "secondary"}
                onClick={() => setDraftTheme("dark")}
                className="h-10 rounded-lg"
              >
                <Moon className="h-4 w-4" aria-hidden="true" />
                Dark
              </Button>
              <Button
                variant={draftTheme === "light" ? "primary" : "secondary"}
                onClick={() => setDraftTheme("light")}
                className="h-10 rounded-lg"
              >
                <Sun className="h-4 w-4" aria-hidden="true" />
                Light
              </Button>
            </div>
          </SettingsSection>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-slate-200 bg-slate-50/90 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/95">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(draftTheme)}>Save</Button>
        </div>
      </aside>
    </div>
  );
}

function SettingsSection({
  icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  const Icon = icon;

  return (
    <section className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm shadow-slate-950/5 dark:border-slate-700/80 dark:bg-slate-950 dark:shadow-black/20">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50/95 px-3 py-3 dark:border-slate-800 dark:bg-slate-900/70">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Toast({ toast }: { toast: ToastState }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(420px,calc(100vw-2rem))]">
      <div
        className={cn(
          "rounded-xl border bg-white p-4 shadow-lg dark:bg-slate-950",
          toast.tone === "error"
            ? "border-red-200 dark:border-red-900"
            : "border-emerald-200 dark:border-emerald-900",
        )}
      >
        <div className="flex items-start gap-3">
          {toast.tone === "error" ? (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden="true" />
          ) : (
            <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" aria-hidden="true" />
          )}
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-semibold">{toast.title}</p>
            {toast.command ? (
              <p className="break-words rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-300">
                {toast.command}
              </p>
            ) : null}
            <p className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">
              {toast.description}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
