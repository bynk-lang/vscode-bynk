// A jsdom page for the webview renderer tests (#45). Not a `*.test.ts`, so the
// extension-host runner doesn't take it for a spec.
//
// The renderers read `document`/`window` as globals, and the bundle entries
// (`docview`, `state`, `architecture`, `refinedExplorer`) run on import: they
// call `acquireVsCodeApi()` and read their payload off `window`. `setupDom`
// installs those globals, and `load` requires a compiled entry afresh so each
// test gets its own module state. Call `dispose` in `afterEach`: the globals
// must not leak into the pure tests sharing the Mocha process.

import * as path from "path";

import { JSDOM } from "jsdom";

const GLOBALS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLDetailsElement",
  "MessageEvent",
  "MutationObserver",
  "getComputedStyle",
] as const;

const WEBVIEW_DIR = path.join(__dirname, "../../src/webview");

export interface Dom {
  window: Window & typeof globalThis & Record<string, unknown>;
  document: Document;
  root: HTMLElement;
  /** Everything the page handed `postMessage`, in order. */
  posted: unknown[];
  /** Everything the page handed `setState`, in order. */
  states: unknown[];
  /** Require `src/webview/<name>` afresh against this page. */
  load<T = Record<string, unknown>>(name: string): T;
  /** Deliver a host message to the page, as the webview host would. */
  post(data: unknown): void;
  dispose(): void;
}

/** A page with `#bynk-toolbar` and `#root`, and `globals` set on its window. */
export function setupDom(globals: Record<string, unknown> = {}): Dom {
  const jsdom = new JSDOM('<!doctype html><body><div id="bynk-toolbar"></div><div id="root"></div></body>');
  const win = jsdom.window as unknown as Dom["window"];
  // jsdom has no canvas, and says so on every `getContext` call. The diagram
  // engine's text measurer (`src/diagram/measure.ts`) falls back to fixed
  // widths when there is no context, so answer `null` quietly.
  (win as unknown as { HTMLCanvasElement: { prototype: { getContext: () => null } } }).HTMLCanvasElement.prototype.getContext = () => null;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown): void => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  for (const name of GLOBALS) install(name, name === "document" ? win.document : (win as never)[name]);
  Object.assign(win, globals);

  const posted: unknown[] = [];
  const states: unknown[] = [];
  install("acquireVsCodeApi", () => ({
    postMessage: (m: unknown) => void posted.push(m),
    setState: (s: unknown) => void states.push(s),
  }));

  const dropWebviewModules = (): void => {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(WEBVIEW_DIR)) delete require.cache[key];
    }
  };

  return {
    window: win,
    document: win.document,
    root: win.document.getElementById("root") as HTMLElement,
    posted,
    states,
    load<T>(name: string): T {
      dropWebviewModules();
      return require(path.join(WEBVIEW_DIR, name)) as T;
    },
    post(data: unknown): void {
      win.dispatchEvent(new win.MessageEvent("message", { data }));
    },
    dispose(): void {
      dropWebviewModules();
      for (const [name, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, name, desc);
        else delete (globalThis as Record<string, unknown>)[name];
      }
      win.close();
    },
  };
}

/** Let queued renders and promise callbacks run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Markup that must reach the page as text. */
export const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
