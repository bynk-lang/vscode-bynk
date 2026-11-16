// The diagram viewport (model-diagrams track §4.6, slice 2): one scroll
// container that holds a drawing's pinned head strip and its body, with zoom,
// pan and a minimap.
//
// - Sticky headers: the head SVG sits in a `position: sticky` strip at the top
//   of the scroll container. It scrolls sideways with the body (same
//   container, same width) and stays put when the body scrolls down.
// - Zoom: "fit" (the width of the panel, never above 100%) or a factor, set by
//   the toolbar, Ctrl/Cmd + wheel (anchored at the pointer) or the `+`, `-` and
//   `0` keys. Zoom scales the SVGs' width and height; their viewBoxes do not
//   change, so text stays crisp.
// - Pan: drag the background (not an element), or scroll as usual.
// - Minimap: for a drawing much taller or wider than the panel, a scaled
//   outline of the body with the visible region marked; click or drag on it to
//   move there.
//
// Zoom and scroll position survive a redraw (a live update or a fold), so the
// reader stays where they were (goal G3).

export interface Drawing {
  head: SVGSVGElement;
  body: SVGSVGElement;
  width: number;
  headHeight: number;
  bodyHeight: number;
}

export type Zoom = number | "fit";

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3;
const ZOOM_STEP = 1.25;
const MINIMAP_WIDTH = 120;
/** Show the minimap when the body is this many times the panel's size. */
const MINIMAP_THRESHOLD = 1.5;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** The factor "fit" means for a drawing `width` wide in a panel `available`
 *  wide: the panel's width, but never larger than 100%. */
export function fitZoom(width: number, available: number): number {
  if (available <= 0 || width <= 0) return 1;
  return clampZoom(Math.min(1, available / width));
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The visible region of the body, in minimap pixels. `scroll` is the
 *  container's scroll position and size, in screen pixels at `zoom`; the body
 *  starts `headHeight * zoom` below the container's top. */
export function minimapRect(
  scroll: { left: number; top: number; width: number; height: number },
  zoom: number,
  mapScale: number,
): Rect {
  return {
    x: (scroll.left / zoom) * mapScale,
    y: (scroll.top / zoom) * mapScale,
    w: (scroll.width / zoom) * mapScale,
    h: (scroll.height / zoom) * mapScale,
  };
}

/** The scroll position that centres the view on minimap point (mx, my). */
export function scrollForMinimapPoint(
  mx: number,
  my: number,
  view: { width: number; height: number },
  zoom: number,
  mapScale: number,
): { left: number; top: number } {
  return {
    left: Math.max(0, (mx / mapScale) * zoom - view.width / 2),
    top: Math.max(0, (my / mapScale) * zoom - view.height / 2),
  };
}

/** Whether a body `w` x `h` (at zoom) is big enough, against a panel
 *  `vw` x `vh`, to be worth a minimap. */
export function wantsMinimap(w: number, h: number, vw: number, vh: number): boolean {
  if (vw <= 0 || vh <= 0) return false;
  return h > vh * MINIMAP_THRESHOLD || w > vw * MINIMAP_THRESHOLD;
}

/** Strip a clone of everything interactive or identifying, for a picture of
 *  the drawing (the minimap, an export). */
export function inertClone(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  for (const el of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
    for (const name of ["tabindex", "role", "aria-label", "aria-expanded", "data-bynk-ref", "data-bynk-focusable", "data-bynk-foldable", "data-bynk-fold-toggle"]) {
      el.removeAttribute(name);
    }
  }
  for (const t of Array.from(clone.querySelectorAll("title"))) t.remove();
  return clone;
}

export class DiagramViewport {
  /** The scroll container. */
  readonly element: HTMLDivElement;
  private readonly headStrip: HTMLDivElement;
  private readonly bodyWrap: HTMLDivElement;
  private readonly minimap: HTMLDivElement;
  private readonly minimapView: HTMLDivElement;
  private drawing: Drawing | undefined;
  private zoomSetting: Zoom = "fit";
  private listeners: Array<() => void> = [];

  constructor(private readonly doc: Document) {
    this.element = doc.createElement("div");
    this.element.className = "bynk-viewport";
    this.element.tabIndex = -1;
    this.headStrip = doc.createElement("div");
    this.headStrip.className = "bynk-sticky-head";
    this.bodyWrap = doc.createElement("div");
    this.bodyWrap.className = "bynk-viewport-body";
    this.element.append(this.headStrip, this.bodyWrap);

    this.minimap = doc.createElement("div");
    this.minimap.className = "bynk-minimap";
    this.minimap.hidden = true;
    this.minimap.setAttribute("aria-hidden", "true");
    this.minimapView = doc.createElement("div");
    this.minimapView.className = "bynk-minimap-view";

    this.element.addEventListener("scroll", () => this.updateMinimapView());
    this.element.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.element.addEventListener("keydown", (e) => this.onKey(e));
    this.wirePan();
    this.wireMinimap();
    doc.defaultView?.addEventListener("resize", () => {
      this.fitHeight();
      if (this.zoomSetting === "fit") this.applyZoom();
      else this.renderMinimap();
    });
  }

  /** The minimap element, to place in the page (outside the scroll area). */
  get minimapElement(): HTMLDivElement {
    return this.minimap;
  }

  /** Call `fn` whenever the zoom changes (to update a zoom label). */
  onZoomChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** The zoom in effect, as a factor. */
  get zoom(): number {
    if (!this.drawing) return 1;
    return this.zoomSetting === "fit" ? fitZoom(this.drawing.width, this.availableWidth()) : this.zoomSetting;
  }

  get isFit(): boolean {
    return this.zoomSetting === "fit";
  }

  /** Show `drawing`, keeping the zoom and scroll position. */
  show(drawing: Drawing): void {
    const left = this.element.scrollLeft;
    const top = this.element.scrollTop;
    this.drawing = drawing;
    this.headStrip.replaceChildren(drawing.head);
    this.bodyWrap.replaceChildren(drawing.body);
    this.applyZoom();
    this.element.scrollLeft = left;
    this.element.scrollTop = top;
    this.fitHeight();
    this.updateMinimapView();
  }

  setZoom(zoom: Zoom, anchor?: { x: number; y: number }): void {
    const before = this.zoom;
    this.zoomSetting = zoom === "fit" ? "fit" : clampZoom(zoom);
    const after = this.zoom;
    const ax = anchor?.x ?? this.element.clientWidth / 2;
    const ay = anchor?.y ?? this.element.clientHeight / 2;
    // Keep the point under the anchor where it is.
    const cx = (this.element.scrollLeft + ax) / before;
    const cy = (this.element.scrollTop + ay) / before;
    this.applyZoom();
    this.element.scrollLeft = Math.max(0, cx * after - ax);
    this.element.scrollTop = Math.max(0, cy * after - ay);
  }

  zoomIn(): void {
    this.setZoom(this.zoom * ZOOM_STEP);
  }

  zoomOut(): void {
    this.setZoom(this.zoom / ZOOM_STEP);
  }

  /** Scroll so `el` is in view, below the pinned heads. */
  reveal(el: Element): void {
    const box = el.getBoundingClientRect();
    const view = this.element.getBoundingClientRect();
    const headH = this.headStrip.getBoundingClientRect().height;
    const top = view.top + headH;
    if (box.top < top) this.element.scrollTop -= top - box.top + 16;
    else if (box.bottom > view.bottom) this.element.scrollTop += box.bottom - view.bottom + 16;
    if (box.left < view.left) this.element.scrollLeft -= view.left - box.left + 16;
    else if (box.right > view.right) this.element.scrollLeft += box.right - view.right + 16;
  }

  private availableWidth(): number {
    return this.element.clientWidth - 4;
  }

  private applyZoom(): void {
    const d = this.drawing;
    if (!d) return;
    const z = this.zoom;
    const size = (svg: SVGSVGElement, h: number): void => {
      svg.setAttribute("width", String(Math.round(d.width * z)));
      svg.setAttribute("height", String(Math.round(h * z)));
    };
    size(d.head, d.headHeight);
    size(d.body, d.bodyHeight);
    this.headStrip.style.width = `${Math.round(d.width * z)}px`;
    this.renderMinimap();
    for (const fn of this.listeners) fn();
  }

  /** Fill the panel below the viewport's top. An inline viewport (one
   *  diagram among other content, `bynk-viewport--inline`) is as tall as its
   *  drawing instead, and the page scrolls. */
  private fitHeight(): void {
    const win = this.doc.defaultView;
    if (!win || !this.element.isConnected) return;
    if (this.element.classList.contains("bynk-viewport--inline")) {
      this.element.style.height = "";
      return;
    }
    const top = this.element.getBoundingClientRect().top;
    const h = Math.max(200, win.innerHeight - top - 12);
    this.element.style.height = `${Math.round(h)}px`;
  }

  private onWheel(e: WheelEvent): void {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = this.element.getBoundingClientRect();
    this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.002), { x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") this.zoomIn();
    else if (e.key === "-" || e.key === "_") this.zoomOut();
    else if (e.key === "0") this.setZoom("fit");
    else return;
    e.preventDefault();
  }

  private wirePan(): void {
    let drag: { x: number; y: number; left: number; top: number; id: number } | undefined;
    this.element.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const t = e.target as Element | null;
      if (t?.closest?.("[data-bynk-focusable], [data-bynk-fold-toggle], button")) return;
      drag = { x: e.clientX, y: e.clientY, left: this.element.scrollLeft, top: this.element.scrollTop, id: e.pointerId };
      this.element.classList.add("bynk-panning");
      this.element.setPointerCapture?.(e.pointerId);
    });
    this.element.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      this.element.scrollLeft = drag.left - (e.clientX - drag.x);
      this.element.scrollTop = drag.top - (e.clientY - drag.y);
    });
    const end = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = undefined;
      this.element.classList.remove("bynk-panning");
    };
    this.element.addEventListener("pointerup", end);
    this.element.addEventListener("pointercancel", end);
  }

  private mapScale(): number {
    return this.drawing ? MINIMAP_WIDTH / this.drawing.width : 1;
  }

  private renderMinimap(): void {
    const d = this.drawing;
    const z = this.zoom;
    const show = !!d && wantsMinimap(d.width * z, d.bodyHeight * z, this.element.clientWidth, this.element.clientHeight);
    this.minimap.hidden = !show;
    if (!d || !show) return;
    const scale = this.mapScale();
    const picture = inertClone(d.body);
    picture.setAttribute("width", String(MINIMAP_WIDTH));
    picture.setAttribute("height", String(Math.round(d.bodyHeight * scale)));
    this.minimap.replaceChildren(picture, this.minimapView);
    this.updateMinimapView();
  }

  private updateMinimapView(): void {
    if (this.minimap.hidden || !this.drawing) return;
    const headH = this.drawing.headHeight * this.zoom;
    const r = minimapRect(
      {
        left: this.element.scrollLeft,
        top: this.element.scrollTop,
        width: this.element.clientWidth,
        height: Math.max(0, this.element.clientHeight - headH),
      },
      this.zoom,
      this.mapScale(),
    );
    Object.assign(this.minimapView.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  private wireMinimap(): void {
    let dragging = false;
    const go = (e: PointerEvent): void => {
      const rect = this.minimap.getBoundingClientRect();
      const to = scrollForMinimapPoint(
        e.clientX - rect.left,
        e.clientY - rect.top,
        { width: this.element.clientWidth, height: this.element.clientHeight },
        this.zoom,
        this.mapScale(),
      );
      this.element.scrollLeft = to.left;
      this.element.scrollTop = to.top;
    };
    this.minimap.addEventListener("pointerdown", (e) => {
      dragging = true;
      this.minimap.setPointerCapture?.(e.pointerId);
      go(e);
    });
    this.minimap.addEventListener("pointermove", (e) => {
      if (dragging) go(e);
    });
    this.minimap.addEventListener("pointerup", () => (dragging = false));
    this.minimap.addEventListener("pointercancel", () => (dragging = false));
  }
}
