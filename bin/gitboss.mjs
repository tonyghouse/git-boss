#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(import.meta.url);
const input = process.argv[2] ?? ".";

if (input === "--help" || input === "-h") {
  console.log("Usage: gitboss [folder]");
  process.exit(0);
}

const target = resolve(process.cwd(), input);

if (!existsSync(target) || !statSync(target).isDirectory()) {
  console.error(`GitBoss expected a folder: ${target}`);
  process.exit(1);
}

try {
  if (!(await launchInstalledApp(target))) {
    throw new Error(
      "GitBoss is not installed. Refusing to start a development fallback; reinstall the release app.",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function launchInstalledApp(folder) {
  if (process.platform === "darwin") {
    const appPaths = [
      "/Applications/GitBoss.app",
      resolve(process.env.HOME ?? "", "Applications/GitBoss.app"),
    ];

    if (appPaths.some((appPath) => existsSync(appPath))) {
      await spawnDetached("open", [
        "-n",
        "-a",
        "GitBoss",
        "--args",
        folder,
      ]);
      return true;
    }
  }

  if (process.platform === "linux") {
    const candidates = [
      process.env.GITBOSS_APPIMAGE,
      resolve(process.env.HOME ?? "", ".local/bin/GitBoss.AppImage"),
      "/usr/bin/gitboss",
    ].filter(Boolean);

    const app = candidates.find(
      (candidate) =>
        isExecutable(candidate) && !resolvesTo(candidate, launcherPath),
    );

    if (app) {
      await spawnDetached(app, [folder]);
      return true;
    }
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const candidates = [
      process.env.GITBOSS_EXE,
      resolve(localAppData, "Programs/GitBoss/GitBoss.exe"),
      resolve(localAppData, "GitBoss/GitBoss.exe"),
    ].filter(Boolean);

    const exe = candidates.find((candidate) => existsSync(candidate));
    if (exe) {
      await spawnDetached(exe, [folder]);
      return true;
    }
  }

  return false;
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, args, {
      ...options,
      detached: true,
      stdio: "ignore",
    });

    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
    child.once("error", rejectSpawn);
  });
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvesTo(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}
