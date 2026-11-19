// #225: hints that a value reaching a handler may be larger than the platform
// allows, from the wire contract (`bynk/wireContract`).
//
// Only a fact the model states is used, and only where a size-limited place is
// certain:
//
//   - a `Message` handler is a queue consumer: its message is a queue message,
//     which Cloudflare limits (`queueMessage`). A `Bytes`, a `List` or a `Map`
//     in it has no bound in its type, so the message *may* pass the limit.
//
// An HTTP handler's request body is not flagged: the platform refuses an
// oversized body before the Worker runs, whether the handler reads it raw or as
// JSON, so a hint would sit on every upload endpoint with nothing to act on.
//
// Not flagged, because the models do not say where the value goes: a value
// written to KV (the architecture model names a KV capability, not which value
// is written to it), stored in an agent (`bynk/agentStateModel` names a write's
// field, not its type), or emitted as an event. A bare `String` is not flagged
// either: every `String` is unbounded, and flagging each would flag them all.
// A `Bytes` bounded by a `MaxLength`/`Length` predicate on a named type is not
// flagged. When in doubt, no hint.

import { formatLimit, planName, type LimitId, type Plan } from "./platformLimitsCore";
import type { WcBody, WcModel, WcRef } from "./webview/wireContractTypes";

export type UnboundedKind = "Bytes" | "List" | "Map";

/** One place in a value whose type has no size bound. */
export interface Unbounded {
  /** `data`, `order.items`; empty when the value itself is the unbounded one. */
  path: string;
  kind: UnboundedKind;
  /** The type as the contract names it: `Bytes`, `List[Item]`. */
  type: string;
}

export interface PayloadHint {
  limit: LimitId;
  /** What the hint is about: the parameter for a queue message, `request body`. */
  subject: string;
  /** The unbounded places in the value, at most {@link MAX_SHOWN}. */
  unbounded: Unbounded[];
  /** One sentence, phrased as "may". */
  message: string;
}

/** How many places a message names; the rest are counted. */
export const MAX_SHOWN = 3;

const BOUNDING_PREDICATE = /^(MaxLength|Length|MaxSize|Size)\b/;

interface Index {
  types: Map<string, WcBody>;
  insts: Map<string, WcModel["instantiations"][number]>;
}

function index(model: WcModel): Index {
  return {
    types: new Map(model.types.map((t) => [t.name, t.body])),
    insts: new Map(model.instantiations.map((i) => [i.key, i])),
  };
}

function join(path: string, name: string): string {
  return path === "" ? name : `${path}.${name}`;
}

function refName(ref: WcRef, idx: Index): string {
  switch (ref.kind) {
    case "Base":
      return ref.base;
    case "Bytes":
      return "Bytes";
    case "Named":
      return ref.name;
    case "Inst": {
      const inst = idx.insts.get(ref.key);
      if (!inst) return ref.key;
      switch (inst.kind) {
        case "ListInst":
          return `List[${refName(inst.elem, idx)}]`;
        case "MapInst":
          return `Map[${refName(inst.mapKey, idx)}, ${refName(inst.val, idx)}]`;
        case "OptionInst":
          return `Option[${refName(inst.inner, idx)}]`;
        default:
          return ref.key;
      }
    }
    default:
      return "";
  }
}

/** The unbounded places reachable from `ref`: each once, with its path. `seen`
 *  guards a recursive type, which is walked once. */
function walk(ref: WcRef, path: string, idx: Index, seen: Set<string>, out: Unbounded[]): void {
  switch (ref.kind) {
    case "Bytes":
      out.push({ path, kind: "Bytes", type: "Bytes" });
      return;
    case "Base":
      if (ref.base === "Bytes") out.push({ path, kind: "Bytes", type: "Bytes" });
      return;
    case "Named": {
      if (seen.has(ref.name)) return;
      const body = idx.types.get(ref.name);
      if (!body) return;
      seen.add(ref.name);
      if (body.kind === "Scalar") {
        if (body.base === "Bytes" && !body.predicates.some((p) => BOUNDING_PREDICATE.test(p))) {
          out.push({ path, kind: "Bytes", type: ref.name });
        }
      } else if (body.kind === "Record") {
        for (const f of body.fields) walk(f.shape, join(path, f.name), idx, seen, out);
      } else {
        for (const v of body.variants) for (const f of v.payload) walk(f.shape, join(path, `${v.name}.${f.name}`), idx, seen, out);
      }
      seen.delete(ref.name);
      return;
    }
    case "Inst": {
      if (seen.has(ref.key)) return;
      const inst = idx.insts.get(ref.key);
      if (!inst) return;
      seen.add(ref.key);
      switch (inst.kind) {
        case "ListInst":
          out.push({ path, kind: "List", type: refName(ref, idx) });
          break;
        case "MapInst":
          out.push({ path, kind: "Map", type: refName(ref, idx) });
          break;
        case "OptionInst":
          walk(inst.inner, path, idx, seen, out);
          break;
        case "ResultInst":
          walk(inst.ok, path, idx, seen, out);
          walk(inst.err, path, idx, seen, out);
          break;
        case "RecordInst":
        case "SumInst":
          // A generic type's arguments: what the type does with them is not in the model.
          for (const a of inst.args) walk(a, path, idx, seen, out);
          break;
      }
      seen.delete(ref.key);
      return;
    }
    default:
      return;
  }
}

/** The unbounded places in what reaches a handler as `param`. */
export function unboundedIn(ref: WcRef, path: string, model: WcModel): Unbounded[] {
  const out: Unbounded[] = [];
  walk(ref, path, index(model), new Set(), out);
  return out;
}

function describe(found: Unbounded[]): string {
  const shown = found.slice(0, MAX_SHOWN).map((u) => (u.path === "" ? `a \`${u.type}\`` : `\`${u.path}\` (\`${u.type}\`)`));
  const more = found.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

/** The hints for one handler on `plan`: none when nothing is certain. */
export function payloadHints(model: WcModel, plan: Plan): PayloadHint[] {
  const hints: PayloadHint[] = [];
  const env = model.envelope;
  if (model.kind.kind === "Message") {
    const found: Unbounded[] = [];
    const idx = index(model);
    if (env.kind === "Bare") walk(env.shape, "", idx, new Set(), found);
    else if (env.kind === "Keyed") for (const p of env.params) walk(p.shape, p.name, idx, new Set(), found);
    else if (env.kind === "Raw") found.push({ path: "", kind: "Bytes", type: "Bytes" });
    if (found.length > 0) {
      hints.push({
        limit: "queueMessage",
        subject: env.kind === "Bare" ? env.param : "message",
        unbounded: found.slice(0, MAX_SHOWN),
        message: `This message may be larger than a queue allows: it holds ${describe(found)}, which the type does not bound. Cloudflare Queues limit a message to ${formatLimit("queueMessage", plan)} on the ${planName(plan)}.`,
      });
    }
  }
  return hints;
}
