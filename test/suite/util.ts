const POLL_MS = 250;
const TIMEOUT_MS = 60_000;

/** The value rendered for a timeout message, tolerant of cycles and size. */
function show(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(v);
  }
}

/** For `waitFor` callers whose `fn` already answers with a boolean. */
export const truthy = (v: unknown): boolean => !!v;

/** For `waitFor` callers that want a value: not undefined, and not an empty array. */
export const present = <T>(v: T | undefined): v is T => v !== undefined && !(Array.isArray(v) && v.length === 0);

/** Poll `fn` until `ok` accepts its value, or fail after `timeoutMs` naming
 *  `what` and the last value seen. The defaults suit the slowest waits (server
 *  analysis, the fake driver's processes), so a test only passes a timeout to
 *  go longer. */
export async function waitFor<T, U extends T>(
  fn: () => Thenable<T> | T,
  ok: (v: T) => v is U,
  what: string,
  timeoutMs?: number,
): Promise<U>;
export async function waitFor<T>(
  fn: () => Thenable<T> | T,
  ok: (v: T) => boolean,
  what: string,
  timeoutMs?: number,
): Promise<T>;
export async function waitFor<T>(
  fn: () => Thenable<T> | T,
  ok: (v: T) => boolean,
  what: string,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; last value: ${show(v)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
