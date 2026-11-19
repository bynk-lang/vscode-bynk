// #225: the Cloudflare Workers platform limits the extension warns about, in
// one place, each with the Cloudflare documentation page it comes from.
// Dependency-free: no `vscode` import, and nothing from another module, so the
// request-trace note, the payload hints and the tests all read the same table.
//
// The values are Cloudflare's, as documented; they change, and a plan can be
// raised on request, so what is shown is a documented default, not a promise.
// `limit` below is a number in the unit named (`count`, `ms` or `bytes`), or
// `null` where Cloudflare documents no fixed limit. Sizes are Cloudflare's
// "KB" and "MB", read as 1024-based, the stricter reading.
//
// When a value here is out of date, change it here only: every message is built
// from the table, so none carries a number of its own.

/** The Workers account plan: which column of the table applies. */
export type Plan = "free" | "paid";

export const PLANS: readonly Plan[] = ["free", "paid"];
export const DEFAULT_PLAN: Plan = "free";

export type LimitUnit = "count" | "ms" | "bytes";

export type LimitId =
  | "subrequests"
  | "cpuTime"
  | "kvValue"
  | "queueMessage"
  | "durableObjectValue"
  | "requestBody"
  | "responseBody";

export interface PlatformLimit {
  id: LimitId;
  /** What is limited, for a sentence: `CPU time per request`. */
  label: string;
  unit: LimitUnit;
  free: number | null;
  paid: number | null;
  /** The Cloudflare documentation page the values are taken from. */
  source: string;
  /** What the number does not say. */
  note: string;
}

const KB = 1024;
const MB = 1024 * 1024;

export const PLATFORM_LIMITS: readonly PlatformLimit[] = [
  {
    id: "subrequests",
    label: "subrequests per invocation",
    unit: "count",
    free: 50,
    paid: 10_000,
    source: "https://developers.cloudflare.com/workers/platform/limits/#subrequests",
    note: "Every capability, service and agent call is a subrequest. Free is 50. Paid is 10,000 by default, configurable up to 10,000,000 with the `subrequests` setting in the Wrangler config.",
  },
  {
    id: "cpuTime",
    label: "CPU time per request",
    unit: "ms",
    free: 10,
    paid: 30_000,
    source: "https://developers.cloudflare.com/workers/platform/limits/#cpu-time",
    note: "CPU time, not wall-clock time: time spent waiting on a call is not counted. The paid figure is the default, configurable up to 5 minutes.",
  },
  {
    id: "kvValue",
    label: "KV value size",
    unit: "bytes",
    free: 25 * MB,
    paid: 25 * MB,
    source: "https://developers.cloudflare.com/kv/platform/limits/",
    note: "The same on both plans.",
  },
  {
    id: "queueMessage",
    label: "queue message size",
    unit: "bytes",
    free: 128 * KB,
    paid: 128 * KB,
    source: "https://developers.cloudflare.com/queues/platform/limits/",
    note: "The same on both plans.",
  },
  {
    id: "durableObjectValue",
    label: "Durable Object storage value size",
    unit: "bytes",
    free: 8 * MB,
    paid: 8 * MB,
    source: "https://developers.cloudflare.com/durable-objects/platform/limits/",
    note: "Bynk's agents are SQLite-backed: 8 MB for a key and its value combined (also the maximum row, string and BLOB size). The legacy key-value-backed classes allow only 128 KiB per value (2 KiB per key).",
  },
  {
    id: "requestBody",
    label: "request body size",
    unit: "bytes",
    free: 100 * MB,
    paid: 100 * MB,
    source: "https://developers.cloudflare.com/workers/platform/limits/#request-limits",
    note: "Set by the zone's plan, not the Workers plan; 100 MB is the Free and Pro figure.",
  },
  {
    id: "responseBody",
    label: "response body size",
    unit: "bytes",
    free: null,
    paid: null,
    source: "https://developers.cloudflare.com/workers/platform/limits/#response-limits",
    note: "No fixed limit is documented for a response; a body that is buffered is held in the Worker's memory.",
  },
];

export function isPlan(value: unknown): value is Plan {
  return value === "free" || value === "paid";
}

/** A plan from a setting's value; anything else is the default (the lower limits). */
export function toPlan(value: unknown): Plan {
  return isPlan(value) ? value : DEFAULT_PLAN;
}

export function limitInfo(id: LimitId): PlatformLimit {
  const found = PLATFORM_LIMITS.find((l) => l.id === id);
  if (!found) throw new Error(`unknown platform limit: ${id}`);
  return found;
}

/** The value of one limit on a plan: `null` where there is no fixed limit. */
export function limitOf(id: LimitId, plan: Plan): number | null {
  return limitInfo(id)[plan];
}

/** A limit's value as Cloudflare writes it: `50`, `10 ms`, `30 s`, `128 KB`. */
export function formatLimit(id: LimitId, plan: Plan): string {
  const info = limitInfo(id);
  const value = info[plan];
  if (value === null) return "no fixed limit";
  switch (info.unit) {
    case "count":
      return value.toLocaleString("en-GB");
    case "ms":
      return value >= 1000 && value % 1000 === 0 ? `${value / 1000} s` : `${value} ms`;
    case "bytes":
      if (value >= MB && value % MB === 0) return `${value / MB} MB`;
      if (value >= KB && value % KB === 0) return `${value / KB} KB`;
      return `${value} bytes`;
  }
}

/** `free plan` / `paid plan`, as a sentence says it. */
export function planName(plan: Plan): string {
  return `${plan} plan`;
}
