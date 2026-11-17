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

- **Request traces on the sequence diagram** (#143). The dev server now starts with `bynk dev --trace-events`, and each request it serves can be shown over the diagram of the handler it went through: the calls it made (capability, cross-context and agent), in order, coloured with the time each took; the branches and calls it did not take faded; a failing call in red; and the request's error with stack frames that open the `.bynk` source. Pick among the last 20 requests per handler (the latest is shown by default), or compare two to see which calls were slower. **Send Request** has a **Show trace** button, and **Bynk: Show Last Request Trace** opens the newest one. A call into another context shows the callee's own request when it was traced too (bynk v0.632.2). Traces stay in memory, are never written to a log, and carry no argument values. The new `bynk.dev.traceRequests` setting (on by default) turns it off; the flag is passed only to a `bynk` of v0.627.1 or later, and an older one starts as before, with a note in the Bynk Logs channel.
- **Live agent instances on the agent state view** (#145). While `bynk dev` runs (started from the editor), the view gains a **Live instances** section: the instances of the agent that a handler has addressed in this session, by key. Choose one to see its stored state in Bynk's own terms (`Placed`, `Ok(42)`), its schema version beside the class's current one (with a link to State Migrations when it is behind), and its recent transitions, which you can step through with Back, Forward and Latest. The state diagram marks the state the instance, or the step you are on, is in. It reads the local dev server only, through `bynk dev inspect` (bynk#3581; needs `bynk` v0.633.2 or later for the history, v0.639.0 for Worker groups), and never writes, migrates or runs a handler. What an instance holds is shown in the view and is not logged anywhere. A transition a handler or `invariant` refuses is never committed, so it has no step to mark.
- **Test coverage on the model views** (#144). After **Run with Coverage**, the agent state view and the sequence diagram mark what no test ran, by projecting the run's line coverage onto each element's source range:
  - **Agent state view:** a transition is dashed amber when none of its lines ran, solid green when they did; a state no tested transition enters is marked too, and the handler × state table adds `✗ not tested`. The counts read "3 of 5 transitions tested". Clicking a transition still opens its source.
  - **Sequence diagram:** calls and sends, and each branch of an `if` or `match` (using the arm's own range, bynk v0.625.2 and later), are marked the same way, with "N of M calls tested" and "N of M branches tested".
  - **Honest about what it is:** coverage is line-level and whole-run, so an element counts as tested when its lines ran; the view says it cannot say which test reached it. It also says how old the run is, and warns when the source has changed since (an unsaved edit, or a newer file). A path or branch whose lines hold no executable statement is left unmarked rather than claimed.
  - A **Show test coverage** checkbox hides the overlay, and **Bynk: Clear Model Coverage** removes it; the next coverage run replaces it. Marks never depend on colour alone: each carries a word on its tooltip and accessible name.

## [0.639.1] - 2026-11-17

### Changed

- **The agent state view's machine is redrawn** by the extension's own diagram engine, not Mermaid (model-diagrams track, slice 6). It is now UML state machine notation: a filled dot for the initial state, rounded states, a dashed `?` where a computed write lands, and unreachable states faded. Transitions a `transition` would refuse at commit are red (known) or amber (possible), with ⚠ and the refused `transition`'s name on the label. Clicking a state opens the field and clicking a transition opens its write. The handler under the cursor is marked in the table and on its transitions. The machine has the same zoom, **Copy as Mermaid**, **Save as SVG…** and **Save as PNG…** as the other diagrams, and needs no redraw when the theme changes.
- **Compare Model** draws its architecture map and the changed agents' state machines with the engine too. Added elements are green, changed ones amber and removed ones dashed ghosts, in the theme's source-control colours, each with a `+`, `~` or `−` sign. Clicking a working-tree element opens its source; a ghost opens nothing.
- **Mermaid is no longer part of the extension.** Every diagram draws with the engine; **Copy as Mermaid** still writes Mermaid text for Markdown. The desktop bundles shrink from about 9.1 MiB to 2.6 MiB: Mermaid (5.1 MiB) is gone, and the layout engine (ELK) now ships once, in `out/elk.js`, shared by the four pages that use it, instead of in two of them. Each page is under 110 KiB. `scripts/check-bundle.mjs` now holds every desktop bundle to a size budget.

### Added

- **Bynk: Show Component View** (model-diagrams track, slice 5): one context opened up as a UML component diagram. It is also on the editor title bar of a `.bynk` file.
  - **Inside:** the context's services, agents and providers as parts. Each service lists its handlers as operations, and each agent shows its key, its `store` fields and its handlers.
  - **On the border:** a provided port (UML ball) for each service, and a required port (socket) for each capability the context needs from outside and each consumed service it calls. Connectors show which part realises or needs each port.
  - **Outside, in grey:** the actors and contexts that call in, on the left; the platform, adapters and contexts that satisfy its requirements, on the right.
  - It follows the cursor's context (or pin it), and marks the service or agent the cursor is in.
  - Every element opens its source. An operation's **↗** opens its sequence diagram, and a neighbouring context's **↗** opens that context's component view.
  - Operations, calls, and agent keys and state need a `bynk` language server with bynk-lang/bynk#3657. With an older server the view draws the parts and the ports it can work out from capabilities and `consumes`.
- Moving between the views: each unit on the **architecture map** has a **↗** that opens its component view, and the **sequence diagram** has a **Components** button for the handler's context.

### Changed

- **The architecture map is redrawn** by the extension's own diagram engine, not Mermaid (model-diagrams track, slice 4). It is now a UML system view:
  - The project's contexts and adapters are **components inside a system boundary**. A collapsed one summarises what it holds (`http · 2 services · 1 agent`). Open it in place from the triangle on it (or Space on it) to see its services, agents, capabilities and providers. Which units are open is kept as the map refreshes.
  - **`consumes` cycles are marked** in the warning colour, on the units and the edges.
  - **Actors** (a service's `by` principals) stand outside the boundary, with a call into the service labelled by its protocol (`http`, `queue`, `cron`, …).
  - **Platform wiring:** a capability bound from a platform unit (`from bynk`) draws a dotted edge to that unit, from the service or agent that uses it when the unit is open.
  - **Events**, with who emits and who subscribes to them; **Events** in the toolbar hides them.
  - Clicking any element opens its source, and pointing at one marks its source in the editor, as on the sequence diagram. The map has the same zoom, pan, minimap, **Copy as Mermaid** and **Save as SVG/PNG**.
  - Actors, protocols and member-level wiring need a `bynk` language server with bynk-lang/bynk#3654; an older server's map draws without them.
- The layout comes from ELK (`elkjs`), bundled into the architecture page only.

### Added

- The sequence diagram draws what a `bynk` language server with model-diagrams slice 3 (bynk-lang/bynk#3651) now reports. With an older server the diagram is as before.
  - A `?` is a dashed **`break`** fragment, `[stored?]`, holding the early return.
  - A handler with no principal starts from a UML **found message** (a filled dot) labelled by its trigger: `call hit`, `cron "…"`, `event`, `message`.
  - An agent lifeline names the instance called: `«agent» Limiter[client]`.
  - A call into an agent or a consumed context has a **↗ link** after its label that opens the callee's own sequence diagram (a UML `ref`), moving the editor there too. Click it, or focus it and press Enter.
  - A branch's guard links to its own arm rather than the whole `if`/`match`.
  - **Copy as Mermaid** writes a `break` as a Mermaid `break` block.

### Added

- The sequence diagram has reading aids (model-diagrams track, slice 2):
  - **Pinned lifelines:** the lifeline heads stay at the top while you scroll a long diagram.
  - **Folding:** fold an `alt`/`opt` fragment from the triangle on its tab (or Space on the tab) to a one-line summary. Fragments nested three deep start folded, and your folds are kept as the diagram refreshes.
  - **Zoom and pan:** **−**, **+**, **Fit** and **100%** in the toolbar, Ctrl/Cmd + scroll (around the pointer) or the `+`, `-` and `0` keys; drag the background to pan. A minimap appears for diagrams much larger than the panel.
  - **Cursor sync:** the element under the editor's cursor is marked in the diagram and scrolled into view (a folded fragment stands in for what it hides). Pointing at or focusing an element marks its source in the editor.
  - **Save as SVG… / Save as PNG…** save the diagram in the current theme's colours.

### Changed

- The sequence diagram is drawn by the extension's own diagram engine instead of Mermaid, in UML notation: a call is a solid arrow with a filled head, a reply a dashed arrow with an open head, and a send a solid arrow with an open head. Lifelines show their stereotype (`«capability»`, `«context»`, `«agent»`), and activation bars show when each one is executing. Every element links to its source by identity, so clicks no longer depend on how Mermaid lays out its SVG. The diagram follows the colour theme as you switch, and you can move between its elements with the arrow keys and open one with Enter. **Copy as Mermaid** puts the diagram on the clipboard as Mermaid text, for Markdown (model-diagrams track, slice 1).
- The architecture map, the agent state view and Compare Model's diagrams share one copy of Mermaid instead of bundling one each. The architecture map and agent state view also redraw when you switch colour theme. With the sequence diagram's own engine, the packaged extension carries one copy of Mermaid rather than three, about 11 MB less (model-diagrams track, slice 0).

## [0.614.4] - 2026-11-16

Built against `bynk` v0.614.0. Fixes Run All Tests in a Bynk workspace.

### Fixed

- A request scenario opened while the language server was still analysing its project no longer stays stuck on "No handler serves …" (and **Promote Scenario to Test Suite** no longer keeps refusing with "No step resolves to a route") until a `.bynk` file is edited. The extension took the server's early, empty answer as the project's final list of routes and kept it. It now treats that answer as "not known yet" and asks again when the server finishes an analysis round. This was also the intermittent failure of the promote integration test.
- In a Bynk workspace (a root `bynk.toml` with `[workspace]`, such as
  bynk-lang/showcase), **Run All Tests** no longer also runs the tests at the
  workspace root itself. Every member's tests ran and passed, but the extra run at
  the root failed with "`--format ndjson` streams one project — run it inside a
  member of this workspace". A workspace root groups projects and is not one
  itself, so the extension no longer treats it as a project: Run All runs only the
  members, and a command that needs a project, with no `.bynk` file open, no longer
  falls back to the workspace root.

## [0.614.3] - 2026-11-16

Built against `bynk` v0.614.0. Compare Model draws its differences and compares
two revisions or a pull request; request scenarios run against test targets and
become `system` test suites; the Contract Diff panel can be filtered.

### Added

- **Bynk: Promote Scenario to Test Suite** (`bynk.scenario.promote`, and a `Promote to test suite` CodeLens on a scenario) writes a `.bynk-http` scenario as a `system`-tier suite under `tests/` (#158). Each step becomes a typed call (`api.PUT("/items/:id", "abc", Item { … }) by Visitor`) in one case; a `{{step.body.field}}` capture is the earlier answer's typed value, and `? status == N` is the `HttpResult` variant that carries it. Credentials are the case's `by <Actor>` (you pick the actor), never a header, and an environment value is never written into the suite. What a suite cannot express (response headers other than a redirect's `Location`, `exists`/`contains` and list-index paths, query strings, a step that reads one of those) is listed at the top of the suite and in a summary you confirm before anything is written; a step that cannot be a call is left out with the steps that read it. The suite is checked with `bynk check` before it is offered, in a scratch copy of the project that includes unsaved buffers (`bynk compile --sources-stdin` does not type-check a suite), and nothing is written if it does not check. It is a one-way copy.
- **Bynk: Compare Model with…** now draws the differences on the architecture map
  and the agent state diagrams, not only in the tables (#153). Added contexts,
  members, `consumes` edges, states and transitions are green, changed ones amber
  and removed ones dashed ghosts (struck through on a transition) that do not
  link anywhere, since their source is not in the working tree; every mark also
  carries a `+`, `~` or `−` so it does not rely on colour. The map keeps its
  expandable boxes; a state diagram is drawn for each agent, present in both
  revisions, whose state machine differs.
- **Contract Diff filter** (#157): **Show Contract Diff** on a context in the
  Environments view now opens the panel scoped to that context and environment,
  with a "Showing shop.payment in staging · Show all" chip that clears the
  filter. A filtered view hides the project-wide event and agent changes (they
  belong to no context or environment) and says how many it hid.
  `bynk.showContractDiff` takes an optional second argument,
  `{ context?, environment? }`; the existing `(uri)` form is unchanged.
- **Bynk: Run Scenario Against…** (`bynk.scenario.runAgainst`, and a `Run against…` CodeLens on a scenario) runs a `.bynk-http` scenario against a `[test.targets]` target from `bynk.toml`, using the same target picker as **Run System Tests Against…** (#159). Each step goes to the target's `url.<worker>` for its context; a context the target doesn't serve is reported on that step and nothing is sent for it. A run against a deployed target is confirmed first. A target marked `production = true` is refused (and not offered), as `bynk test --against` refuses it; against a target only *named* `prod`, `production` or `live`, a run that sends `POST`, `PUT`, `PATCH` or `DELETE` asks you to type the target's name instead. Credentials come from the environment only: a literal `Authorization`/token header in the file is refused against a target, a URL carrying credentials is refused, and the target's declared `secrets` are hidden from results along with every `{{env.…}}` value.
- **Bynk: Compare Model with…** classifies each handler's wire contract
  (`bynk/wireContract`) between the two revisions as compatible or breaking
  (#154), in a new Wire contracts section: a handler added is compatible, one
  removed or whose boundary changed breaking, and a changed contract is judged
  as a caller built against the earlier revision would meet the later one — the
  language server's rules for service contracts (a field added to a request must
  be optional or defaulted, a response variant added is breaking, a refinement
  tightened is breaking), applied by the extension to each revision's wire
  contract, with each reason named. Where unsure it says breaking. Agent
  invariants are not compared: `bynk/agentStateModel` does not expose them.
- **Bynk: Compare Model Between Revisions…** compares two revisions (or a
  revision and the working tree), not only a revision with the working tree
  (#155); `bynk.compareModel` also takes a second ref. A pull request in the
  GitHub Pull Requests view gets **Compare Bynk Model for Pull Request**: what
  the pull request changes (the merge base with its base branch) against its
  head, or against the working tree when it is checked out. That extension has
  no documented API or menu for this, so the entry reads its pull request item's
  `pullRequestModel.base` and `.head`; if that shape changes it falls back to
  asking for the revisions. A revision whose `bynk.lock` dependencies are not in
  the store (`bynk fetch` fills it; the compiler and the editor never fetch) is
  analysed without them, and the page now says so instead of leaving its model
  quietly incomplete.

## [0.614.2] - 2026-11-15

Built against `bynk` v0.614.0. New views of where a project is deployed, how it
has changed since a git revision, and saved request scenarios.

### Added

- **Environments view** (#150): a second view in the Bynk sidebar with one node
  per environment recorded in `bynk.deploy.lock`. Each lists its contexts with
  the contract hash of every deployed service, marks the contexts whose service
  contracts differ from the working tree (compatible or breaking, from the
  contract diff), and lists the agent classes whose floor or stored versions lag
  the current one (`bynk migrate status`). The environment's actions are Show
  Deploy Plan, Deploy…, Tail Logs and Sweep Migrations…, each the existing
  command with the environment preset, so their confirmations are unchanged;
  a context has Show Contract Diff. It reads local files and the offline report
  only. The ledger records no deploy time, so the view does not show one.
- **Bynk: Compare Model with…** (`bynk.compareModel`, also on the Source Control
  title bar) compares the project's model with a git revision (#147): pick a ref,
  defaulting to the merge base with the default branch, and a view lists the
  architecture (contexts, adapters, `consumes` edges, services, agents),
  contract, agent-state and capability differences against the working tree, each
  linking to its working-tree source. The other revision is read from a temporary
  `git worktree` analysed by the language server.
- Request scenarios: `.bynk-http` files, ordered HTTP requests you can rerun and share. **Save to scenario…** in **Bynk: Send Request** appends the form to one (under `<project>/scenarios/` by default; credential headers are saved as `{{env.NAME}}`). A step captures values from earlier responses (`{{create.body.id}}`), expects a status, body path or header (`? status == 201`), and is checked against the wire contract: an unknown or ambiguous route (name it with `@context`), a body that doesn't match the handler's type and a capture of a later step show as diagnostics, including after a contract change. `Run scenario` and `Run step` CodeLenses (and **Bynk: Run Scenario**) run it on the dev server with the results inline; a step that reads a failed or missing value is skipped and the run continues. Environment values never appear in results (#149).

## [0.614.1] - 2026-11-15

Built against `bynk` v0.614.0. Editor support for v0.607–v0.614's `bynk client`
and per-file `consumes`.

### Added

- **Bynk: Apply Fixes Across Project…** (`bynk.applyFixesAcrossProject`) runs
  `bynk check --fix=<codes>` for the codes you pick (those in the Problems
  panel, or typed), so a migration such as the per-file `consumes` warnings
  (`bynk.consumes.type_not_selected` and friends) is one command rather than a
  Fix All per file. Open Bynk files are saved first; it reports the files the
  CLI changed and the problems that remain, and shows the CLI's own message when
  it refuses or does not know a code (#130).
- `suite consumes` and `suite as consumes` snippets: a suite with its own `consumes` clause, placed after the header and before the first `case`, as Bynk v0.614 requires (#133).
- The Explorer marks the TypeScript client `bynk client` writes as generated: a `GN` badge and a tooltip on `[build.client] out` from each project's `bynk.toml` (the four modules of `layout = "dir"` too), including when `out` leaves the project. The first edit to one shows a one-time notice, with a Regenerate action when `bynk.generateClient` is registered. Switch it off with `bynk.fileDecorations.generatedClient` (#134).
- **Bynk: Generate TypeScript Client (experimental)** (`bynk.generateClient`), over `bynk client`. It takes an optional project root (a `Uri`) so other features can regenerate a given project. With `[build.client]` in `bynk.toml` it runs with no flags and the CLI writes where the table says; otherwise it asks for a layout, a location and (when there are several) the `from http` services. Unsaved `.bynk` buffers are saved first, routes the client cannot represent are listed in the "Bynk Client" output channel and counted in the result message, and the CLI's refusals (a project that does not check, no matching service, a file it did not write) are shown in full (#131).
- A project whose `bynk.toml` has `[build.client]` is checked with `bynk client --check` after a save that could change its generated TypeScript client. A stale or missing client shows a warning in the status bar, whose menu offers **Regenerate** (when `bynk.generateClient` is available) and **Show difference** (the first differing line from the CLI), and clears once the check passes. A project with errors is skipped. `bynk.client.check` turns it off, and **Bynk: Check Generated Client** checks on demand (#132).

### Fixed

- Web: the per-file `consumes` warnings (`bynk.consumes.type_not_selected`,
  `capability_not_selected`, `unit_not_consumed`) are no longer hidden in a
  fragment of a split unit, where the file's own `consumes bynk { … }` doesn't
  list a name it uses (#135).

## [0.614.0] - 2026-11-15

Built against `bynk` v0.614.0.

### Changed

- The server pin moves to v0.614.0 (from v0.606.0) (#128).

## [0.606.0] - 2026-11-15

Built against `bynk` v0.606.0.

### Changed

- The server pin moves to v0.606.0 (from v0.562.0, via v0.603.10). The `doctor` golden is refreshed for v0.603.10 (#123, #126).

### Fixed

- Grammar: the `~>` send arrow is no longer highlighted as an operator. Bynk v0.606.0 removed it (parse error `bynk.parse.removed_send_arrow`); `e.detach()` replaces it (#124).

## [0.562.0] - 2026-11-12

Built against `bynk` v0.562.0.

### Changed

- The server pin moves to v0.562.0 (from v0.525.22). The web build's wasm size budget
  rises to 20 MiB, as the v0.562.0 module is about 16 MiB.
- Requires VS Code 1.145.0 or later (was 1.144.0); the integration suite runs
  on 1.145.0. Supersedes #112.

### Fixed

- Grammar: the `by` label in `@indexed(by: …)` is coloured as a keyword again (#118); `by` stays an ordinary name elsewhere.
- Grammar: `by` is a contextual keyword (bynk#3240). It is coloured as a keyword only in its clause positions (`by Actor`, `by binder: Actor`, a call-site `f() by Actor(…)`, `advance Clock by …`) and is an ordinary name elsewhere, so `fn bump(by: Int)` and `let by = 2` are no longer mis-highlighted.
- Grammar and wire contract: `DecodeError` (the renamed `JsonError`, bynk#3223) is a built-in type and a valid unchecked reason; `JsonError` is kept as a deprecated alias.

## [0.525.22] - 2026-11-10

Built against `bynk` v0.525.22.

### Changed

- The server pin moves to v0.525.22 (from v0.512.10). No extension changes.

## [0.512.10] - 2026-11-08

Built against `bynk` v0.512.10.

### Changed

- The server pin moves to v0.512.10 (through v0.512.5 and v0.512.9, which were
  not released separately). No extension changes.

## [0.510.34] - 2026-11-07

Built against `bynk` v0.510.34.

### Changed

- The extension no longer downloads `bynkc` (#86). `bynk` compiles in-process
  since bynk v0.510.34 (bynk-lang/bynk#2998), so the managed toolchain is
  `bynk` alone, and the server pin is v0.510.34. The next bynk release removes
  `bynkc` and the `bynkc-lsp` copy (bynk-lang/bynk#3013); this build no longer
  needs either.
- The contract check uses `bynk fmt -` as its parse oracle, not `bynkc fmt -`.
  Its local-build flag is `--bynk` (or `BYNK`), replacing `--bynkc`.
- The Doctor view says the compiler is in-process, rather than naming a
  `bynkc` version, when `bynk` reports it so.

### Deprecated

- `bynk.compilerPath`. It is no longer passed on as `BYNK_BYNKC`, which `bynk`
  ignores now. The Doctor view no longer offers it as a remedy.

## [0.510.25] - 2026-11-06

Built against `bynk` v0.510.25.

### Changed

- Provisions `bynk-lsp` v0.510.25 (was v0.510.2). (#96, #97, #98)

## [0.510.2] - 2026-11-05

Built against `bynk` v0.510.2.

### Added

- Highlights a multi-line string with a language tag (bynk#2958) in that
  language: `"""sql`, `"""json`, `"""html`, `"""css` and `"""js`, and their
  `r"""` raw forms. `\(…)` interpolation in the non-raw form stays Bynk, even
  inside the embedded language's own strings and comments (`'\(n)'` in SQL,
  `"\(x)"` in JSON). Comment toggling in the body uses the embedded language
  (`--` for SQL), and the embedded colouring always stops at the closing
  `"""`, even when a quote or bracket in the body is still open. An unknown tag
  such as `"""graphql` is coloured as a tag on a plain string. (#90)
- Highlights raw strings (`r"…"`, `r#"…"#`) and multi-line strings (`"""…"""`,
  `r"""…"""`) (bynk#2619). It also highlights the contextual keywords `private`, `par`,
  `json {` and the `stub … after`/`never` latency words, the `IsoDate`
  refinement, and the full escape set (`\r`, `\0`, `\u{…}`). This brings the
  grammar in line with the site copy, which changes with it. (#90)

### Fixed

- Uses the language server's new name, `bynk-lsp` (bynk-lang/bynk#2946). It
  downloads `bynk-lsp-<target>` and looks for `bynk-lsp` on `PATH`. If there is
  no `bynk-lsp`, it falls back to `bynkc-lsp`, the name before bynk v0.510.
  A copy cached under the old name is still used. The integration tests
  accept either name, so the nightly run against bynk@main, which builds only
  `bynk-lsp`, passes again. (#89)
- The doctor report's "set path" action works again with bynk v0.510.2, which
  renamed the language-server row `bynkc-lsp` → `bynk-lsp`; the old label is
  still recognised. (#92)

## [0.508.4] - 2026-11-05

Built against `bynk` v0.508.4.

### Changed

- Requires VS Code 1.144.0 or later (was 1.140.0); the integration suite runs
  on 1.144.0. (#83)

### Fixed

- Highlights a reserved word that names a field or member (bynk#2837) as a
  property or method before semantic highlighting loads, or where it is off: a
  field label before `:` (`{ type: String }`, `Push(from: …)`) and a member on
  the `.`'s line (`a.type`, `fn Sorted.from(…)`, `r.message`). (#79)

## [0.492.1] - 2026-11-03

Built against `bynk` v0.492.1.

### Fixed

- Keeps the extension in step with `bynk` main's editor contract: `const` is
  highlighted as a declaration keyword, the server's `constant` and `escape`
  semantic token types are declared, mapped to theme scopes and coloured by both
  themes, and the
  `bynk doctor` fixture follows the compiler's golden. (#72)
- Highlights `Decimal` as a built-in type.
- Highlights decimal literals (`1.20d`, `5d`, `0.005d`) as numbers. (#73)

## [0.447.0] - 2026-10-30

Built against `bynk` v0.447.0.

### Added

- **Bynk: Send Request** sends a request to the `from http` handler at the
  cursor, on the dev server, and shows the status, timing, headers and body. The
  form comes from the handler's wire contract: one field per `:name` path
  parameter, a headers box shared by the context's routes, and a JSON body
  pre-filled with a skeleton of the body's type. Like the wire contract it
  follows the cursor unless pinned, and it offers to start the dev server when
  none is running. A `Send request` CodeLens above each HTTP handler opens it
  (`bynk.sendRequest.codeLens`, on by default), as does the Project view's
  handler menu. (#67)
- **Doc examples node in the Testing view.** A suite with doc-comment examples
  now shows a "Doc examples" child holding them. Running it runs just those
  cases; running the suite still runs everything. The `doc-example` tag is
  unchanged, and case ids, seed pins, file runs and code lenses work as before.
  No new `bynk test` flag is needed.
- **Bynk: Tail Deployed Logs…** streams a deployed Worker's logs with
  `bynk tail`, in a terminal, with stack frames rewritten to `.bynk` lines. It
  asks for the environment, and for the context when the project has several.
  Needs a `bynk` with the command (v0.436.0 or newer).

### Changed

- Internal: the Doctor, Deploy Plan, npm Requirements, Explanation, Sweep Plan
  and Refined Type panels keep their state in instances created at activation
  and disposed with the extension, not in module-level variables. No
  user-visible change, except that the open panels are now closed when the
  extension deactivates.
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
