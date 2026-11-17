// @webview-entry
// #2196: the agent state view's bundle entry (`out/state.js`). Runs in the
// webview's browser context.
//
// Renders the `AgentStatePayload` the host embeds as
// `window.__BYNK_AGENT_STATE__`: for the selected state field, its state
// machine and the handler x state table, which is the exact record (track
// §3.4). Everything links to source: table cells to their edge, handler names
// to the handler, states to the field and transitions to their write. The
// host reports the handler under the cursor as the view's `focus`; its row
// and transitions are highlighted without re-requesting the model.
//
// Model-diagrams slice 6: the machine is drawn by the diagram engine in UML
// state machine notation (`diagram/structure/stateMachine.ts`, laid out top
// to bottom by ELK), not Mermaid. It sits in the shared viewport (zoom, pan)
// with the shared toolbar: Copy as Mermaid (`state-gen.ts`, now an
// exporter), Save as SVG or PNG. Colours are CSS over `--vscode-*`, so a
// theme switch needs no redraw.

import { focusedRef, initTabOrder, restoreFocus, wireInteraction } from "../diagram/interact";
import { canvasMeasurer, type TextMeasurer } from "../diagram/measure";
import { drawStructure } from "../diagram/structure/draw";
import { layoutStructure } from "../diagram/structure/layout";
import { locsOf } from "../diagram/structure/locs";
import { toStateDiagram } from "../diagram/structure/stateMachine";
import { ensureDiagramStyles } from "../diagram/style";
import { buildToolbar } from "../diagram/toolbar";
import type { Drawing } from "../diagram/viewport";
import { DiagramViewport } from "../diagram/viewport";
import type { ArchLoc } from "./architectureTypes";
import { type LiveView, startLiveView, type ViewState, type VsCodeApi } from "./live";
import { applyCoverageMarks, coverageBar } from "./coverageMarks";
import { type StateCoverage, stateCoverage, tallyText } from "../modelCoverageCore";
import { cellEdges, cellText, toMermaidState, violationsFrom, writeText } from "./state-gen";
import type { AgentStatePayload, StateMachine } from "./stateTypes";
import type { Range, RevealMessage } from "./types";

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

// Kept across live updates (not across a reload): which field is shown,
// whether unchanged outcomes are drawn, and the handler under the cursor.
let selectedField: string | undefined;
let showUnchanged = false;
let effectsOpen = false;
/** #144: whether the coverage overlay is drawn (when there is coverage). */
let showCoverage = true;
let focus: string | undefined;
let current: AgentStatePayload | null = null;
let machineShown: StateMachine | undefined;
let drawing: Drawing | undefined;
/** Sources by IR id for the current drawing, refilled on each render. */
const locs = new Map<string, ArchLoc>();
/** The shared render queue: controls re-render through it (#2206 review). */
let live: LiveView | undefined;

function reveal(uri: string, range: Range): void {
  const message: RevealMessage = { type: "reveal", uri, range };
  vscodeApi.postMessage(message);
}

function clickable(el: Element, uri: string, range: Range): void {
  (el as HTMLElement).style.cursor = "pointer";
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    reveal(uri, range);
  });
}

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
viewport.element.classList.add("bynk-viewport--inline");
const actionsBar = buildToolbar({
  viewport,
  post: (m) => vscodeApi.postMessage(m),
  mermaid: () => (machineShown ? toMermaidState(machineShown, { showUnchanged }).text : null),
  drawing: () =>
    drawing && current && machineShown
      ? { drawing, name: `${current.model.agent}-${machineShown.field}` }
      : null,
  fontFamily,
});
let wired = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function renderEmpty(root: HTMLElement, payload: AgentStatePayload): void {
  const { model } = payload;
  const title = el("h2");
  const agent = el("a", model.agent);
  clickable(agent, payload.uri, model.range);
  title.append(agent);
  const p = el("p", undefined, "muted");
  p.append("No state machine: no ");
  p.append(el("code", "store"));
  p.append(" Cell holds an enum or sum type. What each handler does instead:");
  root.append(title, p);
  effects(root, payload);
}

/** #2198: per handler, one row per merged path — its conditions, what it
 *  writes (each write links to source), reads and calls, and what it yields. */
function effects(root: HTMLElement, payload: AgentStatePayload): void {
  const { model, uri } = payload;
  for (const h of model.effects ?? []) {
    const range = model.handlers.find((x) => x.name === h.handler)?.range;
    const section = el("div", undefined, "effects");
    section.dataset.handler = h.handler;
    const heading = el("h3");
    const link = el("a", `${h.handler}()`);
    if (range) clickable(link, uri, range);
    heading.append(link);
    section.append(heading);
    if (h.truncated) {
      section.append(el("p", "Too many paths to analyse.", "muted"));
      root.append(section);
      continue;
    }
    const t = el("table", undefined, "states effects-table");
    const head = el("tr");
    for (const c of ["When", "Writes", "Reads", "Calls", "Yields"]) head.append(el("th", c));
    t.append(el("thead"));
    t.tHead?.append(head);
    const body = el("tbody");
    for (const r of h.rows) {
      const row = el("tr");
      row.append(el("td", r.guards.length > 0 ? r.guards.join(" && ") : "always", r.guards.length > 0 ? "" : "muted"));
      const writes = el("td");
      if (r.writes.length === 0) {
        writes.textContent = "—";
        writes.classList.add("muted");
      }
      for (const w of r.writes) {
        const entry = el("div", writeText(w), "entry moves");
        clickable(entry, uri, w.range);
        writes.append(entry);
      }
      row.append(writes);
      row.append(el("td", r.reads.join(", ") || "—", r.reads.length > 0 ? "" : "muted"));
      row.append(el("td", r.calls.map((c) => `${c}()`).join(", ") || "—", r.calls.length > 0 ? "" : "muted"));
      row.append(el("td", r.outcomes.join(" | ") || "()", r.outcomes.length > 0 ? "" : "muted"));
      body.append(row);
    }
    t.append(body);
    section.append(t);
    root.append(section);
  }
}

function controls(root: HTMLElement, payload: AgentStatePayload, machine: StateMachine): void {
  const bar = el("div", undefined, "controls");
  const title = el("h2");
  const agent = el("a", payload.model.agent);
  clickable(agent, payload.uri, payload.model.range);
  title.append(agent, document.createTextNode("."));
  if (payload.model.machines.length > 1) {
    const select = el("select");
    select.id = "bynk-state-field";
    select.setAttribute("aria-label", "State field");
    for (const m of payload.model.machines) {
      const opt = el("option", m.field);
      opt.value = m.field;
      opt.selected = m.field === machine.field;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      selectedField = select.value;
      live?.rerender();
    });
    title.append(select);
  } else {
    const field = el("a", machine.field);
    clickable(field, payload.uri, machine.fieldRange);
    title.append(field);
  }
  bar.append(title);

  const label = el("label");
  const box = el("input");
  box.type = "checkbox";
  box.id = "bynk-state-unchanged";
  box.checked = showUnchanged;
  box.addEventListener("change", () => {
    showUnchanged = box.checked;
    live?.rerender();
  });
  label.append(box, document.createTextNode(" Show unchanged outcomes in the diagram"));
  bar.append(label);
  root.append(bar);
  const cov = payload.coverage;
  if (cov) {
    const sc = stateCoverage(machine, cov);
    root.append(
      coverageBar(cov, [tallyText(sc.tally, "transition")], showCoverage, (on) => {
        showCoverage = on;
        live?.rerender();
      }),
    );
  }
}

/** #144: the machine's coverage, when there is a run and the overlay is on. */
function coverageOf(payload: AgentStatePayload, machine: StateMachine): StateCoverage | undefined {
  return payload.coverage && showCoverage ? stateCoverage(machine, payload.coverage) : undefined;
}

/** The machine, drawn by the engine into the shared viewport. */
async function diagram(
  root: HTMLElement,
  payload: AgentStatePayload,
  machine: StateMachine,
  keep: string | null,
): Promise<void> {
  ensureDiagramStyles(document);
  const font = fontFamily();
  const structure = toStateDiagram(machine, { uri: payload.uri, showUnchanged });
  try {
    const scene = await layoutStructure(structure, measurerFor(font), { direction: "DOWN" });
    drawing = drawStructure(scene, { title: `States of ${payload.model.agent}.${machine.field}`, fontFamily: font });
  } catch (err) {
    drawing = undefined;
    root.append(el("div", `Failed to render diagram: ${String(err)}`, "diagram"));
    return;
  }
  machineShown = machine;
  locs.clear();
  for (const [id, loc] of locsOf(structure)) locs.set(id, loc);
  root.append(actionsBar, viewport.element);
  if (!viewport.minimapElement.isConnected) document.body.appendChild(viewport.minimapElement);
  if (!wired) {
    wired = true;
    wireInteraction<ArchLoc>(viewport.element, locs, {
      reveal: (loc) => reveal(loc.uri, loc.range),
      hover: (loc) => vscodeApi.postMessage({ type: "highlight", uri: loc?.uri ?? "", range: loc?.range ?? null }),
    });
  }
  viewport.show(drawing);
  const cov = coverageOf(payload, machine);
  if (cov) {
    // #144: untested transitions and states, on the engine's elements.
    const marks: Record<string, "covered" | "partial" | "uncovered" | "unmeasured"> = { ...cov.transitions };
    for (const [s, v] of Object.entries(cov.states)) if (v === "untested") marks[`state:${s}`] = "uncovered";
    applyCoverageMarks(viewport.element, marks);
  }
  initTabOrder(viewport.element);
  restoreFocus(viewport.element, keep);
}

function table(root: HTMLElement, payload: AgentStatePayload, machine: StateMachine): void {
  const cov = coverageOf(payload, machine);
  const t = el("table", undefined, "states");
  const head = el("tr");
  head.append(el("th", "Handler \\ state"));
  for (const s of machine.states) {
    const th = el("th", s);
    if (!machine.reachable.includes(s)) {
      th.classList.add("unreachable");
      th.title = "Unreachable from the initial state";
    }
    if (s === machine.initial) th.title = "Initial state";
    if (cov?.states[s] === "untested") {
      th.classList.add("bynk-cov-uncovered-entry");
      th.title = "No tested transition enters this state";
      th.append(document.createTextNode(" ✗"));
    }
    head.append(th);
  }
  t.append(el("thead"));
  t.tHead?.append(head);
  const body = el("tbody");
  for (const h of payload.model.handlers) {
    const row = el("tr");
    row.dataset.handler = h.name;
    const name = el("th");
    const link = el("a", `${h.name}()`);
    clickable(link, payload.uri, h.range);
    name.append(link);
    row.append(name);
    const truncated = machine.truncated.includes(h.name);
    for (const s of machine.states) {
      const cell = el("td");
      if (truncated) {
        cell.textContent = "too many paths";
        cell.classList.add("muted");
      } else {
        const edges = cellEdges(machine, h.name, s);
        if (edges.length === 0) {
          cell.textContent = "—";
          cell.classList.add("muted");
          cell.title = "No path of this handler starts in this state";
        }
        for (const e of edges) {
          const entry = el("div", cellText(e), "entry");
          if (e.to.kind !== "Unchanged") entry.classList.add("moves");
          const notes = e.guards.map((g) => `when ${g}`);
          // #2197: never colour alone — a marker and the transition's name.
          const vs = violationsFrom(e, s);
          if (vs.length > 0) {
            const known = vs.some((v) => v.certainty === "Known");
            entry.classList.add(known ? "flag-known" : "flag-possible");
            entry.append(document.createTextNode(` ⚠ ${vs.map((v) => v.transition).join(", ")}`));
            for (const v of vs) {
              const verb = v.certainty === "Known" ? "violates" : "may violate";
              notes.push(`${verb} ${v.transition} (to ${v.targets.join(" | ")}) at commit`);
            }
          }
          const mark = cov?.edges[machine.edges.indexOf(e)];
          if (mark === "uncovered" && e.to.kind !== "Unchanged") {
            entry.classList.add("bynk-cov-uncovered-entry");
            entry.append(document.createTextNode(" ✗ not tested"));
            notes.push("Not tested: none of this path's lines ran in the last coverage run");
          } else if (mark === "partial") {
            notes.push("Partly tested: some of this path's lines ran");
          }
          if (notes.length > 0) entry.title = notes.join("\n");
          clickable(entry, payload.uri, e.range);
          cell.append(entry);
        }
      }
      row.append(cell);
    }
    body.append(row);
  }
  t.append(body);
  root.append(t);
}

/** #2197: the overlay's legend, and the `transition`s it could not evaluate. */
function legend(root: HTMLElement, payload: AgentStatePayload, machine: StateMachine): void {
  const notEvaluated = machine.notEvaluated ?? [];
  const flagged = machine.edges.some((e) => (e.violations ?? []).length > 0);
  if (!flagged && notEvaluated.length === 0) return;
  const box = el("div", undefined, "legend");
  if (flagged) {
    const known = el("span", "⚠ red", "flag-known");
    const possible = el("span", "⚠ amber", "flag-possible");
    const p = el("p");
    p.append(
      known,
      document.createTextNode(": a `transition` refuses this at commit (InvariantViolation). "),
      possible,
      document.createTextNode(": a computed write may land on a state it refuses."),
    );
    box.append(p);
  }
  if (notEvaluated.length > 0) {
    const p = el("p", "Not evaluated (outside what the view can check): ", "muted");
    notEvaluated.forEach((n, i) => {
      if (i > 0) p.append(document.createTextNode(", "));
      const link = el("a", n.name);
      clickable(link, payload.uri, n.range);
      p.append(link);
    });
    box.append(p);
  }
  root.append(box);
}

/** A drawn transition's handlers (`data-bynk-tags`, a JSON array). */
function tagsOf(el: Element): string[] {
  try {
    const tags: unknown = JSON.parse(el.getAttribute("data-bynk-tags") ?? "[]");
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function applyFocus(root: HTMLElement): void {
  for (const row of root.querySelectorAll<HTMLElement>("tr[data-handler], .effects[data-handler]")) {
    row.classList.toggle("focus", row.dataset.handler === focus);
  }
  // The handler's transitions in the machine.
  for (const edge of viewport.element.querySelectorAll("[data-bynk-tags]")) {
    edge.classList.toggle("bynk-current", focus !== undefined && tagsOf(edge).includes(focus));
  }
}

async function renderPayload(root: HTMLElement, payload: AgentStatePayload | null): Promise<void> {
  current = payload;
  // Before the page is cleared, while the viewport is still attached.
  const keep = focusedRef(viewport.element);
  root.textContent = "";
  machineShown = undefined;
  drawing = undefined;
  if (!payload) {
    root.textContent = "No agent at the cursor.";
    return;
  }
  const machines = payload.model.machines;
  if (machines.length === 0) {
    renderEmpty(root, payload);
    applyFocus(root);
    return;
  }
  const machine = machines.find((m) => m.field === selectedField) ?? machines[0];
  selectedField = machine.field;

  controls(root, payload, machine);
  await diagram(root, payload, machine, keep);
  legend(root, payload, machine);
  table(root, payload, machine);
  // #2198: the per-handler effects, collapsed below the machine.
  if ((payload.model.effects ?? []).length > 0) {
    const details = el("details", undefined, "effects-details");
    details.open = effectsOpen;
    details.addEventListener("toggle", () => {
      effectsOpen = details.open;
    });
    details.append(el("summary", "Effects: what each handler writes, reads and calls"));
    effects(details, payload);
    root.append(details);
  }
  applyFocus(root);
}

live = startLiveView<AgentStatePayload>(vscodeApi, "__BYNK_AGENT_STATE__", renderPayload, (view: ViewState) => {
  focus = view.focus;
  const root = document.getElementById("root");
  if (root) applyFocus(root);
});
