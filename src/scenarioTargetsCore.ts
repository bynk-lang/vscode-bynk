// #159: running a request scenario against a `[test.targets]` target. A
// dependency-free companion to `scenarioCore.ts` (no `vscode` import), so the
// unit tests compile against it directly.
//
// `bynk test --against` only ever receives a target *name*, and the driver reads
// the manifest. A scenario is sent by the extension itself, so it has to read the
// parts of the target it needs: each worker's base URL, the `production` flag and
// the names (never values) of the secrets. The rules it keeps from the driver:
//   - a target is a name from `[test.targets]`, never a URL typed in;
//   - a secret's value is read from the environment, never from a file;
//   - what a target does not serve is reported, not guessed.

import { isProductionEnvironment } from "./migrationsCore";
import { isSensitiveHeader, findRefs, type Step } from "./scenarioCore";

/** One `[test.targets.<name>]` table. */
export interface TestTarget {
  name: string;
  /** Each worker's base URL, keyed by its worker-directory name. */
  urls: Record<string, string>;
  /** The names of the environment variables the deployed Workers verify with. */
  secrets: string[];
  /** `production = true`. */
  production: boolean;
}

/** The part of a TOML value this scan reads: a string, a boolean, an array of
 *  strings or an inline table of strings. */
type Value = string | boolean | string[] | Record<string, string>;

/** `line` without a trailing `# comment` (a `#` inside a string stays). */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

const STRING = /"((?:[^"\\]|\\.)*)"|'([^']*)'/y;

function unquote(m: RegExpExecArray): string {
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? "");
}

/** The strings in `src`, in order. */
function strings(src: string): string[] {
  const out: string[] = [];
  STRING.lastIndex = 0;
  for (let at = 0; at < src.length; ) {
    STRING.lastIndex = at;
    const m = STRING.exec(src);
    if (m) {
      out.push(unquote(m));
      at = STRING.lastIndex;
    } else at++;
  }
  return out;
}

function parseValue(src: string): Value | undefined {
  const text = src.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  const one = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(text);
  if (one) return one[1] !== undefined ? one[1].replace(/\\(.)/g, "$1") : one[2];
  if (text.startsWith("[") && text.endsWith("]")) return strings(text.slice(1, -1));
  if (text.startsWith("{") && text.endsWith("}")) {
    const table: Record<string, string> = {};
    for (const m of text.slice(1, -1).matchAll(/(?:^|,)\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g)) {
      table[m[1] ?? m[2] ?? m[3]] = m[4] !== undefined ? m[4].replace(/\\(.)/g, "$1") : m[5];
    }
    return table;
  }
  return undefined;
}

/** A dotted key (`url.shop-orders`, `url."shop-orders"`) as its parts. */
function keyParts(src: string): string[] | undefined {
  const parts: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let at = 0;
  while (at < src.length) {
    re.lastIndex = at;
    const m = re.exec(src);
    if (!m) return undefined;
    parts.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
    at = re.lastIndex;
    if (m[4] === "") break;
  }
  return parts.length > 0 ? parts : undefined;
}

const HEADER = /^\[\s*(.*?)\s*\]$/;

/** The `[test.targets.<name>]` tables of a `bynk.toml`, in file order. A scan,
 *  not a TOML parse: it takes the table form the manifest documents (including
 *  `url.<worker> = …`, `url = { … }` and a `[test.targets.<name>.url]` table)
 *  and misses the dotted `[test]` form, which the driver still accepts when a
 *  name is typed (that target then reads as undeclared here). */
export function parseTargets(toml: string): TestTarget[] {
  const targets = new Map<string, TestTarget>();
  let current: TestTarget | undefined;
  /** Inside `[test.targets.<name>.url]`. */
  let inUrl = false;
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]).trim();
    if (line === "") continue;
    const header = HEADER.exec(line);
    if (header && !line.startsWith("[[")) {
      current = undefined;
      inUrl = false;
      const parts = keyParts(header[1]);
      if (parts && parts.length >= 3 && parts[0] === "test" && parts[1] === "targets" && parts.length <= 4 && (parts.length === 3 || parts[3] === "url")) {
        const name = parts[2];
        current = targets.get(name) ?? { name, urls: {}, secrets: [], production: false };
        targets.set(name, current);
        inUrl = parts.length === 4;
      }
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    // A multi-line array: take lines until the bracket closes.
    let rest = line.slice(eq + 1);
    if (rest.trim().startsWith("[") && !rest.includes("]")) {
      while (i + 1 < lines.length && !rest.includes("]")) rest += " " + stripComment(lines[++i]).trim();
    }
    line = line.slice(0, eq);
    const key = keyParts(line.trim());
    const value = parseValue(rest);
    if (!key || value === undefined) continue;
    if (inUrl && key.length === 1 && typeof value === "string") current.urls[key[0]] = value;
    else if (key.length === 2 && key[0] === "url" && typeof value === "string") current.urls[key[1]] = value;
    else if (key.length === 1 && key[0] === "url" && typeof value === "object" && !Array.isArray(value)) Object.assign(current.urls, value);
    else if (key.length === 1 && key[0] === "production" && typeof value === "boolean") current.production = value;
    else if (key.length === 1 && key[0] === "secrets" && Array.isArray(value)) current.secrets = value;
  }
  return [...targets.values()];
}

/** The worker-directory name a context's unit deploys as: `shop.orders` is
 *  `shop-orders`. */
export function workerName(unit: string): string {
  return unit.replace(/\./g, "-");
}

export type BaseUrl = { base: string } | { error: string };

/** Where the target serves a context's unit, or why it does not. A URL that
 *  carries credentials, or is not http(s), is refused: the file is not where a
 *  credential lives. */
export function targetBase(target: TestTarget, unit: string): BaseUrl {
  const worker = workerName(unit);
  const url = target.urls[worker];
  if (url === undefined) {
    const served = Object.keys(target.urls);
    return {
      error: `The target \`${target.name}\` has no URL for \`${worker}\` (the worker serving ${unit})${served.length > 0 ? `; it serves ${served.map((s) => `\`${s}\``).join(", ")}` : ""}.`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `The target \`${target.name}\`'s URL for \`${worker}\` isn't a URL.` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `The target \`${target.name}\`'s URL for \`${worker}\` must be http or https.` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { error: `The target \`${target.name}\`'s URL for \`${worker}\` carries credentials. Credentials come from the environment (\`{{env.NAME}}\`), not bynk.toml.` };
  }
  return { base: url.replace(/\/+$/, "") };
}

/** Whether a method can change state on the server. */
export function isNonIdempotent(method: string): boolean {
  return /^(POST|PUT|PATCH|DELETE)$/i.test(method);
}

/** Why a target is refused outright, or `undefined`. A target marked
 *  `production = true` is one the project author declared test traffic must not
 *  reach: the driver refuses it for `bynk test --against`, and a scenario sends
 *  real writes, so it is refused here with the same reason. No confirmation
 *  overrides it; allowing production is a change to the shared policy. */
export function refusedReason(target: Pick<TestTarget, "name" | "production">): string | undefined {
  return target.production
    ? `\`${target.name}\` is marked \`production = true\` in [test.targets], and a target marked production is refused: test traffic must not reach it. Scenarios send real requests, so they follow the same rule as \`bynk test --against\`.`
    : undefined;
}

/** Whether a target is only *named* like production (`prod`, `production`,
 *  `live`, `default`: the names the migration sweep treats as production). A
 *  heuristic on top of the flag, so it asks rather than refuses. */
export function isProductionLike(target: Pick<TestTarget, "name">): boolean {
  return isProductionEnvironment(target.name);
}

/** Whether a target is somewhere other than the local dev server. Every
 *  `[test.targets]` entry is; `dev` is not an entry. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** The steps of a run that send a non-idempotent request, by name and request. */
export function writeSteps(steps: readonly Step[], only?: ReadonlySet<string>): Step[] {
  return steps.filter((s) => (!only || only.has(s.name)) && isNonIdempotent(s.method));
}

/** What to ask before a run against a target, or `undefined` when the run
 *  needs no question (it never leaves the machine). A target is a deployment,
 *  so a run is confirmed. A target that reads as production, with a write in
 *  the run, asks for the target's name to be typed instead. */
export interface RunConfirmation {
  kind: "confirm" | "typed";
  /** The message. */
  message: string;
  /** For `typed`: what to type. */
  phrase?: string;
  /** The label of the confirming button, for `confirm`. */
  action?: string;
}

export function confirmationFor(
  target: TestTarget,
  stepsToRun: readonly Step[],
  writes: readonly Step[],
  hosts: readonly string[],
): RunConfirmation | undefined {
  // Nothing is sent when no step has a URL: each is reported instead.
  if (hosts.length === 0) return undefined;
  // A target on this machine that is not named like production asks nothing.
  if (hosts.length > 0 && hosts.every(isLocalUrl) && !isProductionLike(target)) return undefined;
  const where = hosts.length > 0 ? ` (${hosts.join(", ")})` : "";
  if (isProductionLike(target) && writes.length > 0) {
    const list = writes.map((s) => `${s.method} ${s.path}`).join(", ");
    return {
      kind: "typed",
      phrase: target.name,
      message: `\`${target.name}\` reads as production${where}. This run sends ${writes.length === 1 ? "a request" : `${writes.length} requests`} that can change data: ${list}. Type "${target.name}" to continue.`,
    };
  }
  const reads = `${stepsToRun.length} step${stepsToRun.length === 1 ? "" : "s"}`;
  return {
    kind: "confirm",
    action: "Run",
    message: `Run ${reads} against \`${target.name}\`${where}? A deployed target keeps its state between runs.${isProductionLike(target) ? " It reads as production." : ""}`,
  };
}

/** A credential header written into the file. Against a deployed target the
 *  file is no place for one: it has to read `{{env.NAME}}`. */
export function literalCredential(step: Step): string | undefined {
  for (const h of step.headers) {
    if (isSensitiveHeader(h.name) && findRefs(h.value).length === 0 && h.value.trim() !== "") return h.name;
  }
  return undefined;
}

/** What to say for a step whose credential header is a literal. */
export function literalCredentialMessage(header: string, target: string): string {
  return `The ${header} header holds a literal credential. Against \`${target}\` credentials come from the environment: write it as \`{{env.NAME}}\`.`;
}
