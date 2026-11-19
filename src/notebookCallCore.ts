// #213: Insert Handler Call…, the pure part. No `vscode` import.
//
// A unit's handlers as the picker lists them, grouped by kind, and the actor a
// call of each runs as. The call itself is written by `scenarioPromoteCore`
// (`writeCall` for an HTTP route, `writeHandlerCall` for the rest).

import type { HandlerInfo, RouteInfo } from "./scenarioCore";

export type CallTarget = { route: RouteInfo; handler?: undefined } | { handler: HandlerInfo; route?: undefined };

export interface CallChoice {
  /** The group's heading in the picker. */
  group: string;
  /** The address a case calls it by. */
  label: string;
  /** What it takes. */
  description: string;
  target: CallTarget;
}

const GROUPS = ["HTTP", "on call", "Cron", "Queue", "Events"] as const;
const GROUP_OF: Record<Exclude<HandlerInfo["kind"], "websocket">, (typeof GROUPS)[number]> = { call: "on call", cron: "Cron", queue: "Queue", event: "Events" };

/** The parameters of a handler's envelope, as `name: Type`. */
function takes(model: Pick<HandlerInfo["model"], "envelope">): string {
  const env = model.envelope;
  const show = (name: string, shape: { kind: string; name?: string; base?: string }): string => `${name}: ${shape.kind === "Named" ? shape.name : shape.kind === "Base" ? shape.base : shape.kind === "Unit" ? "()" : "…"}`;
  if (env.kind === "Keyed") return env.params.map((p) => show(p.name, p.shape)).join(", ");
  if (env.kind === "Bare") return show(env.param, env.shape);
  if (env.kind === "Raw") return `${env.param}: raw ${env.contentType}`;
  return "";
}

/** One line for a handler of a kind a cell can call. */
function choiceFor(h: HandlerInfo): CallChoice | undefined {
  if (h.kind === "websocket") return undefined;
  const surface = h.kind === "cron" ? `${h.service}.schedule(${JSON.stringify(h.expr ?? "")})` : `${h.service}.${h.kind === "queue" ? "message" : h.kind}(…)`;
  return { group: GROUP_OF[h.kind], label: surface, description: takes(h.model), target: { handler: h } };
}

/** The handlers of `unit` a cell can call, in the order of `GROUPS` (HTTP
 *  routes first, as before), and the WebSocket services it cannot yet. */
export function callChoices(routes: readonly RouteInfo[], handlers: readonly HandlerInfo[], inUnit: (unit: string) => boolean): { choices: CallChoice[]; websocket: string[] } {
  const choices: CallChoice[] = [];
  for (const r of routes) if (inUnit(r.unit) && r.service) choices.push({ group: "HTTP", label: `${r.method} ${r.path}`, description: r.service, target: { route: r } });
  const websocket = new Set<string>();
  for (const h of handlers) {
    if (!inUnit(h.unit)) continue;
    const c = choiceFor(h);
    if (c) choices.push(c);
    else websocket.add(h.service);
  }
  // Stable within a group, so the picker keeps the file's order.
  choices.sort((a, b) => GROUPS.indexOf(a.group as (typeof GROUPS)[number]) - GROUPS.indexOf(b.group as (typeof GROUPS)[number]));
  return { choices, websocket: [...websocket].sort() };
}

/** The line the picker shows for the WebSocket services a cell cannot call yet. */
export function websocketNote(services: readonly string[]): string {
  return `WebSocket (${services.join(", ")}): not offered yet. It is driven by \`svc.open(tc, …)\`, \`svc.message(tc, frame)\` and \`svc.close(tc)\` on a test connection; write those in the cell.`;
}

/** The actors a call of `target` may run as. An HTTP route names the actors it
 *  admits. Another kind runs as its protocol's own internal actor, so a `by`
 *  clause is only written for an actor that carries an identity: the case
 *  must act as it (`bynk.test.principal_required`). */
export function actorsFor(target: CallTarget): string[] {
  if (target.route) return target.route.actors ?? [];
  const h = target.handler;
  return h.actors.filter((a) => h.identities[a] !== undefined);
}
