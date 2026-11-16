// The diagram engine's stylesheet (model-diagrams track §4.5, goal G2).
//
// Every colour is a `var(--vscode-*)` custom property, read live by the
// browser: a theme switch, high contrast included, restyles the diagram with no
// redraw. Nothing is baked into the SVG.

/** The drawing's own rules, static: what an export inlines (`export.ts`). */
export const DIAGRAM_CSS = `
.bynk-diagram { font-size: 12px; overflow: visible; }
.bynk-diagram text { fill: var(--vscode-editor-foreground); }
.bynk-diagram .bynk-name { font-size: 13px; font-weight: 600; }
.bynk-diagram .bynk-stereotype,
.bynk-diagram .bynk-note-text,
.bynk-diagram .bynk-guard,
.bynk-diagram .bynk-frag-op { font-size: 11px; }
.bynk-diagram .bynk-stereotype { fill: var(--vscode-descriptionForeground); }
.bynk-diagram .bynk-frag-op { font-weight: 600; }

.bynk-diagram .bynk-head-box {
  fill: var(--vscode-editor-inactiveSelectionBackground);
  stroke: var(--vscode-panel-border, var(--vscode-editor-foreground));
}
.bynk-diagram .bynk-head--entry .bynk-head-box { stroke: var(--vscode-editor-foreground); stroke-width: 1.5; }
.bynk-diagram .bynk-figure { fill: none; stroke: var(--vscode-editor-foreground); stroke-width: 1.5; }
.bynk-diagram .bynk-lifeline-line { stroke: var(--vscode-panel-border, var(--vscode-editor-foreground)); stroke-dasharray: 4 4; }
.bynk-diagram .bynk-activation {
  fill: var(--vscode-editor-background);
  stroke: var(--vscode-editor-foreground);
}

.bynk-diagram .bynk-msg-line { fill: none; stroke: var(--vscode-editor-foreground); stroke-width: 1.2; }
.bynk-diagram .bynk-msg--reply .bynk-msg-line { stroke-dasharray: 5 4; }
.bynk-diagram .bynk-head-filled { fill: var(--vscode-editor-foreground); }
.bynk-diagram .bynk-head-open { fill: none; stroke: var(--vscode-editor-foreground); stroke-width: 1.2; }
.bynk-diagram .bynk-hit { fill: none; stroke: transparent; stroke-width: 12; }

.bynk-diagram .bynk-note-box {
  fill: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
  stroke: var(--vscode-panel-border, var(--vscode-editor-foreground));
}
.bynk-diagram .bynk-note--state .bynk-note-box { stroke: var(--vscode-charts-purple, var(--vscode-editor-foreground)); }
.bynk-diagram .bynk-note--collapsed .bynk-note-box,
.bynk-diagram .bynk-note--empty .bynk-note-box { stroke-dasharray: 3 3; }
.bynk-diagram .bynk-note--collapsed .bynk-note-text,
.bynk-diagram .bynk-note--empty .bynk-note-text { fill: var(--vscode-descriptionForeground); }

.bynk-diagram .bynk-frag-box { fill: none; stroke: var(--vscode-editor-foreground); stroke-opacity: 0.7; }
.bynk-diagram .bynk-frag-sep { stroke: var(--vscode-editor-foreground); stroke-opacity: 0.7; stroke-dasharray: 5 4; }
.bynk-diagram .bynk-frag-tab-box {
  fill: var(--vscode-editor-inactiveSelectionBackground);
  stroke: var(--vscode-editor-foreground);
  stroke-opacity: 0.7;
}
.bynk-diagram .bynk-guard { fill: var(--vscode-descriptionForeground); }

.bynk-diagram .bynk-frag-summary { font-size: 11px; font-style: italic; fill: var(--vscode-descriptionForeground); }
.bynk-diagram .bynk-fold-hit { fill: transparent; }
.bynk-diagram .bynk-fold-glyph { fill: var(--vscode-editor-foreground); }
.bynk-diagram .bynk-frag--folded .bynk-frag-box { stroke-dasharray: 2 3; }

body.vscode-high-contrast .bynk-diagram .bynk-head-box,
body.vscode-high-contrast .bynk-diagram .bynk-note-box,
body.vscode-high-contrast .bynk-diagram .bynk-frag-box { stroke: var(--vscode-contrastBorder); }

`;

/** The drawing's interactive rules: pointer, hover, focus and the cursor's
 *  current element. Not exported: they mean nothing in a static file. */
const INTERACTIVE_CSS = `
.bynk-diagram .bynk-fold:hover .bynk-fold-glyph { fill: var(--vscode-focusBorder); }
.bynk-diagram .bynk-fold { cursor: pointer; }
.bynk-diagram [data-bynk-focusable] { cursor: pointer; outline: none; }
.bynk-diagram [data-bynk-focusable]:hover .bynk-msg-line,
.bynk-diagram [data-bynk-focusable]:hover .bynk-head-box,
.bynk-diagram [data-bynk-focusable]:hover .bynk-note-box,
.bynk-diagram [data-bynk-focusable]:hover .bynk-frag-tab-box { stroke: var(--vscode-focusBorder); }
.bynk-diagram [data-bynk-focusable]:hover > text,
.bynk-diagram text[data-bynk-focusable]:hover { fill: var(--vscode-textLink-foreground); }
.bynk-diagram [data-bynk-focusable]:focus-visible .bynk-msg-line,
.bynk-diagram [data-bynk-focusable]:focus-visible .bynk-head-box,
.bynk-diagram [data-bynk-focusable]:focus-visible .bynk-note-box,
.bynk-diagram [data-bynk-focusable]:focus-visible .bynk-frag-tab-box { stroke: var(--vscode-focusBorder); stroke-width: 2; }
.bynk-diagram [data-bynk-focusable]:focus-visible > text,
.bynk-diagram text[data-bynk-focusable]:focus-visible { fill: var(--vscode-textLink-activeForeground, var(--vscode-focusBorder)); text-decoration: underline; }

.bynk-diagram .bynk-current .bynk-msg-line,
.bynk-diagram .bynk-current .bynk-note-box,
.bynk-diagram .bynk-current.bynk-frag-tab .bynk-frag-tab-box,
.bynk-diagram .bynk-current .bynk-head-box { stroke: var(--vscode-editorCursor-foreground, var(--vscode-focusBorder)); stroke-width: 2.5; }
.bynk-diagram .bynk-current > text,
.bynk-diagram text.bynk-current { font-weight: 600; }
`;

/** The page around the drawing: viewport, sticky heads, minimap, toolbar. */
const PAGE_CSS = `
#root .bynk-viewport svg { max-width: none; display: block; }
.bynk-viewport { position: relative; overflow: auto; height: 70vh; outline: none; cursor: default; }
.bynk-viewport.bynk-panning { cursor: grabbing; user-select: none; }
.bynk-sticky-head {
  position: sticky; top: 0; z-index: 1;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border, transparent);
}
.bynk-minimap {
  position: fixed; right: 16px; bottom: 16px; z-index: 2; width: 120px; overflow: hidden;
  max-height: 60vh; cursor: pointer; opacity: 0.85;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
}
.bynk-minimap svg { display: block; pointer-events: none; }
.bynk-minimap-view {
  position: absolute; pointer-events: none;
  background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
  border: 1px solid var(--vscode-focusBorder);
}

.bynk-diagram-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 6px; font-size: 0.85em; }
.bynk-diagram-actions .bynk-sep { width: 1px; align-self: stretch; background: var(--vscode-panel-border, transparent); margin: 0 2px; }
.bynk-diagram-actions .bynk-zoom-label { min-width: 3.5em; text-align: center; color: var(--vscode-descriptionForeground); }
.bynk-diagram-actions button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none; border-radius: 2px; padding: 2px 8px; cursor: pointer;
}
.bynk-diagram-actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
`;

/** Add the stylesheet to `doc` once. */
export function ensureDiagramStyles(doc: Document): void {
  if (doc.getElementById("bynk-diagram-style")) return;
  const style = doc.createElement("style");
  style.id = "bynk-diagram-style";
  style.textContent = DIAGRAM_CSS + INTERACTIVE_CSS + PAGE_CSS;
  doc.head.appendChild(style);
}
