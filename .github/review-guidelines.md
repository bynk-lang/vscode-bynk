# Review guidelines for vscode-bynk

These are the maintainers' notes for reviewing a pull request here. The
repository is the Bynk extension for VS Code, written in TypeScript. It
highlights Bynk, runs the `bynk-lsp` language server, drives the `bynk` CLI
(check, test, dev, deploy), and shows webviews such as the diagrams, the
documentation and the architecture map. It also has a web build (`src/web`)
that runs Bynk compiled to WebAssembly.

Look first for what would be wrong for someone using the extension, then for
what makes the code harder to keep. Skip what `npm run check` (tsc) would
already report, since CI runs it.

## What matters most

- **Webviews.** Every webview's page comes from `renderWebviewHtml` in
  `webviewHost.ts`, or, for the CLI's action panels, `renderActionHtml` in
  `cliView.ts`. Both set a strict Content Security Policy with a fresh nonce
  per render. Text from a project, the CLI or the server reaches HTML only
  through `escapeHtml`, or as data in the payload. Flag a webview that builds
  its own page, loosens the CSP, or interpolates unescaped text.
- **Running processes.** The extension runs `bynk` with argument lists, never
  a shell string, and a long-lived child (the dev server and the like) goes
  through `proc.ts`, which stops its whole process tree. Flag a
  `child_process.exec`, a `shell: true`, or a child that can outlive its
  command. Paths from the workspace are arguments, and must stay inside the
  project where that matters (`pathInside.ts`).
- **Workspace trust.** A workspace's files are anyone's. Opening a folder
  must not run a project's code or the CLI on it beyond what the extension
  already does. Markdown that enables commands (`isTrusted`) must allow only
  the commands it names.
- **The server and the CLI.** The extension works with any `bynk-lsp` from
  `bynkServerMinVersion` up to `bynkServerVersion` in `package.json`. A change
  that calls a request or reads a field newer than the minimum must raise the
  minimum, by hand, or degrade when it's missing. `release.yml` moves
  `bynkServerVersion`, so a pull request shouldn't.
- **The editor contract.** Keywords, semantic tokens, snippets and the CLI's
  JSON shapes are checked against the compiler's published contract
  (`npm run check:contract`). A grammar, token or snippet change should keep
  it passing, and fixtures copied from the compiler stay equal to its goldens.
- **The web build.** Code under `src/web`, and anything it imports, can't use
  Node APIs (`node:fs`, `node:child_process` and so on). A feature that
  appears in both builds should behave the same in both, or say why not.

## TypeScript and structure

- Logic that can be tested without VS Code lives in a `…Core.ts` module with
  no `vscode` import. The module beside it does the VS Code wiring. Flag
  logic added to the wiring that could be pure.
- Commands, views and settings are declared in `package.json`
  (`contributes`) as well as in code. A new one needs both, with a title a
  user would understand, and a `when` clause where it only applies sometimes.
- Errors the user can act on reach them as a message that says what to do.
  Others go to the output channel. None are dropped silently.
- Disposables are pushed to the extension's context, or disposed of, so
  nothing leaks when a view or a workspace closes.

## Tests

- A change of behaviour comes with tests. Pure logic gets a unit test
  (`test/suite/*.unit.test.ts`, run by mocha). Behaviour that needs VS Code
  gets an integration test (`test/suite/*.test.ts`), and the web build has
  its own (`test/web`).
- Look for missing cases: an empty or missing project, a CLI that fails or
  isn't installed, an older server, a Windows path, and cancellation.
- Fixtures in `test/fixtures` that copy the compiler's output must stay equal
  to what the compiler produces.

## Documentation and style

- A change a user would notice adds a line under **Unreleased** in
  `CHANGELOG.md`, in the same pull request. A new command or setting is
  described in the README.
- British English throughout: in code comments, docs, and text the user sees
  ("behaviour", "organisation", "colour"; "licence" as a noun). VS Code's own
  identifiers, such as `color` in a theme key, stay as they are.
- Comments explain why something is done, in plain sentences. Issue and pull
  request numbers (`#130`) tie decisions to where they were taken.

## Severity here

- **Blocking:** a webview or process hole, code run from an untrusted
  workspace, a crash on activation, a broken web build, the minimum server
  version not raised when it must be, or the contract check broken.
- **Should fix:** a missing test for changed behaviour, an error dropped or
  shown wrongly, a leak, logic that belongs in a `…Core.ts` module, or a
  missing CHANGELOG line.
- **Nit:** wording, naming and small style points. Keep these few.
