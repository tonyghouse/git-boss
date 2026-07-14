#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gitBossDevServer = {
  hostname: "127.0.0.1",
  port: 1421,
  path: "/",
};
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

if (launchInstalledApp(target)) {
  process.exit(0);
}

try {
  await launchFromSource(target);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function launchInstalledApp(folder) {
  if (process.platform === "darwin") {
    const appPaths = [
      "/Applications/GitBoss.app",
      resolve(process.env.HOME ?? "", "Applications/GitBoss.app"),
    ];

    if (appPaths.some((appPath) => existsSync(appPath))) {
      spawnDetached("open", ["-n", "-a", "GitBoss", "--args", folder]);
      return true;
    }
  }

  if (process.platform === "linux") {
    const appImage =
      process.env.GITBOSS_APPIMAGE ??
      resolve(process.env.HOME ?? "", ".local/bin/GitBoss.AppImage");

    if (existsSync(appImage)) {
      spawnDetached(appImage, [folder]);
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
      spawnDetached(exe, [folder]);
      return true;
    }
  }

  return false;
}

async function launchFromSource(folder) {
  if (!existsSync(resolve(sourceRoot, "package.json"))) {
    console.error("GitBoss is not installed and the source checkout was not found.");
    process.exit(1);
  }

  if (await isGitBossDevServerRunning()) {
    const debugBinary = resolve(
      sourceRoot,
      "src-tauri",
      "target",
      "debug",
      process.platform === "win32" ? "gitboss.exe" : "gitboss",
    );

    if (!existsSync(debugBinary)) {
      await run("cargo", ["build"], {
        cwd: resolve(sourceRoot, "src-tauri"),
        stdio: "inherit",
      });
    }

    spawnDetached(debugBinary, [folder], { cwd: sourceRoot });
    return;
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(
    npmCommand,
    ["run", "desktop:dev", "--", "--", "--", folder],
    {
      cwd: sourceRoot,
      stdio: "inherit",
    },
  );

  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
}

function isGitBossDevServerRunning() {
  return new Promise((resolveProbe) => {
    const request = http.get(
      {
        ...gitBossDevServer,
        timeout: 750,
      },
      (response) => {
        let body = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolveProbe(body.includes("<title>GitBoss</title>"));
        });
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolveProbe(false);
    });
    request.on("error", () => resolveProbe(false));
  });
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, options);

    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${command} exited with status ${code ?? 1}`));
      }
    });
    child.on("error", rejectRun);
  });
}

function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: "ignore",
  });

  child.unref();
}
