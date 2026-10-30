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

### Fixed

- Starting and restarting the language server is serialized, so overlapping
  restarts or a download no longer leave two servers running, and a successful
  "Download Server" no longer shows "not running" (#31).
- Activation no longer waits on the "no server" prompt or a server download;
  the download can be cancelled and times out on a stalled connection (#31).
- A language client that fails to start is no longer left assigned (#31).
- The server's `--version` check no longer blocks the extension host, and the
  status bar no longer shows a stale project name when editors switch quickly.
- The packaged VSIX no longer ships the compiled test build (`out/src/**`) when
  tests were built before packaging, and CI now fails if it would.

### Changed

- Changing `bynk.executablePath` restarts the server.
- `bynk.executablePath`, `bynk.bynkPath` and `bynk.dev.args` are
  machine-scoped, so a workspace's settings cannot redirect them.
- The pure unit tests run in plain Node (`npm run test:unit`), with a coverage
  floor (`npm run test:unit:coverage`) and in CI right after the type check. The
  webview renderers now have jsdom tests, including that markup in a name or
  message renders as text.

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
