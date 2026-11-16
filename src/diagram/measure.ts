// Text measurement for diagram layout (model-diagrams track §4.3).
//
// Layout needs the width of every label before it can place anything, but it
// must stay a pure function: the same model and measurer always give the same
// scene. So measurement is an interface the caller supplies. In a webview it is
// the canvas's `measureText` with the editor's font; in tests (and, later,
// headless rendering) it is a fixed per-character width.

/** The type sizes a diagram uses. */
export type FontRole = "label" | "name" | "small";

export const FONT_SIZE: Record<FontRole, number> = { label: 12, name: 13, small: 11 };

export interface TextMeasurer {
  /** The rendered width of `text` in `role`'s size, in pixels. */
  width(text: string, role: FontRole): number;
}

/** A measurer with a fixed average character width (as a fraction of the font
 *  size). Deterministic, so layout tests can assert exact positions. */
export function fixedMeasurer(charEm = 0.6): TextMeasurer {
  return { width: (text, role) => Math.ceil(text.length * FONT_SIZE[role] * charEm) };
}

/** A measurer backed by a canvas 2D context using `fontFamily`. Falls back to
 *  `fixedMeasurer` where a canvas context is unavailable (jsdom). Results are
 *  cached per role and string, since a live view re-lays out on every edit. */
export function canvasMeasurer(fontFamily: string): TextMeasurer {
  const fallback = fixedMeasurer();
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return fallback;
  const context = ctx;
  const cache = new Map<string, number>();
  return {
    width(text, role) {
      const key = `${role}\u0000${text}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      context.font = `${role === "name" ? "600 " : ""}${FONT_SIZE[role]}px ${fontFamily}`;
      const w = Math.ceil(context.measureText(text).width);
      cache.set(key, w);
      return w;
    },
  };
}
