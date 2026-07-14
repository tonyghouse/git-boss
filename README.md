# GitBoss

GitBoss is a focused desktop Git tool. The first feature is a terminal opener plus a staging and commit surface:

```bash
gitboss .
```

That opens the current Git working tree in GitBoss, where you can stage files, unstage files, write a commit message, and commit.

When a Git command fails, GitBoss shows a toast with the exact command it ran and the error returned by Git.

## Tech Stack

- Tauri v2 desktop shell
- Rust native commands
- React 19
- TypeScript
- Vite
- Tailwind CSS v4
- lucide-react icons
- npm

## Install From Source

### macOS and Linux

```bash
git clone <repo-url>
cd git-boss
./install.sh
```

The installer:

- checks required build prerequisites
- runs `npm ci`
- builds the native desktop package for your OS
- asks whether to install the generated app
- asks whether to install the `gitboss` terminal command
- asks whether to add the command directory to your shell PATH when needed

Generated packages are created under:

```text
src-tauri/target/release/bundle
```

### Windows

```powershell
git clone <repo-url>
cd git-boss
.\install.cmd
```

You can also run the PowerShell installer directly:

```powershell
.\install.ps1
```

The Windows installer builds the NSIS package, can run the generated setup executable, and can install a `gitboss.cmd` shim.

## Uninstall

### macOS and Linux

```bash
./uninstall.sh
```

### Windows

```powershell
.\uninstall.cmd
```

You can also run the PowerShell uninstaller directly:

```powershell
.\uninstall.ps1
```

The uninstaller:

- removes the installed GitBoss app from common install locations
- removes the `gitboss` terminal command created by the installer
- asks before closing a running GitBoss app
- keeps preferences, cache, and local browser storage unless you explicitly delete them

Git repositories, working trees, Git history, and the source checkout are not touched.

For non-interactive app and terminal-command removal while keeping preferences/data:

```bash
./uninstall.sh --yes
```

On Windows:

```powershell
.\uninstall.ps1 -Yes
```

To also delete GitBoss preferences, cache, and local browser storage:

```bash
./uninstall.sh --yes --delete-data
```

On Windows:

```powershell
.\uninstall.ps1 -Yes -DeleteData
```

## Doctor

Run the setup check without building:

```bash
bash scripts/doctor.sh
```

On Windows:

```powershell
.\scripts\doctor.ps1
```

## Minimum Build Requirements

| Component | Minimum | Notes |
| --- | --- | --- |
| Git | Any recent version | Required at runtime and build time. |
| Node.js | `>= 20.19.0` | Node.js 22 LTS is recommended. |
| npm | `>= 10.0.0` | Use the npm bundled with Node.js LTS. |
| Rust | `>= 1.77.2` | Latest stable Rust via `rustup` is recommended. |
| Tauri CLI | No global install | The repo uses local `@tauri-apps/cli` from `npm ci`. |

## Development

Install dependencies:

```bash
npm ci
```

Run the desktop app against a repository:

```bash
npm run desktop:dev -- -- -- /path/to/repo
```

After `npm link`, the source CLI can also start dev mode:

```bash
npm link
gitboss .
```

If the installer says the command directory is not in PATH, add this to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

For zsh, use `~/.zshrc`. For bash on Linux, use `~/.bashrc`. For bash on macOS, use `~/.bash_profile`.

## Verification

```bash
npm run check
npm run frontend:build
cd src-tauri && cargo check
```

## Current Scope

Implemented:

- `gitboss .` style terminal opener through the CLI shim/source bin
- repository root resolution from the folder argument
- branch and change status display
- per-file stage and unstage
- stage all and unstage all
- commit message and commit action
- failure toast with command and Git error

Not implemented yet:

- diff viewer
- branch switching
- merge/rebase workflows
- file editor
- history graph
