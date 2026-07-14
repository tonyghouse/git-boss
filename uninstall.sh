#!/usr/bin/env bash

set -euo pipefail

ASSUME_YES=0
DELETE_DATA=0

usage() {
  cat <<'EOF'
GitBoss uninstaller

Usage:
  ./uninstall.sh [--yes] [--delete-data]

Options:
  --yes          Skip app and command-removal prompts. This does not delete preferences/cache.
  --delete-data  Also delete GitBoss preferences, cache, and local browser storage.
  -h, --help     Show this help.

By default, GitBoss preferences and app data are kept.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --yes|-y)
      ASSUME_YES=1
      ;;
    --delete-data)
      DELETE_DATA=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf "Unknown option: %s\n\n" "$arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  BOLD="$(printf '\033[1m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""
  GREEN=""
  YELLOW=""
  RED=""
  RESET=""
fi

prompt_yes_no() {
  local prompt="$1"
  local default="$2"
  local answer

  if (( ASSUME_YES )); then
    printf "%s yes\n" "$prompt"
    return 0
  fi

  if [[ "$default" == "yes" ]]; then
    read -r -p "$prompt [Y/n] " answer
    [[ -z "$answer" || "$answer" =~ ^[Yy]$ ]]
  else
    read -r -p "$prompt [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]]
  fi
}

confirm_delete_data() {
  if (( DELETE_DATA )); then
    printf "Preference/data deletion enabled by --delete-data.\n"
    return 0
  fi

  if (( ASSUME_YES )); then
    printf "Keeping GitBoss preferences and app data. Use --delete-data to remove them.\n"
    return 1
  fi

  prompt_yes_no "Delete GitBoss preferences, cache, and local browser storage?" "no"
}

running_app_pids() {
  case "$(uname -s)" in
    Darwin)
      pgrep -x "GitBoss" 2>/dev/null || true
      ;;
    Linux)
      {
        pgrep -x "gitboss" 2>/dev/null || true
        pgrep -x "GitBoss" 2>/dev/null || true
      } | sort -u
      ;;
  esac
}

wait_for_app_exit() {
  local seconds="$1"
  local elapsed=0

  while (( elapsed < seconds )); do
    if [[ -z "$(running_app_pids)" ]]; then
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  [[ -z "$(running_app_pids)" ]]
}

request_close_running_app() {
  if [[ -z "$(running_app_pids)" ]]; then
    return 0
  fi

  printf "%sGitBoss is currently running.%s\n" "$YELLOW" "$RESET"

  if ! prompt_yes_no "Close GitBoss before uninstalling?" "yes"; then
    printf "Uninstall skipped. Close GitBoss and rerun this script.\n"
    return 1
  fi

  case "$(uname -s)" in
    Darwin)
      if command -v osascript >/dev/null 2>&1; then
        osascript -e 'tell application "GitBoss" to quit' >/dev/null 2>&1 || true
      fi
      ;;
    Linux)
      pkill -TERM -x "gitboss" 2>/dev/null || true
      pkill -TERM -x "GitBoss" 2>/dev/null || true
      ;;
  esac

  if wait_for_app_exit 15; then
    return 0
  fi

  printf "%sGitBoss did not close within 15 seconds.%s\n" "$YELLOW" "$RESET"

  if ! prompt_yes_no "Force close GitBoss now?" "no"; then
    printf "Uninstall skipped. Close GitBoss and rerun this script.\n"
    return 1
  fi

  case "$(uname -s)" in
    Darwin)
      pkill -KILL -x "GitBoss" 2>/dev/null || true
      ;;
    Linux)
      pkill -KILL -x "gitboss" 2>/dev/null || true
      pkill -KILL -x "GitBoss" 2>/dev/null || true
      ;;
  esac

  if wait_for_app_exit 5; then
    return 0
  fi

  printf "%sGitBoss is still running. Uninstall skipped.%s\n" "$RED" "$RESET"
  return 1
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    printf "%sAdministrator permissions are required for:%s %q" "$YELLOW" "$RESET" "$1"
    shift
    printf " %q" "$@"
    printf "\n"
    return 1
  fi
}

is_dangerous_path() {
  local path="${1%/}"

  [[ -z "$path" ||
    "$path" == "/" ||
    "$path" == "$HOME" ||
    "$path" == "/Applications" ||
    "$path" == "$HOME/Applications" ||
    "$path" == "$HOME/.local/bin" ||
    "$path" == "${XDG_DATA_HOME:-$HOME/.local/share}" ||
    "$path" == "${XDG_CACHE_HOME:-$HOME/.cache}" ||
    "$path" == "${XDG_CONFIG_HOME:-$HOME/.config}" ]]
}

remove_path() {
  local path="$1"
  local label="$2"

  if [[ -z "$path" ]]; then
    return 0
  fi

  if is_dangerous_path "$path"; then
    printf "%sRefusing to remove unsafe %s path: %s%s\n" "$RED" "$label" "$path" "$RESET"
    return 1
  fi

  if [[ ! -e "$path" && ! -L "$path" ]]; then
    printf "Not found: %s\n" "$path"
    return 0
  fi

  if rm -rf "$path" 2>/dev/null; then
    printf "Removed %s: %s\n" "$label" "$path"
    return 0
  fi

  printf "%sCould not remove %s without elevated permissions.%s\n" "$YELLOW" "$path" "$RESET"
  if prompt_yes_no "Use sudo to remove it now?" "no"; then
    run_privileged rm -rf "$path"
    printf "Removed %s: %s\n" "$label" "$path"
  else
    printf "Left in place: %s\n" "$path"
  fi
}

find_debian_package() {
  local package status

  for package in gitboss git-boss io.gitboss.desktop; do
    status="$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)"
    if [[ "$status" == "install ok installed" ]]; then
      printf "%s" "$package"
      return 0
    fi
  done

  return 1
}

remove_debian_package() {
  if ! command -v dpkg-query >/dev/null 2>&1; then
    return 0
  fi

  local package
  package="$(find_debian_package || true)"
  if [[ -z "$package" ]]; then
    printf "No installed Debian package found for GitBoss.\n"
    return 0
  fi

  printf "Removing Debian package: %s\n" "$package"
  if command -v apt >/dev/null 2>&1; then
    run_privileged apt remove -y "$package"
  else
    run_privileged dpkg -r "$package"
  fi
}

is_gitboss_cli_shim() {
  local path="$1"

  [[ -f "$path" ]] || return 1

  grep -Fq "GitBoss" "$path" 2>/dev/null &&
    grep -Eq "SOURCE_DIR=|desktop:dev|GitBoss expected a folder" "$path" 2>/dev/null
}

remove_cli_shim() {
  local shim_path="$HOME/.local/bin/gitboss"

  printf "\n%sRemoving terminal command%s\n" "$BOLD" "$RESET"

  if [[ ! -e "$shim_path" && ! -L "$shim_path" ]]; then
    printf "Not found: %s\n" "$shim_path"
    return 0
  fi

  if is_gitboss_cli_shim "$shim_path"; then
    remove_path "$shim_path" "terminal command"
    return
  fi

  printf "%s%s exists but does not look like the GitBoss installer shim.%s\n" "$YELLOW" "$shim_path" "$RESET"

  if (( ASSUME_YES )); then
    printf "Left in place: %s\n" "$shim_path"
    return
  fi

  if prompt_yes_no "Remove it anyway?" "no"; then
    remove_path "$shim_path" "terminal command"
  else
    printf "Left in place: %s\n" "$shim_path"
  fi
}

uninstall_macos_app() {
  printf "\n%sRemoving macOS app%s\n" "$BOLD" "$RESET"
  remove_path "$HOME/Applications/GitBoss.app" "app"
  remove_path "/Applications/GitBoss.app" "app"
}

uninstall_linux_app() {
  printf "\n%sRemoving Linux app%s\n" "$BOLD" "$RESET"
  remove_debian_package
  remove_path "$HOME/.local/bin/GitBoss.AppImage" "AppImage"
  remove_path "$HOME/.local/share/applications/io.gitboss.desktop.desktop" "desktop entry"
  remove_path "$HOME/.local/share/applications/GitBoss.desktop" "desktop entry"
}

data_paths() {
  case "$(uname -s)" in
    Darwin)
      printf "%s\n" \
        "$HOME/Library/Application Support/io.gitboss.desktop" \
        "$HOME/Library/Caches/io.gitboss.desktop" \
        "$HOME/Library/Preferences/io.gitboss.desktop.plist" \
        "$HOME/Library/WebKit/io.gitboss.desktop" \
        "$HOME/Library/Saved Application State/io.gitboss.desktop.savedState"
      ;;
    Linux)
      printf "%s\n" \
        "${XDG_DATA_HOME:-$HOME/.local/share}/io.gitboss.desktop" \
        "${XDG_CACHE_HOME:-$HOME/.cache}/io.gitboss.desktop" \
        "${XDG_CONFIG_HOME:-$HOME/.config}/io.gitboss.desktop"
      ;;
  esac
}

print_data_summary() {
  printf "\n%sPreferences and app data%s\n" "$BOLD" "$RESET"
  printf "GitBoss stores app-owned UI preferences, local browser storage, and cache separately from the app.\n"
  printf "Deleting this data may reset theme and WebView state. Git repositories, working trees, and Git history are not touched.\n\n"
  printf "Paths checked:\n"
  data_paths | while IFS= read -r path; do
    printf "  %s\n" "$path"
  done
}

remove_data() {
  data_paths | while IFS= read -r path; do
    remove_path "$path" "preferences/data"
  done
}

case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    printf "%sUnsupported operating system for uninstall.sh.%s\n" "$RED" "$RESET"
    printf "Use uninstall.ps1 or uninstall.cmd on Windows.\n"
    exit 1
    ;;
esac

printf "%sGitBoss Uninstaller%s\n" "$BOLD" "$RESET"
printf "%s\n\n" "-------------------"
printf "This removes the installed GitBoss app and the gitboss terminal command created by install.sh.\n"
printf "Later, this script asks whether to delete GitBoss preferences and app data. Press Enter to keep them.\n"

if prompt_yes_no "Remove the GitBoss application and terminal command now?" "yes"; then
  if ! request_close_running_app; then
    exit 0
  fi

  case "$(uname -s)" in
    Darwin) uninstall_macos_app ;;
    Linux) uninstall_linux_app ;;
  esac

  remove_cli_shim
else
  printf "Application and terminal command removal skipped.\n"
fi

print_data_summary
if confirm_delete_data; then
  if ! request_close_running_app; then
    exit 0
  fi

  remove_data
  printf "%sGitBoss preferences and app data removed.%s\n" "$GREEN" "$RESET"
else
  printf "GitBoss preferences and app data preserved.\n"
fi

printf "\n%sGitBoss uninstall finished.%s\n" "$GREEN" "$RESET"
