// @webview-entry
// #153: the model diff page's bundle (`out/model-diff.js`). Runs in the
// webview's browser context. Draws the architecture map and the agent state
// diagrams of "Bynk: Compare Model with…" with the views' own generators
// (`architecture-gen.ts`, `state-gen.ts`) over the merged before-and-after
// model the host embedded as `window.__BYNK_MODEL_DIFF__` (`DiffGraphs`):
// added elements green, changed amber, removed ones dashed ghosts that do not
// link anywhere (their source is not in the working tree). It also wires the
// page's table rows to `reveal`, as the inline script it replaces did.

import mermaid from "mermaid";

import { type ClickTarget, toMermaidArch } from "./architecture-gen";
import type { ArchModel } from "./architectureTypes";
import { toClassDefColor } from "./classdef-color";
import { type ArchMarks, type DiffMark, DEFAULT_DIFF_PALETTE, diffClassDefs, type DiffPalette } from "./diffMarks";
import { toMermaidState } from "./state-gen";
import { alignLabels, stateNode, transitionLabels } from "./state-map";
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
let renderSeq = 0;
/** Between two revisions nothing is in the working tree to open. */
let linked = true;

function reveal(uri: string, range: Range): void {
  if (!linked) return;
  const message: RevealMessage = { type: "reveal", uri, range };
  vscodeApi.postMessage(message);
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

/** Resolved through the browser to hex: a `classDef` splits on commas. */
function hexVar(name: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = cssVar(name, fallback);
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return toClassDefColor(resolved) ?? toClassDefColor(fallback) ?? fallback;
}

function palette(): DiffPalette {
  return {
    added: hexVar("--vscode-gitDecoration-addedResourceForeground", DEFAULT_DIFF_PALETTE.added),
    removed: hexVar("--vscode-gitDecoration-deletedResourceForeground", DEFAULT_DIFF_PALETTE.removed),
    changed: hexVar("--vscode-gitDecoration-modifiedResourceForeground", DEFAULT_DIFF_PALETTE.changed),
  };
}

function baseClassDefs(): string[] {
  const bg = hexVar("--vscode-editor-background", "#1e1e1e");
  const fg = hexVar("--vscode-editor-foreground", "#cccccc");
  const border = hexVar("--vscode-panel-border", fg);
  const sel = hexVar("--vscode-editor-inactiveSelectionBackground", bg);
  const code = hexVar("--vscode-textCodeBlock-background", bg);
  const desc = hexVar("--vscode-descriptionForeground", fg);
  return [
    `classDef contextNode fill:${sel},stroke:${border},color:${fg};`,
    `classDef adapterNode fill:${code},stroke:${border},color:${fg},stroke-dasharray: 4 2;`,
    `classDef memberNode fill:${bg},stroke:${border},color:${desc};`,
    `classDef toggleNode fill:transparent,stroke:${desc},color:${desc};`,
  ];
}

function initMermaid(): void {
  const bg = cssVar("--vscode-editor-background", "#1e1e1e");
  const fg = cssVar("--vscode-editor-foreground", "#cccccc");
  const border = cssVar("--vscode-panel-border", fg);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      background: bg,
      primaryColor: cssVar("--vscode-editor-inactiveSelectionBackground", bg),
      primaryTextColor: fg,
      primaryBorderColor: border,
      lineColor: fg,
      textColor: fg,
      edgeLabelBackground: bg,
      clusterBkg: bg,
      clusterBorder: border,
    },
    flowchart: { htmlLabels: false },
  });
}

const stroke = (p: DiffPalette, m: DiffMark): string =>
  m === "removed" ? `stroke:${p.removed},stroke-dasharray:4 3` : `stroke:${p[m]},stroke-width:3px`;

function wireArchClicks(root: ParentNode, targets: Map<string, ClickTarget>, toggle: (name: string) => void): void {
  for (const [id, target] of targets) {
    const el = root.querySelector(`[id*="flowchart-${id}-"]`);
    if (!el) continue;
    (el as HTMLElement).style.cursor = "pointer";
    el.addEventListener("click", () => {
      if (target.kind === "reveal") reveal(target.loc.uri, target.loc.range);
      else toggle(target.name);
    });
  }
}

const expanded = new Set<string>();

async function drawArchitecture(root: HTMLElement, g: NonNullable<Graphs["architecture"]>): Promise<void> {
  if (g.model.nodes.length === 0) {
    root.textContent = "No contexts found in this project.";
    return;
  }
  const { text, clickTargets, linkMarks } = toMermaidArch(g.model, expanded, g.marks);
  const p = palette();
  const full = [
    text,
    ...baseClassDefs(),
    ...diffClassDefs(p),
    ...linkMarks.map((l) => `linkStyle ${l.index} ${stroke(p, l.mark)};`),
  ].join("\n");
  try {
    const { svg } = await mermaid.render(`bynk-model-diff-arch-${renderSeq++}`, full);
    root.innerHTML = svg;
  } catch (err) {
    root.textContent = `Failed to render diagram: ${String(err)}`;
    return;
  }
  wireArchClicks(root, clickTargets, (name) => {
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
  const { text, edgeOrder, hasInitial, stateIds } = toMermaidState(machine, { showUnchanged: false });
  try {
    const { svg } = await mermaid.render(`bynk-model-diff-state-${renderSeq++}`, `${text}\n${diffClassDefs(palette()).join("\n")}`);
    holder.innerHTML = svg;
  } catch (err) {
    holder.textContent = `Failed to render diagram: ${String(err)}`;
    return;
  }
  // A removed field has no working-tree location to open.
  const link = (el: Element, range: Range): void => {
    (el as HTMLElement).style.cursor = "pointer";
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      reveal(uri, range);
    });
  };
  const nodes = [...holder.querySelectorAll("g.node")];
  for (const [id, name] of stateIds) {
    const node = stateNode(nodes, id);
    if (node && name !== "?" && machine.diffStates?.[name] !== "removed" && machine.diff !== "removed") {
      link(node, machine.fieldRange);
    }
  }
  const labels = alignLabels(
    transitionLabels([...holder.querySelectorAll(".edgeLabel .label[data-id]")]),
    edgeOrder.length,
    hasInitial,
  );
  const paths = transitionLabels([...holder.querySelectorAll("path.transition[data-id]")]).slice(hasInitial ? 1 : 0);
  edgeOrder.forEach((group, i) => {
    const label = labels[i] as HTMLElement | undefined;
    if (!label) return;
    if (group.diff) {
      label.classList.add(`diff-${group.diff}`);
      paths[i]?.classList.add(`diff-${group.diff}`);
    }
    if (group.diff !== "removed") link(label, group.edges[0].range);
  });
}

async function main(): Promise<void> {
  const graphs = ((window as unknown as { __BYNK_MODEL_DIFF__?: Graphs }).__BYNK_MODEL_DIFF__ ?? {
    architecture: null,
    agents: [],
  }) as Graphs;
  linked = graphs.linked !== false;
  initMermaid();
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
