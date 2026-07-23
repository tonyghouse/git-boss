#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

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

  if [[ "$default" == "yes" ]]; then
    read -r -p "$prompt [Y/n] " answer
    [[ -z "$answer" || "$answer" =~ ^[Yy]$ ]]
  else
    read -r -p "$prompt [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]]
  fi
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

  if ! prompt_yes_no "Close GitBoss before installing the generated app?" "yes"; then
    printf "App installation skipped. Rerun ./install.sh after closing GitBoss.\n"
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
    printf "App installation skipped. Close GitBoss and rerun ./install.sh.\n"
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

  printf "%sGitBoss is still running. App installation skipped.%s\n" "$RED" "$RESET"
  return 1
}

linux_family() {
  local linux_id="" linux_id_like=""

  if [[ -r /etc/os-release ]]; then
    linux_id="$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print tolower($2) }' /etc/os-release)"
    linux_id_like="$(awk -F= '$1 == "ID_LIKE" { gsub(/"/, "", $2); print tolower($2) }' /etc/os-release)"
  fi

  case "$linux_id" in
    ubuntu|debian|linuxmint|pop|elementary|zorin)
      printf "debian"
      return
      ;;
  esac

  case "$linux_id_like" in
    *debian*|*ubuntu*) printf "debian" ;;
    *) printf "other" ;;
  esac
}

bundle_target() {
  case "$(uname -s)" in
    Darwin)
      printf "app,dmg"
      ;;
    Linux)
      if [[ "$(linux_family)" == "debian" ]]; then
        printf "deb"
      else
        printf "appimage"
      fi
      ;;
    *)
      printf ""
      ;;
  esac
}

install_generated_app() {
  request_close_running_app || return 0

  case "$(uname -s)" in
    Darwin)
      local app_path
      app_path="$(find src-tauri/target/release/bundle/macos -maxdepth 1 -type d -name "GitBoss.app" 2>/dev/null | head -n 1)"

      if [[ -z "$app_path" ]]; then
        printf "%sCould not find generated GitBoss.app.%s\n" "$YELLOW" "$RESET"
        return
      fi

      printf "Installing %s to /Applications/GitBoss.app\n" "$app_path"
      ditto "$app_path" "/Applications/GitBoss.app"
      ;;
    Linux)
      if [[ "$(linux_family)" == "debian" ]]; then
        local deb_path
        deb_path="$(find "$ROOT_DIR/src-tauri/target/release/bundle/deb" -type f -name "*.deb" 2>/dev/null | sort | tail -n 1)"

        if [[ -z "$deb_path" ]]; then
          printf "%sCould not find generated Debian package.%s\n" "$YELLOW" "$RESET"
          return
        fi

        printf "Installing %s\n" "$deb_path"
        sudo apt install "$deb_path"
      else
        local appimage_path install_path
        appimage_path="$(find src-tauri/target/release/bundle/appimage -type f -name "*.AppImage" 2>/dev/null | sort | tail -n 1)"

        if [[ -z "$appimage_path" ]]; then
          printf "%sCould not find generated AppImage.%s\n" "$YELLOW" "$RESET"
          return
        fi

        install_path="$HOME/.local/bin/GitBoss.AppImage"
        mkdir -p "$HOME/.local/bin"
        cp "$appimage_path" "$install_path"
        chmod +x "$install_path"
        printf "Installed AppImage to %s\n" "$install_path"
      fi
      ;;
  esac
}

install_cli_shim() {
  local bin_dir shim_path
  bin_dir="$HOME/.local/bin"
  shim_path="$bin_dir/gitboss"

  mkdir -p "$bin_dir"
  cat > "$shim_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail

input="\${1:-.}"
shim_path="$shim_path"

case "\$input" in
  /*) target="\$input" ;;
  *) target="\$(pwd)/\$input" ;;
esac

if [[ ! -d "\$target" ]]; then
  printf "GitBoss expected a folder: %s\n" "\$target" >&2
  exit 1
fi

launch_detached() {
  if command -v setsid >/dev/null 2>&1; then
    setsid -f "\$@" </dev/null >/dev/null 2>&1
  else
    nohup "\$@" </dev/null >/dev/null 2>&1 &
  fi
}

case "\$(uname -s)" in
  Darwin)
    if [[ -d "/Applications/GitBoss.app" || -d "\$HOME/Applications/GitBoss.app" ]]; then
      open -n -a "GitBoss" --args "\$target"
      exit 0
    fi
    ;;
  Linux)
    for installed_app in \
      "\$HOME/.local/bin/GitBoss.AppImage" \
      "/usr/bin/gitboss"; do
      if [[ -x "\$installed_app" && "\$installed_app" != "\$shim_path" ]]; then
        launch_detached "\$installed_app" "\$target"
        exit 0
      fi
    done
    ;;
esac

printf "GitBoss is not installed. Refusing to start a development fallback; reinstall the release app.\n" >&2
exit 1
EOF

  chmod +x "$shim_path"
  printf "Installed gitboss command to %s\n" "$shim_path"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      printf "%s%s is not currently in PATH.%s\n" "$YELLOW" "$bin_dir" "$RESET"

      if prompt_yes_no "Add $bin_dir to your shell profile now?" "yes"; then
        add_cli_bin_to_path "$bin_dir"
      else
        printf "Add this line to your shell profile to run gitboss from any terminal:\n"
        printf "  export PATH=\"%s:\$PATH\"\n" "$bin_dir"
      fi
      ;;
  esac
}

add_cli_bin_to_path() {
  local bin_dir="$1"
  local profile shell_name

  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)
      profile="$HOME/.zshrc"
      ;;
    bash)
      if [[ "$(uname -s)" == "Darwin" ]]; then
        profile="$HOME/.bash_profile"
      else
        profile="$HOME/.bashrc"
      fi
      ;;
    *)
      profile="$HOME/.profile"
      ;;
  esac

  touch "$profile"

  if grep -Fq "$bin_dir" "$profile"; then
    printf "%s already contains %s\n" "$profile" "$bin_dir"
    return
  fi

  {
    printf "\n# GitBoss CLI\n"
    printf "export PATH=\"%s:\$PATH\"\n" "$bin_dir"
  } >> "$profile"

  printf "Added %s to %s\n" "$bin_dir" "$profile"
  printf "Open a new terminal or run: source %s\n" "$profile"
}

printf "%sGitBoss Source Installer%s\n" "$BOLD" "$RESET"
printf "%s\n\n" "------------------------"

if ! bash scripts/doctor.sh; then
  if prompt_yes_no "Run available prerequisite installers now?" "no"; then
    bash scripts/doctor.sh --install || true
  fi

  printf "\nRechecking prerequisites...\n"
  if ! bash scripts/doctor.sh; then
    printf "\n%sInstall cannot continue until the required prerequisites pass.%s\n" "$RED" "$RESET"
    exit 1
  fi
fi

if ! prompt_yes_no "Build GitBoss now?" "yes"; then
  printf "Build skipped.\n"
  exit 0
fi

target="$(bundle_target)"
if [[ -z "$target" ]]; then
  printf "%sUnsupported operating system for install.sh.%s\n" "$RED" "$RESET"
  printf "Use install.ps1 on Windows.\n"
  exit 1
fi

printf "\n%sInstalling npm dependencies%s\n" "$BOLD" "$RESET"
npm ci

printf "\n%sBuilding GitBoss (%s)%s\n" "$BOLD" "$target" "$RESET"
npm run build -- --bundles "$target"

printf "\n%sBuild complete.%s\n" "$GREEN" "$RESET"
printf "Generated artifacts are under src-tauri/target/release/bundle\n"

if prompt_yes_no "Install the generated app now?" "yes"; then
  install_generated_app
else
  printf "App installation skipped.\n"
fi

if prompt_yes_no "Install the gitboss terminal command now?" "yes"; then
  install_cli_shim
else
  printf "Terminal command installation skipped.\n"
fi
