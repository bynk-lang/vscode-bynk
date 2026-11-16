// The toolbar every diagram page shares: copy as Mermaid, save as SVG or PNG,
// any view-specific toggles, and zoom (model-diagrams slices 2 and 4).

import { exportSvg, svgToPngBase64 } from "./export";
import { DIAGRAM_CSS } from "./style";
import type { Drawing, DiagramViewport } from "./viewport";

export interface ToolbarOptions {
  viewport: DiagramViewport;
  post(message: unknown): void;
  /** The diagram as Mermaid text, for "Copy as Mermaid"; `null` when none.
   *  Leave it out for a diagram Mermaid cannot draw (no button). */
  mermaid?(): string | null;
  /** The current drawing and the file name to offer, for "Save as …". */
  drawing(): { drawing: Drawing; name: string } | null;
  fontFamily(): string;
  /** View-specific controls, placed before the zoom group. */
  extra?: HTMLElement[];
}

export function toolbarButton(label: string, title: string, id: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.id = id;
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function sep(): HTMLElement {
  const s = document.createElement("span");
  s.className = "bynk-sep";
  return s;
}

export function buildToolbar(opts: ToolbarOptions): HTMLElement {
  const { viewport, post } = opts;
  const bar = document.createElement("div");
  bar.className = "bynk-diagram-actions";
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "bynk-zoom-label";
  zoomLabel.id = "bynk-zoom-label";
  const showZoom = (): void => {
    zoomLabel.textContent = `${Math.round(viewport.zoom * 100)}%${viewport.isFit ? " (fit)" : ""}`;
  };
  viewport.onZoomChange(showZoom);
  showZoom();

  const save = async (format: "svg" | "png"): Promise<void> => {
    const current = opts.drawing();
    if (!current) return;
    try {
      const style = getComputedStyle(document.body);
      const markup = exportSvg(current.drawing, {
        css: DIAGRAM_CSS,
        lookup: (name) => style.getPropertyValue(name),
        fontFamily: opts.fontFamily(),
      });
      const { width, headHeight, bodyHeight } = current.drawing;
      const data = format === "svg" ? markup : await svgToPngBase64(markup, width, headHeight + bodyHeight);
      post({ type: "saveFile", format, name: current.name, data });
    } catch (err) {
      post({ type: "error", message: `Could not make the ${format.toUpperCase()}: ${String(err)}` });
    }
  };

  const mermaid = opts.mermaid;
  if (mermaid) {
    bar.append(
      toolbarButton("Copy as Mermaid", "Copy this diagram as Mermaid text, to paste into Markdown", "bynk-copy-mermaid", () => {
        const text = mermaid();
        if (text) post({ type: "copyText", text, what: "Mermaid" });
      }),
    );
  }
  bar.append(
    toolbarButton("Save as SVG…", "Save this diagram as an SVG file, in the current theme's colours", "bynk-save-svg", () => void save("svg")),
    toolbarButton("Save as PNG…", "Save this diagram as a PNG image, in the current theme's colours", "bynk-save-png", () => void save("png")),
  );
  if (opts.extra && opts.extra.length > 0) bar.append(sep(), ...opts.extra);
  bar.append(
    sep(),
    toolbarButton("−", "Zoom out (−)", "bynk-zoom-out", () => viewport.zoomOut()),
    zoomLabel,
    toolbarButton("+", "Zoom in (+)", "bynk-zoom-in", () => viewport.zoomIn()),
    toolbarButton("Fit", "Fit the width of the panel (0)", "bynk-zoom-fit", () => viewport.setZoom("fit")),
    toolbarButton("100%", "Actual size", "bynk-zoom-100", () => viewport.setZoom(1)),
  );
  return bar;
}
