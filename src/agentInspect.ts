// #145: live agent instances on the agent state view. Asks the running
// `bynk dev` session — through `bynk dev inspect` (bynk#3581), which finds the
// session's Workers itself — which instances of an agent exist and what one
// holds, and hands the agent state view the answer. Read-only: nothing here
// writes, migrates or runs a handler.
//
// The answers hold an instance's stored values, so they go to the page that
// asked and nowhere else: not the output channel, not a log (the rule
// `semanticValues.ts` and the dev logs keep too).

import * as vscode from "vscode";

import {
  inspectAgentArgs,
  inspectAgentsArgs,
  inspectFailure,
  instanceId,
  liveInstances,
  parseAgentInspection,
  parseAgentListing,
  toInstanceView,
  type AgentListing,
  type AgentInstanceRef,
} from "./agentInspectCore";
import { BynkNotFoundError, runBynk } from "./cli";
import { devServerRoot } from "./devServer";
import type { AgentStateModel, InstanceMessage, LiveInstances } from "./webview/stateTypes";

/** The refs of the last listing, per agent, so a page message names an
 *  instance the host listed and never supplies a key of its own. */
const listed = new Map<string, Map<string, AgentInstanceRef>>();

async function run(args: string[], root: vscode.Uri): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const { code, stdout, stderr } = await runBynk(args, root.fsPath);
    return code === 0 ? { ok: true, stdout } : { ok: false, reason: inspectFailure(stderr) };
  } catch (e) {
    if (e instanceof BynkNotFoundError) return { ok: false, reason: "the `bynk` command was not found" };
    return { ok: false, reason: "bynk dev inspect could not run" };
  }
}

/** The live instances of `agent`, or `undefined` when no dev server runs. */
export async function listLiveInstances(agent: string): Promise<LiveInstances | undefined> {
  const root = devServerRoot();
  if (!root) return undefined;
  const answer = await run(inspectAgentsArgs(agent), root);
  if (!answer.ok) return { instances: [], problems: [answer.reason] };
  const listing: AgentListing | undefined = parseAgentListing(answer.stdout);
  if (!listing) return { instances: [], problems: ["bynk dev inspect answered something unreadable"] };
  const refs = new Map<string, AgentInstanceRef>();
  for (const a of listing.agents) if (a.class === agent) refs.set(instanceId(a), a);
  listed.set(agent, refs);
  return {
    instances: liveInstances(listing, agent),
    problems: listing.errors.map((e) => (e.context ? `${e.context}: ${e.error}` : e.error)),
  };
}

/** Read the instance a page asked for, if the host listed it. */
export async function readLiveInstance(
  model: AgentStateModel,
  ref: string,
): Promise<InstanceMessage | undefined> {
  const root = devServerRoot();
  const instance = listed.get(model.agent)?.get(ref);
  if (!root || !instance) return undefined;
  const answer = await run(inspectAgentArgs(instance.class, instance.key, { context: instance.context || undefined }), root);
  if (!answer.ok) return { type: "instance", ref, agent: model.agent, failure: answer.reason };
  const inspection = parseAgentInspection(answer.stdout);
  if (!inspection) {
    return { type: "instance", ref, agent: model.agent, failure: "bynk dev inspect answered something unreadable" };
  }
  return { type: "instance", ref, agent: model.agent, inspection: toInstanceView(inspection, model.machines) };
}
