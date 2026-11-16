// Export a drawing as a standalone SVG or a PNG (model-diagrams track §4.6,
// slice 2).
//
// The live diagram is styled by CSS over `var(--vscode-*)` (goal G2), which
// only means something inside VS Code. An export resolves every variable to
// the colour the current theme gives it, inlines the stylesheet, and paints the
// editor background behind the drawing. The result looks as the diagram looks
// now, in any viewer.

import { inertClone, type Drawing } from "./viewport";
import { SVG_NS } from "./svg";

/** Resolve every `var(--name[, fallback])` in `css`, innermost first, with
 *  `lookup` (empty or undefined means unset, so the fallback applies). */
export function resolveCssVars(css: string, lookup: (name: string) => string | undefined): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("var(", i);
    if (at < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    // Find the matching close paren.
    let depth = 0;
    let end = at + 3;
    for (; end < css.length; end++) {
      if (css[end] === "(") depth++;
      else if (css[end] === ")" && --depth === 0) break;
    }
    const inner = css.slice(at + 4, end);
    out += resolveVar(inner, lookup);
    i = end + 1;
  }
  return out;
}

function resolveVar(inner: string, lookup: (name: string) => string | undefined): string {
  // Split at the first comma outside parentheses.
  let depth = 0;
  let comma = -1;
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      comma = k;
      break;
    }
  }
  const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
  const value = lookup(name)?.trim();
  if (value) return value;
  if (comma < 0) return "initial";
  return resolveCssVars(inner.slice(comma + 1).trim(), lookup);
}

export interface ExportStyle {
  /** The diagram stylesheet (`style.ts`). */
  css: string;
  /** A `--vscode-*` variable's current value. */
  lookup(name: string): string | undefined;
  fontFamily: string;
}

/** The drawing as one standalone SVG document, at 1:1. */
export function exportSvg(drawing: Drawing, style: ExportStyle): string {
  const doc = drawing.body.ownerDocument;
  const height = drawing.headHeight + drawing.bodyHeight;
  const root = doc.createElementNS(SVG_NS, "svg");
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("class", "bynk-diagram bynk-seq");
  root.setAttribute("width", String(drawing.width));
  root.setAttribute("height", String(height));
  root.setAttribute("viewBox", `0 0 ${drawing.width} ${height}`);
  root.setAttribute("font-family", style.fontFamily);

  const css = doc.createElementNS(SVG_NS, "style");
  css.textContent = resolveCssVars(style.css, style.lookup);
  root.appendChild(css);
  const bg = doc.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", style.lookup("--vscode-editor-background")?.trim() || "#ffffff");
  root.appendChild(bg);

  // Both parts are in scene coordinates: the body's viewBox only starts lower.
  for (const part of [inertClone(drawing.body), inertClone(drawing.head)]) {
    for (const child of Array.from(part.childNodes)) root.appendChild(child);
  }
  // The drawing's own window's serializer (the page's, in a webview).
  const Serializer = (doc.defaultView as (Window & typeof globalThis) | null)?.XMLSerializer ?? XMLSerializer;
  return new Serializer().serializeToString(root);
}

/** Render standalone SVG markup to a PNG at `scale`, as base64 (no prefix). */
export function svgToPngBase64(markup: string, width: number, height: number, scale = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no canvas"));
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""));
    };
    img.onerror = () => reject(new Error("could not draw the diagram as an image"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
}
