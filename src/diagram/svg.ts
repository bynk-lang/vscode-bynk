// Small SVG-building helpers for the diagram engine.
//
// Everything is built with `createElementNS` and text is set with
// `textContent`, never parsed as markup: labels come from user source, and the
// webview must never turn them into elements (model-diagrams track §4.5).

export const SVG_NS = "http://www.w3.org/2000/svg";

type Attrs = Record<string, string | number | undefined>;

/** Create an SVG element with `attrs` (undefined values are skipped), appended
 *  to `parent` when given. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined) el.setAttribute(name, String(value));
  }
  parent?.appendChild(el);
  return el;
}

/** A `<text>` element holding `content` as text. */
export function svgText(content: string, attrs: Attrs, parent?: Element): SVGTextElement {
  const el = svg("text", attrs, parent);
  el.textContent = content;
  return el;
}

/** A `<title>` (the native tooltip) as the first child of `parent`. */
export function svgTitle(content: string, parent: Element): void {
  const el = document.createElementNS(SVG_NS, "title");
  el.textContent = content;
  parent.insertBefore(el, parent.firstChild);
}

/** Round to a tenth of a pixel, so the markup stays short and stable. */
export function px(n: number): number {
  return Math.round(n * 10) / 10;
}
