#!/usr/bin/env bash

set -u

MIN_NODE_VERSION="20.19.0"
RECOMMENDED_NODE_VERSION="22 LTS"
MIN_NPM_VERSION="10.0.0"
MIN_RUST_VERSION="1.77.2"

INSTALL_MODE=0
if [[ "${1:-}" == "--install" ]]; then
  INSTALL_MODE=1
fi

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  BOLD="$(printf '\033[1m')"
  RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""
  RED=""
  GREEN=""
  YELLOW=""
  RESET=""
fi

required_ok=1
native_missing=0
missing_git=0
missing_node=0
missing_npm=0
missing_rust=0
missing_cargo=0
missing_xcode=0
printed_linux_package_command=0

os_name="$(uname -s)"
linux_id=""
linux_id_like=""

if [[ "$os_name" == "Linux" && -r /etc/os-release ]]; then
  linux_id="$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print tolower($2) }' /etc/os-release)"
  linux_id_like="$(awk -F= '$1 == "ID_LIKE" { gsub(/"/, "", $2); print tolower($2) }' /etc/os-release)"
fi

title() {
  printf "\n%s%s%s\n" "$BOLD" "$1" "$RESET"
}

status_line() {
  local state="$1"
  local label="$2"
  local detail="$3"
  local color="$RESET"

  case "$state" in
    PASS) color="$GREEN" ;;
    WARN) color="$YELLOW" ;;
    FAIL) color="$RED" ;;
  esac

  printf "  %s%-4s%s  %-22s %s\n" "$color" "$state" "$RESET" "$label" "$detail"
}

mark_fail() {
  required_ok=0
}

clean_version() {
  printf "%s" "$1" | sed -E 's/^[^0-9]*//; s/[^0-9.].*$//'
}

version_ge() {
  local actual required
  actual="$(clean_version "$1")"
  required="$(clean_version "$2")"

  local actual_major actual_minor actual_patch required_major required_minor required_patch
  IFS=. read -r actual_major actual_minor actual_patch _ <<< "$actual"
  IFS=. read -r required_major required_minor required_patch _ <<< "$required"

  actual_major="${actual_major:-0}"
  actual_minor="${actual_minor:-0}"
  actual_patch="${actual_patch:-0}"
  required_major="${required_major:-0}"
  required_minor="${required_minor:-0}"
  required_patch="${required_patch:-0}"

  if (( actual_major > required_major )); then return 0; fi
  if (( actual_major < required_major )); then return 1; fi
  if (( actual_minor > required_minor )); then return 0; fi
  if (( actual_minor < required_minor )); then return 1; fi
  (( actual_patch >= required_patch ))
}

linux_family() {
  case "$linux_id" in
    ubuntu|debian|linuxmint|pop|elementary|zorin)
      printf "debian"
      return
      ;;
    fedora)
      printf "fedora"
      return
      ;;
    rhel|centos|rocky|almalinux|ol)
      printf "rhel"
      return
      ;;
    arch|manjaro)
      printf "arch"
      return
      ;;
    opensuse*|sles)
      printf "opensuse"
      return
      ;;
  esac

  case "$linux_id_like" in
    *debian*|*ubuntu*) printf "debian" ;;
    *fedora*) printf "fedora" ;;
    *rhel*) printf "rhel" ;;
    *arch*) printf "arch" ;;
    *suse*) printf "opensuse" ;;
    *) printf "unknown" ;;
  esac
}

command_version() {
  local command_name="$1"
  shift

  if ! command -v "$command_name" >/dev/null 2>&1; then
    return 1
  fi

  "$command_name" "$@" 2>/dev/null | head -n 1
}

check_git() {
  local version
  if version="$(command_version git --version)"; then
    status_line PASS "Git" "$version"
  else
    status_line FAIL "Git" "not found"
    missing_git=1
    mark_fail
  fi
}

check_node() {
  local version
  if version="$(command_version node --version)"; then
    version="$(clean_version "$version")"
    if version_ge "$version" "$MIN_NODE_VERSION"; then
      status_line PASS "Node.js" "$version"
    else
      status_line FAIL "Node.js" "$version found, >= $MIN_NODE_VERSION required"
      missing_node=1
      mark_fail
    fi
  else
    status_line FAIL "Node.js" "not found, >= $MIN_NODE_VERSION required"
    missing_node=1
    mark_fail
  fi
}

check_npm() {
  local version
  if version="$(command_version npm --version)"; then
    version="$(clean_version "$version")"
    if version_ge "$version" "$MIN_NPM_VERSION"; then
      status_line PASS "npm" "$version"
    else
      status_line FAIL "npm" "$version found, >= $MIN_NPM_VERSION required"
      missing_npm=1
      mark_fail
    fi
  else
    status_line FAIL "npm" "not found, >= $MIN_NPM_VERSION required"
    missing_npm=1
    mark_fail
  fi
}

check_rust() {
  local version
  if version="$(command_version rustc -V)"; then
    version="$(printf "%s" "$version" | awk '{ print $2 }')"
    if version_ge "$version" "$MIN_RUST_VERSION"; then
      status_line PASS "Rust" "$version"
    else
      status_line FAIL "Rust" "$version found, >= $MIN_RUST_VERSION required"
      missing_rust=1
      mark_fail
    fi
  else
    status_line FAIL "Rust" "not found, >= $MIN_RUST_VERSION required"
    missing_rust=1
    mark_fail
  fi

  if command -v cargo >/dev/null 2>&1; then
    status_line PASS "Cargo" "$(cargo -V 2>/dev/null | head -n 1)"
  else
    status_line FAIL "Cargo" "not found"
    missing_cargo=1
    mark_fail
  fi
}

check_macos_native() {
  if xcode-select -p >/dev/null 2>&1; then
    status_line PASS "Xcode CLT" "$(xcode-select -p 2>/dev/null)"
  else
    status_line FAIL "Xcode CLT" "not installed"
    missing_xcode=1
    mark_fail
  fi
}

check_linux_command() {
  local command_name="$1"
  local label="$2"

  if command -v "$command_name" >/dev/null 2>&1; then
    status_line PASS "$label" "$(command -v "$command_name")"
  else
    status_line FAIL "$label" "not found"
    native_missing=1
    mark_fail
  fi
}

check_pkg_config_package() {
  local label="$1"
  shift

  local package_name
  for package_name in "$@"; do
    if pkg-config --exists "$package_name" 2>/dev/null; then
      status_line PASS "$label" "$package_name"
      return
    fi
  done

  status_line FAIL "$label" "missing"
  native_missing=1
  mark_fail
}

check_libxdo() {
  local package_name
  for package_name in xdo xdotool; do
    if pkg-config --exists "$package_name" 2>/dev/null; then
      status_line PASS "libxdo" "$package_name"
      return
    fi
  done

  if command -v cc >/dev/null 2>&1; then
    local test_dir test_source test_bin
    test_dir="$(mktemp -d 2>/dev/null || true)"

    if [[ -n "$test_dir" ]]; then
      test_source="$test_dir/check-xdo.c"
      test_bin="$test_dir/check-xdo"

      printf '#include <xdo.h>\nint main(void) { return 0; }\n' > "$test_source"

      if cc "$test_source" -lxdo -o "$test_bin" >/dev/null 2>&1; then
        rm -f "$test_source" "$test_bin"
        rmdir "$test_dir" 2>/dev/null || true
        status_line PASS "libxdo" "xdo.h and -lxdo"
        return
      fi

      rm -f "$test_source" "$test_bin"
      rmdir "$test_dir" 2>/dev/null || true
    fi
  fi

  status_line FAIL "libxdo" "missing"
  native_missing=1
  mark_fail
}

check_linux_native() {
  check_linux_command cc "C compiler"
  check_linux_command make "make"
  check_linux_command curl "curl"
  check_linux_command wget "wget"
  check_linux_command file "file"

  if [[ "$(linux_family)" == "debian" ]]; then
    check_linux_command fakeroot "fakeroot"
  fi

  check_linux_command pkg-config "pkg-config"

  if command -v pkg-config >/dev/null 2>&1; then
    check_pkg_config_package "WebKitGTK 4.1" "webkit2gtk-4.1"
    check_pkg_config_package "OpenSSL" "openssl"
    check_libxdo
    check_pkg_config_package "AppIndicator" "ayatana-appindicator3-0.1" "appindicator3-0.1"
    check_pkg_config_package "librsvg" "librsvg-2.0"
  fi
}

print_linux_package_command_once() {
  if (( printed_linux_package_command == 1 )); then
    return
  fi

  printed_linux_package_command=1
  print_linux_package_command
}

print_linux_package_command() {
  [[ "$os_name" == "Linux" ]] || return

  case "$(linux_family)" in
    debian)
      cat <<'EOF'
  sudo apt update
  sudo apt install -y git build-essential curl wget file fakeroot pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
EOF
      ;;
    fedora)
      cat <<'EOF'
  sudo dnf check-update
  sudo dnf group install -y c-development
  sudo dnf install -y git curl wget file pkgconf-pkg-config webkit2gtk4.1-devel openssl-devel libxdo-devel libappindicator-gtk3-devel librsvg2-devel
EOF
      ;;
    rhel)
      cat <<'EOF'
  sudo dnf group install -y "Development Tools"
  sudo dnf install -y git curl wget file pkgconf-pkg-config webkit2gtk4.1-devel openssl-devel libxdo-devel libappindicator-gtk3-devel librsvg2-devel
EOF
      ;;
    arch)
      cat <<'EOF'
  sudo pacman -Syu
  sudo pacman -S --needed git base-devel curl wget file pkgconf webkit2gtk-4.1 openssl libxdo libayatana-appindicator librsvg
EOF
      ;;
    opensuse)
      cat <<'EOF'
  sudo zypper refresh
  sudo zypper install -t pattern devel_basis
  sudo zypper install git curl wget file pkg-config webkit2gtk3-devel libopenssl-devel libxdo-devel libappindicator3-devel librsvg-devel
EOF
      ;;
    *)
      cat <<'EOF'
  Follow the Tauri Linux prerequisites for your distribution:
  https://v2.tauri.app/start/prerequisites/
EOF
      ;;
  esac
}

run_linux_package_install() {
  [[ "$os_name" == "Linux" ]] || return

  case "$(linux_family)" in
    debian)
      sudo apt update || return 1
      sudo apt install -y git build-essential curl wget file fakeroot pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev || return 1
      ;;
    fedora)
      sudo dnf check-update || true
      sudo dnf group install -y c-development || return 1
      sudo dnf install -y git curl wget file pkgconf-pkg-config webkit2gtk4.1-devel openssl-devel libxdo-devel libappindicator-gtk3-devel librsvg2-devel || return 1
      ;;
    rhel)
      sudo dnf group install -y "Development Tools" || return 1
      sudo dnf install -y git curl wget file pkgconf-pkg-config webkit2gtk4.1-devel openssl-devel libxdo-devel libappindicator-gtk3-devel librsvg2-devel || return 1
      ;;
    arch)
      sudo pacman -Syu || return 1
      sudo pacman -S --needed git base-devel curl wget file pkgconf webkit2gtk-4.1 openssl libxdo libayatana-appindicator librsvg || return 1
      ;;
    opensuse)
      sudo zypper refresh || return 1
      sudo zypper install -t pattern devel_basis || return 1
      sudo zypper install git curl wget file pkg-config webkit2gtk3-devel libopenssl-devel libxdo-devel libappindicator3-devel librsvg-devel || return 1
      ;;
    *)
      print_linux_package_command
      return 1
      ;;
  esac
}

print_required_actions() {
  if (( required_ok == 1 )); then
    return
  fi

  title "Required actions"

  if (( missing_git == 1 )); then
    case "$os_name" in
      Darwin)
        if command -v brew >/dev/null 2>&1; then
          printf "  brew install git\n"
        else
          printf "  Install Git with Xcode Command Line Tools: xcode-select --install\n"
        fi
        ;;
      Linux)
        print_linux_package_command_once
        ;;
    esac
  fi

  if (( missing_node == 1 || missing_npm == 1 )); then
    if [[ "$os_name" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
      printf "  brew install node\n"
    else
      printf "  Install Node.js %s from https://nodejs.org/\n" "$RECOMMENDED_NODE_VERSION"
      printf "  Minimum required Node.js version: >= %s\n" "$MIN_NODE_VERSION"
    fi
  fi

  if (( missing_rust == 1 || missing_cargo == 1 )); then
    printf "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\n"
  fi

  if (( missing_xcode == 1 )); then
    printf "  xcode-select --install\n"
  fi

  if (( native_missing == 1 )); then
    print_linux_package_command_once
  fi
}

run_install_actions() {
  title "Installing available prerequisites"

  if [[ "$os_name" == "Darwin" ]]; then
    if (( missing_xcode == 1 )); then
      printf "Running: xcode-select --install\n"
      xcode-select --install || true
      printf "Complete the Apple installer, then rerun ./install.sh if the check still fails.\n"
    fi

    if (( missing_git == 1 || missing_node == 1 || missing_npm == 1 )); then
      if command -v brew >/dev/null 2>&1; then
        if (( missing_git == 1 )); then
          brew install git
        fi
        if (( missing_node == 1 || missing_npm == 1 )); then
          brew install node
        fi
      else
        printf "Homebrew was not found. Install Node.js %s from https://nodejs.org/.\n" "$RECOMMENDED_NODE_VERSION"
      fi
    fi
  fi

  if [[ "$os_name" == "Linux" && ( "$native_missing" == 1 || "$missing_git" == 1 ) ]]; then
    run_linux_package_install
  fi

  if (( missing_rust == 1 || missing_cargo == 1 )); then
    if command -v curl >/dev/null 2>&1; then
      printf "Running Rust installer from rustup.rs\n"
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
      printf "Restart your terminal or source your shell profile if Rust is still not detected.\n"
    else
      printf "curl is required before Rust can be installed with rustup.\n"
    fi
  fi
}

printf "%sGitBoss Setup Check%s\n" "$BOLD" "$RESET"
printf "%s\n" "-------------------"

title "System"
case "$os_name" in
  Darwin)
    status_line PASS "OS" "macOS $(sw_vers -productVersion 2>/dev/null) $(uname -m)"
    ;;
  Linux)
    pretty_name="$(awk -F= '$1 == "PRETTY_NAME" { gsub(/"/, "", $2); print $2 }' /etc/os-release 2>/dev/null)"
    status_line PASS "OS" "${pretty_name:-Linux} $(uname -m)"
    ;;
  *)
    status_line FAIL "OS" "$os_name is not supported by scripts/doctor.sh"
    mark_fail
    ;;
esac

title "Build and runtime requirements"
check_git
check_node
check_npm
check_rust

case "$os_name" in
  Darwin)
    check_macos_native
    ;;
  Linux)
    check_linux_native
    ;;
esac

print_required_actions

if (( INSTALL_MODE == 1 )); then
  run_install_actions
fi

if (( required_ok == 1 )); then
  printf "\n%sAll required prerequisites are available.%s\n" "$GREEN" "$RESET"
  exit 0
fi

printf "\n%sSome required prerequisites are missing.%s\n" "$RED" "$RESET"
exit 1
