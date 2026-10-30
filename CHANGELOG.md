# Changelog

The extension's versions follow the Bynk toolchain's: `0.436.0` is the first
extension release built against `bynk` v0.436.0, and a fix to the extension alone
is the next patch (`0.436.1`). The pinned server is `bynkServerVersion` in
`package.json`. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

A change goes under **Unreleased** in the pull request that makes it. When a
version is tagged, rename that heading to the version and date, and add a fresh
**Unreleased** above it (`release.yml` refuses a tag with no section for its
version).

## [Unreleased]

### Added

- **Bynk: Tail Deployed Logs…** streams a deployed Worker's logs with
  `bynk tail`, in a terminal, with stack frames rewritten to `.bynk` lines. It
  asks for the environment, and for the context when the project has several.
  Needs a `bynk` with the command (v0.436.0 or newer).

### Changed

- A save refreshes the project it is in, not the whole workspace. The Project
  view reloads only that project, `bynk deps` is cached until the project's
  `bynk.toml` or `bynk.lock` changes, State Migrations are re-read only for the
  project that changed, a `bynk.toml` save rescans only the files under it for
  file decorations (bulk reads are bounded), and Show Compiled Output rebuilds
  only the views in the edited project, one compile per project.
- The Testing view shows one top-level item per Bynk project, with every test id
  namespaced by its project. It discovers all the workspace's projects, so Refresh
  with a non-Bynk editor focused no longer empties the tree, and a run goes to the
  project its items belong to rather than the focused editor's. A project that
  does not compile shows its error on its item. "Run against…" runs only the
  projects that declare the target. Seed pins carry over in a single-project
  workspace; in a larger one they can be pinned again.
- Test discovery runs on save, on open and when the active editor changes, instead
  of on every keystroke, and only for the project involved. Its compile errors no
  longer go to Problems, where they duplicated the language server's.
- Changing `bynk.executablePath` restarts the server.
- Internal: `testing.ts` is split into tree, discovery, run, report, driver, seed
  and target-picker modules. The seed memory and the record of what the `bynk`
  driver understands are now owned by `activate()` and passed in rather than held
  at module level, and `dirtyBuffers`, the diagnostic severity map and
  `escapeHtml` each have one definition.
- `bynk.executablePath`, `bynk.bynkPath` and `bynk.dev.args` are
  machine-scoped, so a workspace's settings cannot redirect them.
- The pure unit tests run in plain Node (`npm run test:unit`), with a coverage
  floor (`npm run test:unit:coverage`) and in CI right after the type check. The
  webview renderers now have jsdom tests, including that markup in a name or
  message renders as text.
- The Mermaid live panels no longer keep their webview alive while hidden; they restore from the host when shown again.
- One project-root rule everywhere (#40): the nearest `bynk.toml` at or above a file, never above its workspace folder (a loose file walks up, stopping below the home directory), so a stray `~/bynk.toml` no longer makes the LM tools or `/fix` run `bynk` against the home directory. The `bynkc: check` task is now one per project (a nested project is named in the command, so its diagnostics land on its own files), and `launch.json` debugging uses a nested project holding the active file.

### Fixed

- A project directory deleted while its file is open no longer makes Debug,
  test runs or the dev server say `bynk` is not installed. The cached project
  root is re-checked on use, and a start that fails because its working
  directory is gone now names that directory.
- Open Show Compiled Output views no longer cancel each other's builds, which
  left a view without highlighting until the next edit.
- A `bynk migrate status` that started before a sweep can no longer put its
  pre-sweep answer back in the State Migrations cache.
- Live panels (wire contract, agent state, sequence diagram and the rest) no longer show a stale render when commands or cursor moves overlap, and a refresh cut short by a cursor move into a handler with no model is redone.
- Bynk Logs rebuilds its output channel once per buffer's worth of lines instead of on every line once the buffer is full.
- Clicking through to a location in a view checks the message and reports a file that can no longer be opened, instead of failing silently.
- The refined-type explorer interprets each clause's structured `predicate` instead of running the server's JavaScript `check` text (#35). Only a `matches` pattern is run, as a regular expression under a time limit. A clause it cannot check is reported as "could not be checked" rather than passed or failed: an invalid pattern, an unknown kind, a condition that does not fit the type, an `Int` bound beyond 2^53 (already rounded by JSON), or a clause from a server older than v0.443.0, which shows "needs bynk v0.443.0 or newer".
- Export OpenAPI saves only the unsaved `.bynk` files, not every dirty document.
- The `@bynk` chat participant's Apply fix command rejects a malformed proposal with a message instead of throwing.
- The Test CodeLens provider disposes its event subscriptions.
- Starting and restarting the language server is serialized, so overlapping
  restarts or a download no longer leave two servers running, and a successful
  "Download Server" no longer shows "not running" (#31).
- Activation no longer waits on the "no server" prompt or a server download;
  the download can be cancelled and times out on a stalled connection (#31).
- A language client that fails to start is no longer left assigned (#31).
- The server's `--version` check no longer blocks the extension host, and the
  status bar no longer shows a stale project name when editors switch quickly.
- A debug session no longer freezes once the debugged CLI has written about
  64 KB: its output is read for the life of the session, and goes to the
  **Bynk Debug** output channel.
- The dev server, debug sessions and test runs stop through one helper: a
  process group on Linux and macOS, `taskkill /T /F` on Windows (untested on a
  real Windows machine), and no console window per debug session. Cancelling a
  test run ends the whole tree, and its cancellation listener is disposed.
- A missing `bynk` for the `bynkc: check` task is found by resolving the
  executable when the task starts (exit code 127 stays as a POSIX fallback).
- The packaged VSIX no longer ships the compiled test build (`out/src/**`) when
  tests were built before packaging, and CI now fails if it would.

## [0.436.0] - 2026-10-29

Built against `bynk` v0.436.0.

### Added

- **Bynk: Export OpenAPI…** writes an OpenAPI 3.1 document for the project's
  `from http` services with `bynk openapi`, as JSON or YAML by file name. It
  offers to save unsaved Bynk files first. Needs a `bynk` with the command
  (v0.436.0 or newer).
- Contract diff shows the compatible/breaking **verdict and reasons** for a
  changed service contract, when the language server reports them (v0.436.0 or
  newer).
- Explorer files with a contract break are marked with a `!` badge and a warning
  tint (`bynk.fileDecorations.contractBreaks`).
- `@bynk /fix` and `/learn` compile what they show before showing it. A fix
  that checks clean is offered as **Apply fix**; one that could not be checked
  as **Apply unchecked fix**.
- The doctor and migration-status fixtures are checked against the goldens the
  editor contract now ships, so drift from the compiler fails CI.

### Changed

- README: features are grouped, Testing is its own section, and the commands
  and settings tables list everything the extension contributes.
- Internally, new features register in one sorted table (`src/features.ts`) and
  webview bundles are discovered by a marker, so concurrent features no longer
  conflict on the same lines.

## [0.434.1] - 2026-10-27

First release from its own repository (`bynk-lang/vscode-bynk`), extracted from
the compiler repository. The language server and `bynk` toolchain are still
downloaded from the compiler's releases, pinned to `v0.434.0`.
