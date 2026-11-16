// The diagram engine's stylesheet (model-diagrams track §4.5, goal G2).
//
// Every colour is a `var(--vscode-*)` custom property, read live by the
// browser: a theme switch, high contrast included, restyles the diagram with no
// redraw. Nothing is baked into the SVG.

const CSS = `
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

body.vscode-high-contrast .bynk-diagram .bynk-head-box,
body.vscode-high-contrast .bynk-diagram .bynk-note-box,
body.vscode-high-contrast .bynk-diagram .bynk-frag-box { stroke: var(--vscode-contrastBorder); }

.bynk-diagram-actions { display: flex; gap: 6px; margin: 0 0 6px; font-size: 0.85em; }
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
  style.textContent = CSS;
  doc.head.appendChild(style);
}
