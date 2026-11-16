// #147: the page for "Bynk: Compare Model with…": a `ModelDiff` as sections of
// added / removed / changed rows. Pure (no `vscode`), so the unit tests compile
// against it; `modelDiff.ts` supplies the nonce and the webview's CSP source.
// A row with a working-tree location is clickable: the page posts the shared
// `reveal` message, which the host answers with `revealLocation`.

import { escapeHtml } from "./escapeHtml";
import { countChanges, type DiffEntry, type ModelDiff } from "./modelDiffCore";
import type { DiffGraphs } from "./modelDiffGraphCore";

const SIGN: Record<DiffEntry["change"], string> = { added: "+", removed: "−", changed: "~" };

const CSS = `
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); padding: 8px 16px; }
  h1 { font-size: 1.2em; }
  h2 { font-size: 0.95em; text-transform: uppercase; letter-spacing: 0.03em; color: var(--vscode-descriptionForeground); margin-top: 1.4em; }
  .muted { color: var(--vscode-descriptionForeground); font-style: italic; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  td.sign { width: 1.5em; font-weight: bold; font-family: var(--vscode-editor-font-family, monospace); }
  td.element { white-space: nowrap; text-transform: uppercase; font-size: 0.8em; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
  td.name { font-family: var(--vscode-editor-font-family, monospace); }
  tr.added td.sign { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  tr.removed td.sign { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  tr.removed td.name { text-decoration: line-through; }
  tr.changed td.sign { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover { background: var(--vscode-list-hoverBackground); }
  .breaking { color: var(--vscode-editorWarning-foreground); font-weight: bold; }
  .diff-legend span { margin-right: 1.2em; }
  .diff-legend .added, .diff-added { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .diff-legend .removed, .diff-removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .diff-legend .changed, .diff-changed { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .diagram { overflow-x: auto; margin: 0.5em 0 1em; }
  .diagram path.diff-added { stroke: var(--vscode-gitDecoration-addedResourceForeground, #81b88b) !important; stroke-width: 2.5px; }
  .diagram path.diff-changed { stroke: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d) !important; stroke-width: 2.5px; }
  .diagram path.diff-removed { stroke: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39) !important; stroke-dasharray: 4 3; opacity: 0.7; }
  .diagram .label.diff-removed { text-decoration: line-through; }
  #root svg, .diagram svg { max-width: 100%; }
  h3 { font-size: 0.95em; margin: 1em 0 0.2em; }
  .warning { border-left: 3px solid var(--vscode-editorWarning-foreground); padding: 2px 8px; }
  .compatible { color: var(--vscode-testing-iconPassed, var(--vscode-descriptionForeground)); }
`;

function row(e: DiffEntry): string {
  const loc = e.loc;
  const attrs = loc
    ? ` class="${e.change} clickable" data-uri="${escapeHtml(loc.uri)}" data-range="${escapeHtml(JSON.stringify(loc.range))}" title="Open in the working tree"`
    : ` class="${e.change}"`;
  const verdict = e.verdict ? ` <span class="${e.verdict}">${e.verdict}</span>` : "";
  const detail = e.detail ? escapeHtml(e.detail) : "";
  return `<tr${attrs}><td class="sign">${SIGN[e.change]}</td><td class="element">${escapeHtml(e.element)}</td><td class="name">${escapeHtml(e.name)}</td><td>${detail}${verdict}</td></tr>`;
}

export interface ModelDiffPage {
  /** The earlier revision, for the heading. */
  against: string;
  /** What it was compared with (the later revision, or the working tree). */
  to?: string;
  nonce: string;
  cspSource: string;
  /** #153: the bundle (`out/model-diff.js`) that draws `graphs` and handles row
   *  clicks, and what it draws. Without them the page is the tables alone. */
  scriptUri?: string;
  graphs?: DiffGraphs;
}

const LEGEND = `<p class="diff-legend"><span class="added">+ added</span><span class="changed">~ changed</span><span class="removed">− removed (dashed ghost, not in the working tree)</span></p>`;

/** The graph sections: the architecture map and the changed agents' state
 *  diagrams, drawn client-side into the containers this leaves. */
function graphSections(g: DiffGraphs): string {
  const arch = g.architecture
    ? `<section id="architecture-map"><h2>Architecture map</h2>${LEGEND}<div id="diff-architecture" class="diagram"><p class="muted">Drawing…</p></div></section>`
    : "";
  const states =
    g.agents.length > 0
      ? `<section id="state-diagrams"><h2>Agent state diagrams (${g.agents.length})</h2>${LEGEND}<div id="diff-states"></div></section>`
      : "";
  return arch + states;
}

/** The page's script: the bundle with its payload when there is one, else just
 *  the row clicks. (`acquireVsCodeApi` may be called once per page, so the two
 *  never both appear.) */
function script(page: ModelDiffPage): string {
  if (page.scriptUri) {
    const json = JSON.stringify(page.graphs ?? { architecture: null, agents: [] }).replace(/</g, "\\u003c");
    return `<script nonce="${page.nonce}">window.__BYNK_MODEL_DIFF__ = ${json};</script>
<script nonce="${page.nonce}" src="${escapeHtml(page.scriptUri)}"></script>`;
  }
  return `<script nonce="${page.nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener("click", (ev) => {
    const row = ev.target.closest && ev.target.closest("tr[data-uri]");
    if (!row) return;
    vscode.postMessage({ type: "reveal", uri: row.dataset.uri, range: JSON.parse(row.dataset.range) });
  });
</script>`;
}

/** The page's HTML. */
export function renderModelDiffHtml(diff: ModelDiff, page: ModelDiffPage): string {
  const total = countChanges(diff);
  const sections = diff.sections
    .map((s) => {
      const body = s.unavailable
        ? `<p class="muted">Not compared: ${escapeHtml(s.unavailable)}.</p>`
        : s.entries.length === 0
          ? `<p class="muted">No differences.</p>`
          : `<table>${s.entries.map(row).join("")}</table>`;
      const note = s.note ? `<p class="muted note">${escapeHtml(s.note)}</p>` : "";
      return `<section id="${s.id}"><h2>${escapeHtml(s.title)} (${s.unavailable ? "n/a" : s.entries.length})</h2>${note}${body}</section>`;
    })
    .join("\n");
  const summary = total === 0 ? "No model differences." : `${total} model difference${total === 1 ? "" : "s"}.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${page.cspSource} 'unsafe-inline'; script-src 'nonce-${page.nonce}';">
<title>Bynk Model Diff</title>
<style>${CSS}</style>
</head>
<body>
<h1>Model diff: <code>${escapeHtml(page.against)}</code> → ${escapeHtml(page.to ?? "working tree")}</h1>
${(diff.warnings ?? []).map((w) => `<p class="warning">${escapeHtml(w)}</p>`).join("\n")}
<p>${summary} <span class="muted">+ added, − removed, ~ changed since ${escapeHtml(page.against)}.${page.to ? "" : " Select a row to open its source in the working tree."}</span></p>
${page.graphs ? graphSections(page.graphs) : ""}
${sections}
${script(page)}
</body>
</html>`;
}
