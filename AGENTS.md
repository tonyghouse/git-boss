# GitBoss Agent Instructions

These instructions apply to this repository. They supplement the global rules from the user; if anything conflicts, follow the user-level or conversation-specific instruction.

## Project Shape

- GitBoss is a local-first Tauri v2 desktop app for opening a Git repository from the terminal and managing the first Git workflow: staging, unstaging, and committing files.
- The frontend lives in `src/` and uses React, TypeScript, Vite, Tailwind CSS v4, lucide-react icons, and small local UI primitives in `src/components/ui/`.
- The native app lives in `src-tauri/src/` and uses Rust plus Tauri commands to run Git operations.
- `src/lib/api.ts` is the frontend boundary for Tauri invokes. Keep it aligned with Rust `#[tauri::command]` functions and shared shapes in `src/lib/types.ts` and `src-tauri/src/models.rs`.

## Product Constraints

- Keep GitBoss focused. Do not turn this app into a full IDE, file editor, merge tool, hosting client, analytics product, or cloud sync product unless explicitly requested.
- Preserve the local-first model. Do not add network calls, telemetry, analytics, or cloud services unless explicitly requested.
- Every failed Git command surfaced to the UI must include both the command GitBoss ran and the error returned by Git.
- Treat repositories as user-owned data. Read status and run explicit user actions only; do not rewrite history or discard changes unless the user clearly requests that feature.

## Coding Conventions

- Prefer the smallest scoped change that preserves the current architecture.
- Use TypeScript strict types and keep frontend data models in camelCase.
- Rust models exposed to the frontend should use `#[serde(rename_all = "camelCase")]`.
- Keep command names and invoke argument names stable unless you update both frontend and Rust call sites together.
- Use existing local utilities such as `cn`, `Button`, `Textarea`, `Badge`, and `Card` before adding new helpers or UI primitives.
- Use lucide-react icons for app controls when an icon is needed.
- Keep the UI dashboard-first, dense, and task-oriented. Avoid marketing-page patterns or decorative layouts.
- Keep comments rare and practical; add them only where they clarify non-obvious Git, terminal, or platform behavior.
- Do not edit generated or build output such as `dist/`, `src-tauri/target/`, `src-tauri/gen/`, or `node_modules/`.

## Dependency And Package Rules

- Use npm for this project. Keep `package-lock.json` in sync when dependencies change.
- Do not switch package managers or introduce a new frontend framework.
- Avoid new dependencies unless they remove real complexity or are needed for a requested feature.
- Do not install global software or system packages as part of normal repo work.

## Verification

Use the lightest command that proves the change:

- `npm run check` for TypeScript typechecking.
- `npm run frontend:build` for frontend typecheck plus Vite build.
- `cd src-tauri && cargo check` for Rust compile checking.
- `npm run build` for a full Tauri desktop build.
- `npm run build:linux:deb` only when Debian packaging specifically needs verification.

Notes:

- Full Tauri builds may require Rust, Tauri OS dependencies, and platform-specific tooling.
- On Linux, `.deb` builds require `fakeroot`; `scripts/build.mjs` handles invoking it when a deb bundle is requested.
- There is no lint script currently configured. Do not claim lint verification unless one is added and run.

## Git And Review Safety

- Do not modify unrelated files.
- Do not commit, push, create PRs, merge PRs, or rewrite history unless explicitly asked.
- Before finishing, report what changed and which verification commands were run. If verification was skipped, say why.
