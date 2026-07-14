import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const tauriArgs = ["build", ...args];

if (process.platform === "linux" && buildsDebPackage(args)) {
  run("fakeroot", ["tauri", ...tauriArgs]);
} else {
  run("tauri", tauriArgs);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error?.code === "ENOENT" && command === "fakeroot") {
    console.error(
      "fakeroot is required for Linux .deb builds. Install it with: sudo apt install fakeroot",
    );
  } else if (result.error) {
    console.error(result.error.message);
  }

  process.exit(result.status ?? 1);
}

function buildsDebPackage(cliArgs) {
  if (cliArgs.includes("--no-bundle")) {
    return false;
  }

  const requestedBundles = getRequestedBundles(cliArgs);

  if (requestedBundles) {
    return requestedBundles.includes("deb") || requestedBundles.includes("all");
  }

  const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const targets = tauriConfig.bundle?.targets;

  return (
    targets === "all" ||
    (Array.isArray(targets) && (targets.includes("deb") || targets.includes("all")))
  );
}

function getRequestedBundles(cliArgs) {
  for (let index = 0; index < cliArgs.length; index += 1) {
    const arg = cliArgs[index];

    if (arg === "--bundles" || arg === "-b") {
      const values = [];

      for (
        let bundleIndex = index + 1;
        bundleIndex < cliArgs.length && !cliArgs[bundleIndex].startsWith("-");
        bundleIndex += 1
      ) {
        values.push(...parseBundleList(cliArgs[bundleIndex]));
      }

      return values;
    }

    if (arg.startsWith("--bundles=")) {
      return parseBundleList(arg.slice("--bundles=".length));
    }
  }

  return null;
}

function parseBundleList(value) {
  return value
    ? value
        .split(",")
        .map((bundle) => bundle.trim().toLowerCase())
        .filter(Boolean)
    : [];
}
