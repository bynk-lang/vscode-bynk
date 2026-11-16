// @webview-entry
// #153: the model diff page's bundle (`out/model-diff.js`). Runs in the
// webview's browser context. Draws the architecture map and the agent state
// diagrams of "Bynk: Compare Model with…" over the merged before-and-after
// model the host embedded as `window.__BYNK_MODEL_DIFF__` (`DiffGraphs`):
// added elements green, changed amber, removed ones dashed ghosts that do not
// link anywhere (their source is not in the working tree). It also wires the
// page's table rows to `reveal`, as the inline script it replaces did.
//
// Model-diagrams slice 6: both are drawn by the diagram engine, with the
// map's and the state view's own adapters (`structure/architecture.ts` with
// `marks`, `structure/stateMachine.ts`), not Mermaid. The marks are CSS
// classes over the theme's git decoration colours, and a sign (+ − ~) on
// each marked label, so a diff never relies on colour alone.

import { initTabOrder, wireInteraction } from "../diagram/interact";
import { canvasMeasurer, type TextMeasurer } from "../diagram/measure";
import { toArchitectureDiagram } from "../diagram/structure/architecture";
import { drawStructure } from "../diagram/structure/draw";
import type { StructDiagram } from "../diagram/structure/ir";
import { layoutStructure, type StructLayoutOptions } from "../diagram/structure/layout";
import { locsOf } from "../diagram/structure/locs";
import { toStateDiagram } from "../diagram/structure/stateMachine";
import { ensureDiagramStyles } from "../diagram/style";
import type { ArchLoc, ArchModel } from "./architectureTypes";
import type { ArchMarks } from "./diffMarks";
import type { StateMachine } from "./stateTypes";
import type { Range, RevealMessage } from "./types";
import type { VsCodeApi } from "./live";

declare function acquireVsCodeApi(): VsCodeApi;

interface Graphs {
  linked?: boolean;
  architecture: { model: ArchModel; marks: ArchMarks } | null;
  agents: Array<{ key: string; uri: string; machines: StateMachine[] }>;
}

const vscodeApi = acquireVsCodeApi();
/** Between two revisions nothing is in the working tree to open. */
let linked = true;

function reveal(uri: string, range: Range): void {
  if (!linked) return;
  const message: RevealMessage = { type: "reveal", uri, range };
  vscodeApi.postMessage(message);
}

function fontFamily(): string {
  const value = getComputedStyle(document.body).getPropertyValue("--vscode-font-family").trim();
  return value || "sans-serif";
}

let measurer: TextMeasurer | undefined;
/** Each drawing's sources by IR id, by the element it is drawn in. */
const holderLocs = new WeakMap<HTMLElement, Map<string, ArchLoc>>();

/** Lay out and draw `diagram` into `holder` (replacing what it showed), and
 *  wire its elements to their sources. Returns `false` when it failed. */
async function drawInto(
  holder: HTMLElement,
  diagram: StructDiagram,
  title: string,
  layout: StructLayoutOptions,
  toggleFold?: (id: string) => void,
): Promise<boolean> {
  const font = fontFamily();
  measurer ??= canvasMeasurer(font);
  try {
    const scene = await layoutStructure(diagram, measurer, layout);
    const drawing = drawStructure(scene, { title, fontFamily: font });
    drawing.body.style.maxWidth = "100%";
    drawing.body.style.height = "auto";
    holder.replaceChildren(drawing.body);
  } catch (err) {
    holder.textContent = `Failed to render diagram: ${String(err)}`;
    return false;
  }
  // The interaction layer reads the map at event time, so a redraw (a unit
  // opened in place) refills the same map.
  let live = holderLocs.get(holder);
  if (!live) {
    live = new Map<string, ArchLoc>();
    holderLocs.set(holder, live);
    holder.tabIndex = -1;
    wireInteraction<ArchLoc>(holder, live, { reveal: (loc) => reveal(loc.uri, loc.range), toggleFold });
  }
  live.clear();
  for (const [id, loc] of locsOf(diagram)) live.set(id, loc);
  initTabOrder(holder);
  return true;
}

const expanded = new Set<string>();

async function drawArchitecture(root: HTMLElement, g: NonNullable<Graphs["architecture"]>): Promise<void> {
  if (g.model.nodes.length === 0) {
    root.textContent = "No contexts found in this project.";
    return;
  }
  const diagram = toArchitectureDiagram(g.model, { expanded, events: false, marks: g.marks, linked });
  await drawInto(root, diagram, "Architecture map, compared", {}, (id) => {
    if (!id.startsWith("u:")) return;
    const name = id.slice(2);
    if (expanded.has(name)) expanded.delete(name);
    else expanded.add(name);
    void drawArchitecture(root, g);
  });
}

async function drawMachine(root: HTMLElement, uri: string, machine: StateMachine): Promise<void> {
  const holder = document.createElement("div");
  holder.className = "diagram";
  const title = document.createElement("h3");
  title.textContent = machine.diff === "added" ? `${machine.field} (new)` : machine.diff === "removed" ? `${machine.field} (removed)` : machine.field;
  root.append(title, holder);
  const diagram = toStateDiagram(machine, { uri, showUnchanged: false, linked });
  await drawInto(holder, diagram, `States of ${machine.field}, compared`, { direction: "DOWN" });
}

async function main(): Promise<void> {
  const graphs = ((window as unknown as { __BYNK_MODEL_DIFF__?: Graphs }).__BYNK_MODEL_DIFF__ ?? {
    architecture: null,
    agents: [],
  }) as Graphs;
  linked = graphs.linked !== false;
  ensureDiagramStyles(document);
  const arch = document.getElementById("diff-architecture");
  if (arch && graphs.architecture) await drawArchitecture(arch, graphs.architecture);
  const states = document.getElementById("diff-states");
  if (states) {
    for (const agent of graphs.agents) {
      const section = document.createElement("div");
      const h = document.createElement("h3");
      h.className = "agent";
      h.textContent = agent.key;
      section.append(h);
      states.append(section);
      for (const machine of agent.machines) await drawMachine(section, agent.uri, machine);
    }
  }
}

// The tables' rows open their source in the working tree.
document.addEventListener("click", (ev) => {
  const row = (ev.target as Element | null)?.closest?.("tr[data-uri]") as HTMLElement | null;
  if (!row?.dataset.uri || !row.dataset.range) return;
  reveal(row.dataset.uri, JSON.parse(row.dataset.range) as Range);
});

void main();
