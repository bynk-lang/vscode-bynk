// @webview-entry webview
// #846: the sequence-diagram webview's own bundle entry (`out/webview.js`,
// a separate esbuild target from the extension host's `out/extension.js` —
// see scripts/build.mjs). Runs inside the webview's browser context, never the
// extension host: no `vscode` module, only `acquireVsCodeApi()`.
//
// Reads the `SequencePayload` the extension host embeds as
// `window.__BYNK_SEQUENCE_MODEL__` and draws it with the first-party diagram
// engine (`src/diagram/`, model-diagrams slice 1) in UML notation. Every drawn
// element carries its model identity, so click-to-code is a lookup by id. It
// no longer zips Mermaid's rendered SVG back to the model by DOM order and
// coordinates (the old `participant-map.ts`). Colours are CSS over
// `--vscode-*`, so a theme switch needs no redraw.
//
// "Copy as Mermaid" keeps `mermaid-gen.ts` as an exporter, with no Mermaid
// runtime in this bundle: the host puts the text on the clipboard.

import { focusedRef, restoreFocus } from "../diagram/interact";
import { canvasMeasurer, type TextMeasurer } from "../diagram/measure";
import { renderSequence } from "../diagram/sequence/render";
import { ensureDiagramStyles } from "../diagram/style";
import { startLiveView, type VsCodeApi } from "./live";
import { toMermaid } from "./mermaid-gen";
import type { Range, RevealMessage, SequencePayload } from "./types";

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

function reveal(uri: string, range: Range): void {
  const message: RevealMessage = { type: "reveal", uri, range };
  vscodeApi.postMessage(message);
}

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

function actions(payload: SequencePayload): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "bynk-diagram-actions";
  const copy = document.createElement("button");
  copy.id = "bynk-copy-mermaid";
  copy.textContent = "Copy as Mermaid";
  copy.title = "Copy this diagram as Mermaid text, to paste into Markdown";
  copy.addEventListener("click", () => {
    vscodeApi.postMessage({ type: "copyText", text: toMermaid(payload.model).text, what: "Mermaid" });
  });
  bar.append(copy);
  return bar;
}

function render(root: HTMLElement, payload: SequencePayload | null): void {
  if (!payload) {
    root.textContent = "No sequence model to render.";
    return;
  }
  ensureDiagramStyles(document);
  const keep = focusedRef(root);
  const font = fontFamily();
  let svg: SVGSVGElement;
  try {
    svg = renderSequence(payload.model, {
      measure: measurerFor(font),
      fontFamily: font,
      host: { reveal: (range) => reveal(payload.uri, range) },
    });
  } catch (err) {
    root.textContent = `Failed to render diagram: ${String(err)}`;
    return;
  }
  root.replaceChildren(actions(payload), svg);
  restoreFocus(svg, keep);
  reportWiring(payload, svg);
}

/** Test seam (#852): when the host sets `window.__BYNK_SEQUENCE_DEBUG__`, post
 *  back the name drawn on each participant's element, found by its id. The
 *  extension-host integration test cannot reach the webview's DOM, so this is
 *  how it checks that each participant's element really is that participant.
 *  No-op in production: only the test sets the flag. */
function reportWiring(payload: SequencePayload, svg: SVGSVGElement): void {
  if (!(window as unknown as { __BYNK_SEQUENCE_DEBUG__?: boolean }).__BYNK_SEQUENCE_DEBUG__) return;
  vscodeApi.postMessage({
    type: "wiring",
    participants: payload.model.participants.map((p) => ({
      name: p.name,
      label: svg.querySelector(`[data-bynk-ref="p${p.id}"] .bynk-name`)?.textContent?.trim() ?? null,
    })),
  });
}

startLiveView<SequencePayload>(vscodeApi, "__BYNK_SEQUENCE_MODEL__", render);
