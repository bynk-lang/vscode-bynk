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

- Live panels (wire contract, agent state, sequence diagram and the rest) no longer show a stale render when commands or cursor moves overlap, and a refresh cut short by a cursor move into a handler with no model is redone.
- Bynk Logs rebuilds its output channel once per buffer's worth of lines instead of on every line once the buffer is full.
- Clicking through to a location in a view checks the message and reports a file that can no longer be opened, instead of failing silently.

### Changed

- The Mermaid live panels no longer keep their webview alive while hidden; they restore from the host when shown again.

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
