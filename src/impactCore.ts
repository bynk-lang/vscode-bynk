// #146: the Impact view's logic — given a type, event or service, who and what
// depends on it. A dependency-free join (no `vscode`): the host gathers what
// the language server knows and this decides what it means, so the unit tests
// compile against it directly (`impactView.ts` holds the tree and commands).
//
// What it joins, and where each piece comes from:
//   - other units that use it: the language server's references, grouped by the
//     unit each lies in, plus the units that `consumes` the declaring unit and
//     the handlers that call a service (the architecture model's `edges` and
//     each handler's `calls`, v0.634.4, which follow calls across contexts,
//     bynk#3582);
//   - events: the emitters and subscribers of an event (bynk#3583, v0.625.3);
//   - the boundary: the HTTP and `on call` handlers whose wire contract carries
//     it, and the contract diff's reading of it against the locks (a changed
//     event or agent schema, and the deployed service contracts that changed,
//     each with its environment). Whether a type sits in an *unchanged* lock
//     entry is not in any request, so that is not claimed;
//   - the generated client: the carrying `from http` routes, when `bynk.toml`
//     has `[build.client]`, narrowed to the services it names;
//   - tests: the cases whose source holds a reference to it.
//
// References are by name, as the server resolves them: a type is found where it
// is mentioned, not where a value of it flows from.

import { memberLabel, type Row } from "./queryCore";
import type { ArchLoc, ArchModel } from "./webview/architectureTypes";
import type { CdModel } from "./webview/contractDiffTypes";
import type { Range } from "./webview/types";

export interface Ref {
  uri: string;
  range: Range;
}

export type UnitKind = "context" | "commons" | "adapter" | "test";

/** A handler whose wire contract the host read, and where the symbol travels in it. */
export interface WireSite {
  unit: string;
  service: string;
  /** `GET /orders`, or the handler's name. */
  label: string;
  boundary: "Http" | "Call" | "Other";
  loc: ArchLoc;
  carries: { request: boolean; response: boolean };
}

/** What `[build.client]` in `bynk.toml` says. */
export interface ClientConfig {
  configured: boolean;
  /** The services it selects (`Name` or `unit.Name`); empty means all. */
  services: string[];
}

/** The `[build.client]` table of a `bynk.toml`: whether it is there, and which
 *  services (`service = "A"` or `services = ["A", "B"]`) it selects. */
export function clientConfig(toml: string): ClientConfig {
  let inTable = false;
  let configured = false;
  const services: string[] = [];
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      inTable = header[1].replace(/\s/g, "") === "build.client";
      configured ||= inTable;
      continue;
    }
    if (!inTable) continue;
    const kv = /^(service|services)\s*=\s*(.+)$/.exec(line);
    if (kv) for (const m of kv[2].matchAll(/"([^"]*)"|'([^']*)'/g)) services.push(m[1] ?? m[2]);
  }
  return { configured, services };
}

export interface ImpactInput {
  name: string;
  /** The unit that declares it; `undefined` when it could not be found. */
  declaringUnit?: string;
  references: readonly Ref[];
  /** Each referencing file's unit, by URI. */
  unitOf: Readonly<Record<string, { name: string; kind: UnitKind } | undefined>>;
  model: ArchModel | null;
  wires: readonly WireSite[];
  contract: CdModel | null;
  /** The test cases of each test file, by URI. */
  testCases: Readonly<Record<string, ReadonlyArray<{ name: string; range: Range }> | undefined>>;
  client: ClientConfig;
}

export interface UnitImpact {
  unit: string;
  kind: UnitKind;
  /** Why it is listed. */
  why: string[];
  rows: Row[];
}

export interface ImpactAnswer {
  name: string;
  units: UnitImpact[];
  /** `undefined` when the name is not an event (or the server predates events). */
  event?: { emitters: Row[]; subscribers: Row[] };
  boundary: {
    /** Handlers whose wire contract carries it. */
    wire: Row[];
    /** The contract diff's changes to it, against `bynk.schema.lock`. */
    changes: Row[];
    /** Deployed service contracts of the carrying services, per environment. */
    deployed: Row[];
  };
  client: { configured: boolean; routes: Row[] };
  tests: Row[];
  /** What this could not tell, for the view to say. */
  notes: string[];
}

const isName = (candidate: string, name: string): boolean => candidate === name || candidate.endsWith(`.${name}`);

const refRow = (r: Ref, unit: string): Row => ({
  label: `${lastSegment(r.uri)}:${r.range.start.line + 1}`,
  description: unit,
  loc: { uri: r.uri, range: r.range },
});

const lastSegment = (uri: string): string => decodeURIComponent(uri.slice(uri.lastIndexOf("/") + 1));

const contains = (outer: Range, inner: Range): boolean =>
  (outer.start.line < inner.start.line || (outer.start.line === inner.start.line && outer.start.character <= inner.start.character)) &&
  (outer.end.line > inner.end.line || (outer.end.line === inner.end.line && outer.end.character >= inner.end.character));

export function impactOf(input: ImpactInput): ImpactAnswer {
  const { name, model } = input;
  const notes: string[] = [];
  const byUnit = new Map<string, UnitImpact>();
  const unit = (n: string, kind: UnitKind): UnitImpact => {
    let u = byUnit.get(n);
    if (!u) {
      u = { unit: n, kind, why: [], rows: [] };
      byUnit.set(n, u);
    }
    return u;
  };
  const why = (u: UnitImpact, reason: string): void => {
    if (!u.why.includes(reason)) u.why.push(reason);
  };

  // References, by the unit each lies in. The declaring unit's own are not
  // "other units"; a test file's are the tests'.
  const testRefs: Array<{ ref: Ref; unit: string }> = [];
  for (const ref of input.references) {
    const u = input.unitOf[ref.uri];
    if (!u) continue;
    if (u.kind === "test") {
      testRefs.push({ ref, unit: u.name });
      continue;
    }
    if (u.name === input.declaringUnit) continue;
    const entry = unit(u.name, u.kind);
    why(entry, "mentions it");
    entry.rows.push(refRow(ref, u.name));
  }

  // Units that consume the declaring unit, and the handlers that call it.
  if (model && input.declaringUnit) {
    for (const e of model.edges) {
      if (e.to !== input.declaringUnit) continue;
      const kind = model.nodes.find((n) => n.name === e.from)?.kind === "Adapter" ? "adapter" : "context";
      why(unit(e.from, kind), `consumes ${input.declaringUnit}`);
    }
  }
  const service = model?.nodes.flatMap((n) => n.services.map((s) => ({ unit: n.name, name: s.name }))).find((s) => isName(s.name, name));
  if (model && service) {
    for (const n of model.nodes) {
      for (const h of n.uses ?? []) {
        if (!(h.calls ?? []).some((c) => c.kind === "service" && c.unit === service.unit && c.container === service.name)) continue;
        const entry = unit(h.member.unit, n.kind === "Adapter" ? "adapter" : "context");
        why(entry, `calls ${service.unit}.${service.name}`);
        entry.rows.push({ label: memberLabel(h.member), description: "calls it", loc: h.member.loc });
      }
    }
    if (model.nodes.some((n) => (n.uses ?? []).length > 0 && (n.uses ?? []).every((h) => h.calls === undefined))) {
      notes.push("This language server sends no calls between handlers (needs bynk v0.634.4), so callers of a service are found only by what they mention.");
    }
  }
  const units = [...byUnit.values()].sort((a, b) => a.unit.localeCompare(b.unit));

  // Events.
  let event: ImpactAnswer["event"];
  const found = model?.events?.find((e) => isName(`${e.owner}.${e.name}`, name));
  if (found) {
    event = {
      emitters: found.emitters.map((x) => ({ label: memberLabel(x.member), loc: x.member.loc })),
      subscribers: found.subscribers.map((x) => ({ label: memberLabel(x.member), description: x.delivery, loc: x.member.loc })),
    };
  }

  // The boundary.
  const carrying = input.wires.filter((w) => w.carries.request || w.carries.response);
  const wire: Row[] = carrying.map((w) => ({
    label: `${w.unit}.${w.service}: ${w.label}`,
    description: w.carries.request && w.carries.response ? "request and response" : w.carries.request ? "request" : "response",
    loc: w.loc,
  }));
  const changes: Row[] = (input.contract?.changes ?? [])
    .filter((c) => isName(c.name, name))
    .map((c) => ({ label: `${c.kind} ${c.unit}.${c.name}`, description: `${c.class}: ${c.detail}`, loc: c.loc }));
  const carriers = new Set(carrying.map((w) => `${w.unit}\0${w.service}`));
  const deployed: Row[] = (input.contract?.services ?? [])
    .filter((s) => carriers.has(`${s.context}\0${s.service}`))
    .map((s) => ({
      label: `${s.environment}: ${s.context}.${s.service}`,
      description: s.compat ? `${s.status}, ${s.compat.verdict}` : s.status,
      loc: s.loc,
    }));
  if (!input.contract) notes.push("The contract diff could not be read, so locks and deployed contracts are not shown.");

  // The generated client.
  const routes = input.client.configured
    ? carrying.filter((w) => w.boundary === "Http" && selected(input.client.services, w.unit, w.service))
    : [];

  // Tests: the cases holding a reference, else the test file.
  const tests: Row[] = [];
  for (const { ref, unit: suite } of testRefs) {
    const c = (input.testCases[ref.uri] ?? []).find((k) => contains(k.range, ref.range));
    tests.push({
      label: c ? `${suite}: ${c.name}` : `${suite}: ${lastSegment(ref.uri)}:${ref.range.start.line + 1}`,
      description: c ? undefined : "outside any case",
      loc: { uri: ref.uri, range: ref.range },
    });
  }
  tests.sort((a, b) => a.label.localeCompare(b.label));

  return {
    name,
    units,
    ...(event ? { event } : {}),
    boundary: { wire, changes, deployed },
    client: {
      configured: input.client.configured,
      routes: routes.map((w) => ({ label: `${w.unit}.${w.service}: ${w.label}`, loc: w.loc })),
    },
    tests,
    notes,
  };
}

function selected(services: readonly string[], unit: string, service: string): boolean {
  return services.length === 0 || services.some((s) => s === service || s === `${unit}.${service}`);
}
