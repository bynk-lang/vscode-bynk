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
  "getComputedStyle",
] as const;

const WEBVIEW_DIR = path.join(__dirname, "../../src/webview");

/** What a stubbed `mermaid.render` is asked for, and what it answers. */
export interface MermaidStub {
  calls: Array<{ id: string; text: string }>;
  /** The SVG markup `render` resolves to; set `fail` to make it reject. */
  svg: string;
  fail?: Error;
}

export interface Dom {
  window: Window & typeof globalThis & Record<string, unknown>;
  document: Document;
  root: HTMLElement;
  /** Everything the page handed `postMessage`, in order. */
  posted: unknown[];
  /** Everything the page handed `setState`, in order. */
  states: unknown[];
  mermaid: MermaidStub;
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

  // The real Mermaid lays out SVG, which jsdom can't; the views' own wiring
  // (what they feed it, how they hook up what comes back) is what's tested.
  const mermaid: MermaidStub = { calls: [], svg: "" };
  const stubKey = require.resolve("mermaid");
  const hadStub = Object.getOwnPropertyDescriptor(require.cache, stubKey);
  require.cache[stubKey] = {
    id: stubKey,
    filename: stubKey,
    loaded: true,
    exports: {
      __esModule: true,
      default: {
        initialize: () => undefined,
        render: async (id: string, text: string) => {
          mermaid.calls.push({ id, text });
          if (mermaid.fail) throw mermaid.fail;
          return { svg: mermaid.svg };
        },
      },
    },
  } as unknown as NodeJS.Module;

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
    mermaid,
    load<T>(name: string): T {
      dropWebviewModules();
      return require(path.join(WEBVIEW_DIR, name)) as T;
    },
    post(data: unknown): void {
      win.dispatchEvent(new win.MessageEvent("message", { data }));
    },
    dispose(): void {
      dropWebviewModules();
      if (hadStub) Object.defineProperty(require.cache, stubKey, hadStub);
      else delete require.cache[stubKey];
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
