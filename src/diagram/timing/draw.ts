// Draw a laid-out timing scene as SVG (#218), in UML timing-diagram notation:
// a lifeline per row, bars for the time each step took, a time axis across the
// top. Every bar carries `data-bynk-ref`, its id, and is a focusable button
// when it has a `.bynk` call site, as the sequence diagram's messages are, so
// the engine's interaction layer reveals its source with no extra wiring.

import { px, svg, svgText, svgTitle } from "../svg";
import type { Drawing } from "../viewport";
import type { PlacedBar, TimingScene } from "./layout";

export interface TimingDrawOptions {
  title: string;
  fontFamily: string;
  /** What each bar's accessible name is, by bar id. */
  describe(bar: PlacedBar): string;
}

export function drawTiming(scene: TimingScene, opts: TimingDrawOptions): Drawing {
  const { width, headHeight } = scene;
  const bodyHeight = Math.max(scene.height - headHeight, 1);
  const head = svg("svg", {
    class: "bynk-diagram bynk-timing bynk-timing-head",
    width,
    height: headHeight,
    viewBox: `0 0 ${width} ${headHeight}`,
    role: "group",
    "aria-label": `${opts.title}: time axis`,
  });
  head.style.fontFamily = opts.fontFamily;
  const body = svg("svg", {
    class: "bynk-diagram bynk-timing",
    width,
    height: bodyHeight,
    viewBox: `0 ${headHeight} ${width} ${bodyHeight}`,
    role: "group",
    "aria-label": opts.title,
  });
  body.style.fontFamily = opts.fontFamily;

  // The axis: a rule with a tick and a label at each step.
  const axis = svg("g", { class: "bynk-taxis" }, head);
  svg("line", { class: "bynk-taxis-rule", x1: px(scene.x0), y1: headHeight - 1, x2: px(scene.x1), y2: headHeight - 1 }, axis);
  svgText("ms from the request's start", { class: "bynk-taxis-title", x: 12, y: headHeight - 8 }, axis);
  for (const t of scene.ticks) {
    svg("line", { class: "bynk-ttick", x1: px(t.x), y1: headHeight - 6, x2: px(t.x), y2: headHeight - 1 }, axis);
    svgText(t.label, { class: "bynk-ttick-label", x: px(t.x), y: headHeight - 10, "text-anchor": "middle" }, axis);
  }

  const grid = svg("g", { class: "bynk-tgrid" }, body);
  for (const t of scene.ticks) {
    svg("line", { class: "bynk-tgrid-line", x1: px(t.x), y1: headHeight, x2: px(t.x), y2: scene.footer.y - 14 }, grid);
  }

  for (const h of scene.headings) {
    svgText(h.text, { class: `bynk-theading${h.failed ? " bynk-theading--fault" : ""}`, x: 12, y: px(h.y) }, body);
  }
  for (const r of scene.rows) {
    const g = svg("g", { class: `bynk-trow bynk-trow--${r.kind}` }, body);
    svg("line", { class: "bynk-lifeline-line bynk-trow-line", x1: px(scene.x0), y1: px(r.y + 14), x2: px(scene.x1), y2: px(r.y + 14) }, g);
    svgText(r.label, { class: "bynk-name bynk-trow-label", x: px(r.labelX), y: px(r.detail ? r.y + 11 : r.y + 18) }, g);
    if (r.detail) svgText(r.detail, { class: "bynk-stereotype bynk-trow-detail", x: px(r.labelX), y: px(r.y + 23) }, g);
  }

  const items = svg("g", { class: "bynk-tbars" }, body);
  for (const p of scene.bars) drawBar(p, items, opts);

  svgText(scene.footer.text, { class: "bynk-tfooter", x: 12, y: px(scene.footer.y) }, body);
  return { head, body, width, headHeight, bodyHeight };
}

function drawBar(p: PlacedBar, parent: Element, opts: TimingDrawOptions): void {
  const { bar } = p;
  const cls = [
    "bynk-tbar",
    `bynk-tbar--${bar.kind}`,
    `bynk-tbar--${bar.outcome}`,
    bar.critical ? "bynk-tbar--critical" : "",
    p.only ? "bynk-tbar--only" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const g = svg("g", { class: cls, "data-bynk-ref": bar.id }, parent);
  // A wide invisible rect so a 3 px bar is easy to hit.
  svg("rect", { class: "bynk-thit", x: px(p.x - 2), y: px(p.y - 4), width: px(p.w + 4), height: 22 }, g);
  svg("rect", { class: "bynk-tbar-box", x: px(p.x), y: px(p.y), width: px(p.w), height: 14, rx: 2 }, g);
  const description = opts.describe(p);
  if (p.label.placement !== "none") {
    svgText(
      p.label.text,
      {
        class: `bynk-tbar-label bynk-tbar-label--${p.label.placement}`,
        x: px(p.label.x),
        y: px(p.y + 11),
        "text-anchor": p.label.placement === "inside" ? "middle" : "start",
      },
      g,
    );
  }
  if (p.delta) {
    svgText(
      p.delta.text,
      { class: `bynk-tdelta ${p.delta.slower ? "bynk-tdelta--slower" : "bynk-tdelta--faster"}`, x: px(p.delta.x), y: px(p.y + 11) },
      g,
    );
  }
  if (bar.at) {
    g.setAttribute("data-bynk-focusable", "");
    g.setAttribute("tabindex", "-1");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", description);
    svgTitle(`${description}\nClick to show the source.`, g);
  } else {
    g.setAttribute("role", "img");
    g.setAttribute("aria-label", description);
    svgTitle(description, g);
  }
}
