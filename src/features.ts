// The features that register themselves from nothing more than the extension
// context, the shared refresh hub, the language-client getter or the output
// channel. `activate` runs this table, so adding such a feature is one import and
// one line here, in its sorted place, rather than a new call at the end of
// `activate` that every concurrent feature also edits (and conflicts on).
//
// Features that hand something back to `activate` (the Test Explorer's API, the
// live model views, which others use) stay registered there. The approvals are
// registered there too, just before this table runs, and passed in through
// `FeatureEnv` to the features that report to them.
//
// Registration order: the table runs right after the refresh hub and the
// approvals are built and before the Test Explorer and the live views, so a feature here
// registers earlier than it used to relative to those and later relative to the
// toolchain and task registrations, which moved in from the top. None of these
// reads another's registration at activation: they register commands and
// providers, and what they share (`testFailures`, the hub, the client getter) is
// module state or a getter, not a registration. A feature that does need to run
// after another belongs in `activate`, not here.

import type * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import type { ApprovalState } from "./approveRequirements";
import { registerCapabilityPath } from "./capabilityPath";
import { registerChatParticipant } from "./chatParticipant";
import { registerDebug } from "./debug";
import { registerDependencies } from "./dependencies";
import { registerDeploy } from "./deploy";
import { registerDevServer } from "./devServer";
import { registerDoctor } from "./doctor";
import { registerEmittedOutput } from "./emittedOutput";
import { registerExplainView } from "./explainView";
import { registerFileDecorations } from "./fileDecorations";
import { registerInlineDocRendering } from "./inlineDocRendering";
import { registerLmTools } from "./lmTools";
import { registerOpenapi } from "./openapi";
import { registerPlaygroundCommands } from "./playgroundCommands";
import { registerRefinedExplorer } from "./refinedExplorer";
import { registerTasks } from "./tasks";
import { registerTomlRecommendation } from "./tomlRecommendation";
import { registerToolchain } from "./toolchain";
import type { DriverSupport } from "./testStream";
import type { ViewRefresh } from "./viewRefresh";
import { registerViewsCodeLens } from "./viewsCodeLens";

/** What a feature may ask for. The client is a getter, since it is not started
 *  yet at registration and is recreated on every server start. */
export interface FeatureEnv {
  context: vscode.ExtensionContext;
  output: vscode.LogOutputChannel;
  viewRefresh: ViewRefresh;
  client: () => LanguageClient | undefined;
  /** What the `bynk` driver is known to understand, shared by the Test Explorer and
   *  the debugger. */
  driverSupport: DriverSupport;
  /** The npm-requirement approvals, which `bynk dev`/`deploy` output is reported to. */
  approvals: ApprovalState;
}

/** Keep this sorted by feature name. */
export const FEATURES: readonly ((env: FeatureEnv) => void)[] = [
  // #2469: the server's "Show capability path" action opens the references peek.
  ({ context }) => registerCapabilityPath(context),
  // #2465: `@bynk` in the Chat view, orchestrating the language-model tools.
  ({ context }) => registerChatParticipant(context),
  // v0.72: one-click debugging through the JavaScript debugger (ADR 0104).
  ({ context, driverSupport }) => registerDebug(context, driverSupport),
  // #2472: Add Dependency…, Fetch Dependencies, upgrade lenses, Publish….
  ({ context }) => registerDependencies(context),
  // #2101: plan-first deploy.
  ({ context, approvals }) => registerDeploy(context, approvals),
  // #2094: run and manage `bynk dev`.
  ({ context, approvals }) => registerDevServer(context, approvals),
  // #2095: "Bynk: Doctor", offered by failures elsewhere, never run on activation.
  ({ context }) => registerDoctor(context),
  // #2471: "Show Compiled Output", highlighted both ways through the source map.
  ({ context, viewRefresh }) => registerEmittedOutput(context, viewRefresh),
  // #2098: "Explain Diagnostic Code…" and the server's "Explain …" quick fix.
  ({ context, client }) => registerExplainView(context, client),
  // #2478: Explorer badges for each file's context, tints for failed tests and breaks.
  ({ context }) => registerFileDecorations(context),
  // #849: in-editor doc-comment rendering; client-side, works before the server is up.
  ({ context }) => registerInlineDocRendering(context),
  // #2463: the toolchain's answers as language-model tools.
  ({ context, client, viewRefresh }) => registerLmTools(context, client, viewRefresh),
  // #16: "Bynk: Export OpenAPI", a wrapper over `bynk openapi`.
  ({ context }) => registerOpenapi(context),
  // #2480: share a selection or a single-file program as a playground link.
  ({ context }) => registerPlaygroundCommands(context),
  // #2470: the "Refined Type" explorer.
  ({ context, client }) => registerRefinedExplorer(context, client),
  // B-2: the `bynkc: check` build task (errors → Problems via `$bynkc`).
  ({ context }) => registerTasks(context),
  // #2096: suggest a TOML extension, once, if none is installed.
  ({ context }) => registerTomlRecommendation(context),
  // The `bynk` driver + `bynkc` compiler, fetched beside the server so nothing needs `cargo install`.
  ({ context, output }) => registerToolchain(context, output),
  // DECISION D: the opt-in `Wire contract` handler lens.
  ({ context, viewRefresh }) => registerViewsCodeLens(context, viewRefresh),
];

/** Register every feature in the table. */
export function registerFeatures(env: FeatureEnv): void {
  for (const register of FEATURES) register(env);
}
