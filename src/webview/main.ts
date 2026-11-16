// @webview-entry webview
// #846: the sequence-diagram webview's own bundle entry (`out/webview.js`,
// a separate esbuild target from the extension host's `out/extension.js` —
// see scripts/build.mjs). Runs inside the webview's browser context, never the
// extension host: no `vscode` module, only `acquireVsCodeApi()`.
//
// Reads the `SequencePayload` the extension host embeds as
// `window.__BYNK_SEQUENCE_MODEL__` and draws it with the first-party diagram
// engine (`src/diagram/`, model-diagrams slice 1) in UML notation. Every drawn
// element carries its model identity, so click-to-code is a lookup by id.
// Colours are CSS over `--vscode-*`, so a theme switch needs no redraw.
//
// Slice 2 adds the reading aids:
// - the drawing sits in a viewport (`diagram/viewport.ts`): lifeline heads
//   pinned while the body scrolls, zoom, drag to pan, and a minimap;
// - fragments fold (the toggle on a fragment's tab, or Space on it); deeply
//   nested ones start folded, and folds are kept across live updates;
// - the editor's cursor marks the element it is in (the host posts
//   `{type: "cursor"}`), and hovering or focusing an element marks its source
//   in the editor (`{type: "highlight"}` to the host);
// - Copy as Mermaid, and Save as SVG or PNG (the host shows the save dialog).

import { focusedRef, initTabOrder, restoreFocus, wireInteraction } from "../diagram/interact";
import { canvasMeasurer, type TextMeasurer } from "../diagram/measure";
import { elementAt, renderSequence, type SequenceRender } from "../diagram/sequence/render";
import { ensureDiagramStyles } from "../diagram/style";
import { buildToolbar } from "../diagram/toolbar";
import { DiagramViewport } from "../diagram/viewport";
import { type LiveView, startLiveView, type VsCodeApi } from "./live";
import { toMermaid } from "./mermaid-gen";
import type { Position, Range, RevealMessage, SequencePayload } from "./types";

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

/** The workbench font, which the page's text is drawn in. */
function fontFamily(): string {
  const value = getComputedStyle(document.body).getPropertyValue("--vscode-font-family").trim();
  return value || "sans-serif";
}

let measurer: { font: string; measure: TextMeasurer } | undefined;

function measurerFor(font: string): TextMeasurer {
  if (measurer?.font !== font) measurer = { font, measure: canvasMeasurer(font) };
  return measurer.measure;
}

// -- Page state, kept across live updates. --

let live: LiveView | undefined;
let payload: SequencePayload | null = null;
let current: SequenceRender | undefined;
/** The reader's folds (fragment id → folded), over the default folds. */
const overrides = new Map<string, boolean>();
/** Which handler the folds belong to: they reset when the view retargets. */
let modelKey: string | undefined;
let cursor: { uri: string; position: Position } | undefined;
/** Source ranges by IR id for the current drawing, refilled on each render. */
const ranges = new Map<string, Range>();

const viewport = new DiagramViewport(document);
const actionsBar = buildActions();
let wired = false;

function post(message: unknown): void {
  vscodeApi.postMessage(message);
}

function reveal(range: Range): void {
  if (!payload) return;
  const message: RevealMessage = { type: "reveal", uri: payload.uri, range };
  post(message);
}

function buildActions(): HTMLElement {
  return buildToolbar({
    viewport,
    post,
    mermaid: () => (payload ? toMermaid(payload.model).text : null),
    drawing: () => (current ? { drawing: current.drawing, name: fileName() } : null),
    fontFamily,
  });
}

/** The diagram's file name: the handler's entry lifeline. */
function fileName(): string {
  const entry = current?.diagram.lifelines.find((l) => l.kind === "entry")?.name ?? "sequence";
  return entry.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "sequence";
}

function toggleFold(id: string): void {
  if (!current) return;
  overrides.set(id, !current.folded.has(id));
  live?.rerender();
}

/** Mark the element the editor's cursor is in; scroll to it when `scroll`. */
function markCursor(scroll: boolean): void {
  for (const el of viewport.element.querySelectorAll(".bynk-current")) el.classList.remove("bynk-current");
  if (!current || !payload || !cursor || cursor.uri !== payload.uri) return;
  const id = elementAt(current.ranges, current.hidden, cursor.position);
  if (!id) return;
  const el = viewport.element.querySelector(`[data-bynk-ref="${id}"]`);
  if (!el) return;
  el.classList.add("bynk-current");
  if (scroll) viewport.reveal(el);
}

function render(root: HTMLElement, next: SequencePayload | null): void {
  payload = next;
  if (!next) {
    current = undefined;
    root.textContent = "No sequence model to render.";
    post({ type: "highlight", uri: "", range: null });
    return;
  }
  ensureDiagramStyles(document);

  const entry = next.model.participants.find((p) => p.kind === "Entry")?.name ?? "";
  const key = `${next.uri}#${entry}`;
  const retargeted = key !== modelKey;
  if (retargeted) {
    modelKey = key;
    overrides.clear();
  }

  const keep = focusedRef(viewport.element);
  const font = fontFamily();
  let result: SequenceRender;
  try {
    result = renderSequence(next.model, { measure: measurerFor(font), fontFamily: font, overrides });
  } catch (err) {
    current = undefined;
    root.textContent = `Failed to render diagram: ${String(err)}`;
    return;
  }
  current = result;
  ranges.clear();
  for (const [id, r] of result.ranges) ranges.set(id, r);

  if (actionsBar.parentElement !== root || viewport.element.parentElement !== root) {
    root.replaceChildren(actionsBar, viewport.element);
    document.body.appendChild(viewport.minimapElement);
  }
  if (!wired) {
    wired = true;
    wireInteraction(viewport.element, ranges, {
      reveal,
      toggleFold,
      hover: (range) => post({ type: "highlight", uri: payload?.uri ?? "", range }),
      // Model-diagrams slice 3: a `ref` link opens the callee's own diagram.
      open: (id) => {
        const to = current?.callees.get(id);
        if (to) post({ type: "openSequence", uri: to.uri, range: to.range });
      },
    });
  }
  viewport.show(result.drawing);
  if (retargeted) {
    viewport.element.scrollTop = 0;
    viewport.element.scrollLeft = 0;
  }
  initTabOrder(viewport.element);
  restoreFocus(viewport.element, keep);
  markCursor(false);
  reportWiring(next);
}

/** Test seam (#852): when the host sets `window.__BYNK_SEQUENCE_DEBUG__`, post
 *  back the name drawn on each participant's element, found by its id. The
 *  extension-host integration test cannot reach the webview's DOM, so this is
 *  how it checks that each participant's element really is that participant.
 *  No-op in production: only the test sets the flag. */
function reportWiring(p: SequencePayload): void {
  if (!(window as unknown as { __BYNK_SEQUENCE_DEBUG__?: boolean }).__BYNK_SEQUENCE_DEBUG__) return;
  post({
    type: "wiring",
    participants: p.model.participants.map((part) => ({
      name: part.name,
      label: viewport.element.querySelector(`[data-bynk-ref="p${part.id}"] .bynk-name`)?.textContent?.trim() ?? null,
    })),
  });
}

function isPosition(v: unknown): v is Position {
  const p = v as { line?: unknown; character?: unknown } | null;
  return Number.isInteger(p?.line) && Number.isInteger(p?.character);
}

window.addEventListener("message", (event: MessageEvent<{ type?: unknown; uri?: unknown; position?: unknown }>) => {
  const m = event.data;
  if (m?.type !== "cursor" || typeof m.uri !== "string" || !isPosition(m.position)) return;
  cursor = { uri: m.uri, position: m.position };
  markCursor(true);
});

live = startLiveView<SequencePayload>(vscodeApi, "__BYNK_SEQUENCE_MODEL__", render);
