// @webview-entry timing
// #218: the request timing diagram's bundle entry (`out/timing.js`). Runs in the
// webview's browser context: no `vscode` module, only `acquireVsCodeApi()`.
//
// Draws the `TimingPayload` the host embeds as `window.__BYNK_TIMING__` with the
// diagram engine (`diagram/timing/`), in the shared viewport (zoom, pan, a
// minimap) with the shared toolbar: Copy as Mermaid (a `gantt` chart), Save as
// SVG or PNG. Hover marks a bar's call site in the editor and click opens it,
// by identity through the engine's interaction layer. The host posts
// `{type: "timing", payload}` to show another request in the same page.
// Colours are CSS over `--vscode-*`, so a theme switch needs no redraw.

import { focusedRef, initTabOrder, restoreFocus, wireInteraction } from "../diagram/interact";
import { canvasMeasurer, type TextMeasurer } from "../diagram/measure";
import { ensureDiagramStyles } from "../diagram/style";
import { renderTiming, type TimingRender } from "../diagram/timing/render";
import { buildToolbar } from "../diagram/toolbar";
import { DiagramViewport } from "../diagram/viewport";
import { CRITICAL_NOTE, TIMING_NOTE, toMermaidGantt } from "../requestTimingCore";
import { formatMs, type TraceLocation } from "../requestTraceCore";
import type { TimingPayload, TimingUpdate } from "./timingTypes";

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

let current: TimingRender | undefined;
const locations = new Map<string, TraceLocation>();

function fontFamily(): string {
  const value = getComputedStyle(document.body).getPropertyValue("--vscode-font-family").trim();
  return value || "sans-serif";
}

let measurer: { font: string; measure: TextMeasurer } | undefined;
function measurerFor(font: string): TextMeasurer {
  if (measurer?.font !== font) measurer = { font, measure: canvasMeasurer(font) };
  return measurer.measure;
}

const viewport = new DiagramViewport(document);
const actionsBar = buildToolbar({
  viewport,
  post: (m) => vscodeApi.postMessage(m),
  mermaid: () => (current ? toMermaidGantt(current.timeline, current.comparison) : null),
  drawing: () => (current ? { drawing: current.drawing, name: `timing-${current.timeline.requestId}` } : null),
  fontFamily,
});
const pickerBar = document.createElement("div");
pickerBar.className = "bynk-diagram-actions bynk-timing-bar";
const legend = document.createElement("section");
legend.className = "bynk-timing-legend";
legend.setAttribute("aria-label", "Legend");
let wired = false;

function option(value: string, text: string, selected: boolean): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  o.selected = selected;
  return o;
}

/** Which request, and which to compare it with: the traces of this route. */
function renderPicker(p: TimingPayload): void {
  pickerBar.replaceChildren();
  const choose = (id: string, compareId: string | undefined): void => {
    vscodeApi.postMessage({ type: "showTiming", id, ...(compareId ? { compareId } : {}) });
  };
  const id = p.source.trace.id;
  const compareId = p.compare?.trace.id;
  const pick = document.createElement("label");
  pick.append("Request ");
  const select = document.createElement("select");
  select.id = "bynk-timing-select";
  select.setAttribute("aria-label", "Request");
  for (const c of p.choices) select.append(option(c.id, c.label, c.id === id));
  select.addEventListener("change", () => choose(select.value, undefined));
  pick.append(select);
  pickerBar.append(pick);
  if (p.choices.length > 1) {
    const cmp = document.createElement("label");
    cmp.append("Compare with ");
    const other = document.createElement("select");
    other.id = "bynk-timing-compare";
    other.setAttribute("aria-label", "Compare with another request of this route");
    other.append(option("", "—", compareId === undefined));
    for (const c of p.choices) if (c.id !== id) other.append(option(c.id, c.label, c.id === compareId));
    other.addEventListener("change", () => choose(id, other.value === "" ? undefined : other.value));
    cmp.append(other);
    pickerBar.append(cmp);
  }
}

function para(text: string, cls?: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  if (cls) p.className = cls;
  return p;
}

/** The legend: what the colours mean, and, always, what the timing does not say. */
function renderLegend(r: TimingRender): void {
  legend.replaceChildren();
  const t = r.timeline;
  const note = para(TIMING_NOTE, "bynk-timing-note");
  note.title = "A step's duration is reported, not its start. A start time per step is proposed in bynk-lang/bynk#3787.";
  legend.append(note);
  const key = document.createElement("p");
  key.className = "bynk-timing-key";
  for (const [cls, text] of [
    ["bynk-key-fault", "red: failed"],
    ["bynk-key-pending", "amber, dashed: still pending"],
    ["bynk-key-critical", "outlined: critical path"],
  ]) {
    const span = document.createElement("span");
    span.className = `bynk-key ${cls}`;
    span.textContent = text;
    key.append(span, " ");
  }
  legend.append(key, para(CRITICAL_NOTE, "bynk-timing-note"));
  if (r.comparison) {
    const d = r.comparison.totalDelta;
    legend.append(
      para(
        `B against A: ${d === 0 ? "the same duration" : `${d > 0 ? "+" : "−"}${formatMs(Math.abs(d))}`}. Dashed bars are steps only one request took; a delta is shown on B's own steps that A also took.`,
        "bynk-timing-note",
      ),
    );
  }
  if (t.unjoined > 0) {
    legend.append(para(`${t.unjoined} call${t.unjoined === 1 ? "" : "s"} to another Worker could not be expanded: that Worker's own trace was not seen.`, "bynk-timing-note"));
  }
  if (t.truncated) legend.append(para("More steps happened than the trace keeps (the first 200 are shown).", "bynk-timing-note"));
}

function render(root: HTMLElement, next: TimingPayload): void {
  ensureDiagramStyles(document);
  const keep = focusedRef(viewport.element);
  const font = fontFamily();
  try {
    current = renderTiming(next.source, next.compare, { measure: measurerFor(font), fontFamily: font });
  } catch (err) {
    current = undefined;
    root.textContent = `Failed to render diagram: ${String(err)}`;
    return;
  }
  locations.clear();
  for (const [id, loc] of current.locations) locations.set(id, loc);
  renderPicker(next);
  renderLegend(current);
  if (actionsBar.parentElement !== root || viewport.element.parentElement !== root) {
    root.replaceChildren(pickerBar, actionsBar, viewport.element, legend);
    document.body.appendChild(viewport.minimapElement);
  }
  if (!wired) {
    wired = true;
    wireInteraction<TraceLocation>(viewport.element, locations, {
      reveal: (loc) => vscodeApi.postMessage({ type: "reveal", uri: loc.uri, range: loc.range }),
      hover: (loc) => vscodeApi.postMessage({ type: "highlight", uri: loc?.uri ?? "", range: loc?.range ?? null }),
    });
  }
  viewport.show(current.drawing);
  initTabOrder(viewport.element);
  restoreFocus(viewport.element, keep);
}

window.addEventListener("message", (event: MessageEvent<TimingUpdate>) => {
  const m = event.data;
  const root = document.getElementById("root");
  if (m?.type === "timing" && m.payload && root) render(root, m.payload);
});

const root = document.getElementById("root");
const initial = (window as unknown as { __BYNK_TIMING__?: TimingPayload }).__BYNK_TIMING__;
if (root) {
  if (initial) render(root, initial);
  else root.textContent = "No request to show.";
}
