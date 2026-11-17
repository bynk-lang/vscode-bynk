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
import { buildToolbar, toolbarButton } from "../diagram/toolbar";
import { DiagramViewport } from "../diagram/viewport";
import { type LiveView, startLiveView, type VsCodeApi } from "./live";
import { sequenceCoverage, tallyText } from "../modelCoverageCore";
import { applyCoverageMarks, coverageBar } from "./coverageMarks";
import { toMermaid } from "./mermaid-gen";
import { compareTraces, formatMs, type Mark, overlayTrace, type StepView, type TraceView } from "../requestTraceCore";
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

/** #143: which request trace is laid over the diagram: the newest one that
 *  belongs on it (the default), none, or a chosen one; and one to compare it
 *  with. Kept across live updates. */
let traceChoice: "latest" | "off" | { id: string } = "latest";
let compareId: string | undefined;
/** The last `traceIntent` seen: a new one resets the choice to the latest request. */
let seenIntent = 0;
/** #144: whether the coverage overlay is drawn (when there is coverage). */
let showCoverage = true;
/** The toggle and legend above the diagram; rebuilt on each render. */
const covBar = document.createElement("div");

const viewport = new DiagramViewport(document);
const actionsBar = buildActions();
const traceBar = document.createElement("div");
traceBar.className = "bynk-diagram-actions bynk-trace-bar";
const tracePanel = document.createElement("section");
tracePanel.className = "bynk-trace-panel";
tracePanel.setAttribute("aria-label", "Request trace");
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
    // Model-diagrams slice 5: up a level, to the handler's context.
    extra: [
      toolbarButton("Components", "Show the component view of this handler's context", "bynk-open-component", () => {
        if (payload) post({ type: "openComponent", uri: payload.uri });
      }),
    ],
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

function followIntent(p: SequencePayload): void {
  const intent = p.traceIntent ?? 0;
  if (intent > seenIntent) {
    seenIntent = intent;
    traceChoice = "latest";
    compareId = undefined;
  }
}

function tracesOf(p: SequencePayload | null): TraceView[] {
  return p?.traces ?? [];
}

function selectedTrace(): TraceView | undefined {
  const traces = tracesOf(payload);
  if (traceChoice === "off") return undefined;
  if (traceChoice === "latest") return traces[0];
  const id = traceChoice.id;
  return traces.find((t) => t.id === id) ?? traces[0];
}

function describeTrace(t: TraceView): string {
  const time = new Date(t.receivedAt).toLocaleTimeString();
  return `${t.route} · ${t.status} · ${formatMs(t.durationMs)} · ${time}`;
}

function option(value: string, text: string, selected: boolean): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  o.selected = selected;
  return o;
}

/** The picker above the diagram: which trace to lay over it, and one to compare. */
function renderTraceBar(): void {
  traceBar.replaceChildren();
  const traces = tracesOf(payload);
  if (traces.length === 0) {
    traceBar.hidden = true;
    return;
  }
  traceBar.hidden = false;
  const chosen = selectedTrace();
  const label = document.createElement("label");
  label.append("Request trace ");
  const select = document.createElement("select");
  select.id = "bynk-trace-select";
  select.setAttribute("aria-label", "Request trace");
  select.append(option("latest", "Latest request", traceChoice === "latest"));
  select.append(option("off", "No trace", traceChoice === "off"));
  for (const t of traces) {
    select.append(option(`id:${t.id}`, describeTrace(t), typeof traceChoice === "object" && t.id === traceChoice.id));
  }
  select.addEventListener("change", () => {
    const v = select.value;
    traceChoice = v === "latest" || v === "off" ? v : { id: v.slice(3) };
    compareId = undefined;
    live?.rerender();
  });
  label.append(select);
  traceBar.append(label);
  if (chosen && traces.length > 1) {
    const cmp = document.createElement("label");
    cmp.append("Compare with ");
    const other = document.createElement("select");
    other.id = "bynk-trace-compare";
    other.setAttribute("aria-label", "Compare with another trace");
    other.append(option("", "—", compareId === undefined));
    for (const t of traces) {
      if (t.id !== chosen.id) other.append(option(t.id, describeTrace(t), t.id === compareId));
    }
    other.addEventListener("change", () => {
      compareId = other.value === "" ? undefined : other.value;
      renderTraceDetails();
    });
    cmp.append(other);
    traceBar.append(cmp);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lay the chosen trace over the drawing: what it touched is coloured, what it
 *  did not is faded, a failing call is red, and each call shows its time. */
function applyOverlay(): void {
  const svg = viewport.element;
  for (const el of svg.querySelectorAll(".bynk-trace-hit, .bynk-trace-miss, .bynk-trace-fault, .bynk-trace-pending")) {
    el.classList.remove("bynk-trace-hit", "bynk-trace-miss", "bynk-trace-fault", "bynk-trace-pending");
  }
  for (const el of svg.querySelectorAll(".bynk-trace-ms")) el.remove();
  const trace = selectedTrace();
  if (!trace || !payload) return;
  const { marks } = overlayTrace(payload.model, payload.uri, trace);
  for (const [id, mark] of marks) {
    const el = svg.querySelector(`[data-bynk-ref="${id}"]`);
    if (!el) continue;
    el.classList.add(`bynk-trace-${mark.state}`);
    if (id.startsWith("m") && mark.count > 0) markTiming(el, mark);
  }
}

function markTiming(el: Element, mark: Mark): void {
  const text = el.querySelector(".bynk-label");
  const note = `${formatMs(mark.ms)}${mark.count > 1 ? ` × ${mark.count}` : ""}`;
  if (text) {
    const span = document.createElementNS(SVG_NS, "tspan");
    span.setAttribute("class", "bynk-trace-ms");
    span.textContent = `  ${note}`;
    text.appendChild(span);
  }
  const title = el.querySelector("title");
  if (title) title.textContent = `${title.textContent ?? ""}\nThis request: ${mark.state}, ${note}`;
}

function cell(text: string, cls?: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function stepRow(step: StepView, index: number, onTrace: boolean, calleeText: string | undefined): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = `bynk-trace-step bynk-trace-step--${step.outcome}`;
  if (!onTrace) tr.classList.add("bynk-trace-step--off");
  tr.append(
    cell(String(index + 1)),
    cell(step.kind),
    cell(step.target),
    cell(formatMs(step.ms)),
    cell(step.outcome === "ok" ? "ok" : step.outcome === "fault" ? "✗ fault" : "… pending", `bynk-trace-${step.outcome}`),
    cell(calleeText ?? (onTrace ? "" : "not on this diagram"), "bynk-trace-note"),
  );
  const at = step.at;
  if (at) {
    tr.tabIndex = 0;
    tr.title = "Open this call in the source";
    const go = (): void => post({ type: "reveal", uri: at.uri, range: at.range } satisfies RevealMessage);
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        go();
      }
    });
  }
  return tr;
}

/** The chosen trace's own details, under the diagram: the request, its
 *  failure with frames that open the source, and its steps in order. */
function renderTraceDetails(): void {
  tracePanel.replaceChildren();
  const trace = selectedTrace();
  if (!trace || !payload) {
    tracePanel.hidden = true;
    return;
  }
  tracePanel.hidden = false;
  const head = document.createElement("p");
  head.className = trace.status >= 500 ? "bynk-trace-fail" : "";
  head.textContent = `${trace.route} → ${trace.status} in ${formatMs(trace.durationMs)}${trace.steps.length === 0 ? " (no calls recorded)" : ""}`;
  tracePanel.append(head);

  if (trace.fault) {
    const box = document.createElement("div");
    box.className = "bynk-trace-fault-box";
    const msg = document.createElement("p");
    msg.className = "bynk-trace-fail";
    msg.textContent = `✗ ${trace.fault.message}`;
    box.append(msg);
    for (const frame of trace.fault.frames) {
      const line = document.createElement("div");
      line.className = "bynk-trace-frame";
      line.textContent = frame.text;
      const at = frame.at;
      if (at) {
        line.classList.add("bynk-trace-frame--link");
        line.tabIndex = 0;
        const go = (): void => post({ type: "reveal", uri: at.uri, range: at.range } satisfies RevealMessage);
        line.addEventListener("click", go);
        line.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            go();
          }
        });
      }
      box.append(line);
    }
    tracePanel.append(box);
  }

  const { unmatched } = overlayTrace(payload.model, payload.uri, trace);
  const off = new Set(unmatched);
  const other = compareId ? tracesOf(payload).find((t) => t.id === compareId) : undefined;
  const table = document.createElement("table");
  table.className = "bynk-trace-steps";
  if (other) {
    const rows = compareTraces(trace, other);
    const hdr = table.createTHead().insertRow();
    for (const h of ["Call", "This", "Other", "Δ"]) hdr.insertCell().textContent = h;
    const body = table.createTBody();
    for (const r of rows) {
      const tr = body.insertRow();
      tr.append(
        cell(`${r.kind} ${r.target}`),
        cell(r.a === undefined ? "—" : formatMs(r.a)),
        cell(r.b === undefined ? "—" : formatMs(r.b)),
        cell(r.delta === undefined ? "" : `${r.delta >= 0 ? "+" : "−"}${formatMs(Math.abs(r.delta))}`, r.delta !== undefined && r.delta > 0 ? "bynk-trace-slower" : ""),
      );
      if (r.outcomeA !== r.outcomeB && r.outcomeA && r.outcomeB) tr.title = `${r.outcomeA} here, ${r.outcomeB} in the other`;
    }
  } else if (trace.steps.length > 0) {
    const hdr = table.createTHead().insertRow();
    for (const h of ["#", "Kind", "Call", "Time", "Outcome", ""]) hdr.insertCell().textContent = h;
    const body = table.createTBody();
    trace.steps.forEach((step, i) => {
      const callee = trace.callees[i];
      const calleeText = callee ? `→ ${callee.route} (${callee.context}) ${callee.status}, ${formatMs(callee.durationMs)}` : undefined;
      body.append(stepRow(step, i, !off.has(i), calleeText));
    });
  }
  tracePanel.append(table);
  if (trace.truncated) {
    const p = document.createElement("p");
    p.className = "bynk-trace-note";
    p.textContent = "More calls happened than the trace keeps (the first 200 are shown).";
    tracePanel.append(p);
  }
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
  followIntent(next);

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

  const sc = next.coverage ? sequenceCoverage(next.model, next.coverage) : undefined;
  covBar.replaceChildren();
  if (next.coverage && sc) {
    covBar.append(
      coverageBar(next.coverage, [tallyText(sc.calls, "call"), tallyText(sc.branchTally, "branch")], showCoverage, (on) => {
        showCoverage = on;
        live?.rerender();
      }),
    );
  }
  if (
    covBar.parentElement !== root ||
    actionsBar.parentElement !== root ||
    viewport.element.parentElement !== root ||
    tracePanel.parentElement !== root
  ) {
    root.replaceChildren(covBar, actionsBar, traceBar, viewport.element, tracePanel);
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
  if (sc && showCoverage) applyCoverageMarks(viewport.element, { ...sc.messages, ...sc.branches });
  if (retargeted) {
    viewport.element.scrollTop = 0;
    viewport.element.scrollLeft = 0;
  }
  initTabOrder(viewport.element);
  restoreFocus(viewport.element, keep);
  renderTraceBar();
  applyOverlay();
  renderTraceDetails();
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
