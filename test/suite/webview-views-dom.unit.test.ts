// #45: the webview bundle entries and the shared live-view shell, run in jsdom
// against fixture payloads. Each entry runs on import (it reads its payload off
// `window` and renders), so a test sets the payload global, loads the compiled
// module afresh, and inspects the page. Server- and workspace-derived strings
// must land as text, never as elements.

import * as assert from "assert";

import type { ArchPayload } from "../../src/webview/architectureTypes";
import type { DocPayload } from "../../src/webview/docTypes";
import type { RefinedPayload } from "../../src/webview/refinedTypes";
import type { AgentStatePayload } from "../../src/webview/stateTypes";
import { HOSTILE, setupDom, settle, type Dom } from "./domHarness";

const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } };
const noMarkup = (root: ParentNode): void =>
  assert.strictEqual(root.querySelectorAll("img, script").length, 0, "markup in a string became an element");

describe("startLiveView (jsdom)", () => {
  let dom: Dom;
  beforeEach(() => {
    dom = setupDom({ __BYNK_THING__: { n: 1 }, __BYNK_VIEW__: { target: { uri: "file:///a" }, followsCursor: true } });
  });
  afterEach(() => dom.dispose());

  const start = async (render: (root: HTMLElement, p: { n: number } | null) => void | Promise<void>) => {
    const { startLiveView } = dom.load<typeof import("../../src/webview/live")>("live");
    const api = { postMessage: (m: unknown) => void dom.posted.push(m), setState: (s: unknown) => void dom.states.push(s) };
    const live = startLiveView(api, "__BYNK_THING__", render);
    await settle();
    return live;
  };

  it("renders the embedded payload, persists the target and says it is ready", async () => {
    const seen: unknown[] = [];
    await start((_root, p) => void seen.push(p));
    assert.deepStrictEqual(seen, [{ n: 1 }]);
    assert.deepStrictEqual(dom.states, [{ uri: "file:///a" }]);
    assert.deepStrictEqual(dom.posted, [{ type: "ready" }]);
  });

  it("draws Following/Refresh in the toolbar and posts the pin and refresh requests", async () => {
    await start(() => undefined);
    const bar = dom.document.getElementById("bynk-toolbar") as HTMLElement;
    const pin = bar.querySelector("#bynk-pin") as HTMLButtonElement;
    assert.strictEqual(pin.textContent, "Following cursor");
    assert.strictEqual(pin.getAttribute("aria-pressed"), "false");
    dom.posted.length = 0;
    pin.click();
    (bar.querySelector("#bynk-refresh") as HTMLButtonElement).click();
    assert.deepStrictEqual(dom.posted, [{ type: "pin", pinned: true }, { type: "refresh" }]);
  });

  it("redraws the toolbar as pinned, and drops the pin when the view doesn't follow the cursor", async () => {
    await start(() => undefined);
    dom.post({ type: "view", view: { target: { uri: "file:///a", pinned: true }, followsCursor: true, scope: "agent" } });
    const pin = dom.document.getElementById("bynk-pin") as HTMLButtonElement;
    assert.strictEqual(pin.textContent, "Pinned");
    assert.strictEqual(pin.getAttribute("aria-pressed"), "true");
    assert.ok(pin.title.includes("Pinned to this agent"));
    dom.post({ type: "view", view: { target: { uri: "file:///a" }, followsCursor: false } });
    assert.strictEqual(dom.document.getElementById("bynk-pin"), null);
    assert.ok(dom.document.getElementById("bynk-refresh"));
  });

  it("re-renders on an update, and a render queued behind a running one keeps only the latest", async () => {
    const seen: Array<number | undefined> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    await start(async (_root, p) => {
      seen.push(p?.n);
      if (first) {
        first = false;
        await gate;
      }
    });
    dom.post({ type: "update", payload: { n: 2 }, view: { target: { uri: "file:///a" }, followsCursor: false } });
    dom.post({ type: "update", payload: { n: 3 }, view: { target: { uri: "file:///a" }, followsCursor: false } });
    release();
    await settle();
    await settle();
    assert.deepStrictEqual(seen, [1, 3]);
  });

  it("does nothing when the page has no #root", async () => {
    dom.root.remove();
    const live = await start(() => assert.fail("rendered without a root"));
    assert.strictEqual(live, undefined);
  });
});

function docPayload(): DocPayload {
  const entry = (name: string, depth: number, markdown: string, documented: boolean, links: DocPayload["model"]["entries"][0]["links"] = []) => ({
    name,
    kind: "fn",
    depth,
    markdown,
    links,
    documented,
    range,
    uri: "file:///doc.bynk",
  });
  return {
    uri: "file:///doc.bynk",
    model: {
      unitName: `Unit${HOSTILE}`,
      unitKind: "context",
      unitDoc: `Lede ${HOSTILE}`,
      unitLinks: [],
      unitRange: range,
      entries: [
        entry(`first${HOSTILE}`, 0, "```bynk\nfn first()\n```\n\nSee [next](#bynk-doc-link-0).", true, [{ kind: "entry", entry: 1 }]),
        entry("second", 1, "```bynk\nfn second()\n```", false),
        entry(
          "third",
          7,
          `\`\`\`bynk\nfn third()\n\`\`\`\n\n${HOSTILE}\n\n<b onclick="x()">raw</b>\n\n[bad](javascript:alert(1)) [web](https://example.com/x) [src](#bynk-doc-link-0) [ext](#bynk-doc-link-1)`,
          true,
          [
            { kind: "source", uri: "file:///other.bynk", range },
            { kind: "external", href: "javascript:alert(1)" },
          ],
        ),
      ],
    },
  };
}

describe("docview (jsdom)", () => {
  let dom: Dom;
  beforeEach(async () => {
    dom = setupDom({ __BYNK_DOC_MODEL__: docPayload() });
    dom.load("docview");
    await settle();
  });
  afterEach(() => dom.dispose());

  it("renders the header, the lede and one section per entry at its depth", () => {
    assert.strictEqual(dom.root.querySelector("header h1 .kind")?.textContent, "context");
    assert.ok(dom.root.querySelector("header .body")?.textContent?.includes("Lede"));
    const sections = [...dom.root.querySelectorAll<HTMLElement>("section.entry")];
    assert.deepStrictEqual(
      sections.map((s) => s.firstElementChild?.tagName),
      ["H2", "H3", "H4"],
    );
    assert.deepStrictEqual(
      sections.map((s) => s.dataset.documented),
      ["true", "false", "true"],
    );
    assert.strictEqual(sections[1].style.marginLeft, "16px");
    assert.strictEqual(sections[1].querySelector(".no-doc")?.textContent, "No documentation");
    assert.strictEqual(sections[0].querySelector(".no-doc"), null);
    assert.ok(sections[0].querySelector(".body pre code"));
  });

  it("renders names, doc prose and raw HTML as text, never as elements", () => {
    noMarkup(dom.root);
    assert.strictEqual(dom.root.querySelectorAll("b").length, 0);
    const text = dom.root.textContent ?? "";
    assert.ok(text.includes(HOSTILE));
    assert.ok(text.includes('<b onclick="x()">raw</b>'));
  });

  it("reveals source on a heading click and routes links through the host", () => {
    const sections = [...dom.root.querySelectorAll<HTMLElement>("section.entry")];
    (sections[0].querySelector("h2") as HTMLElement).click();
    assert.deepStrictEqual(dom.posted.slice(-1), [{ type: "reveal", uri: "file:///doc.bynk", range }]);

    const links = [...sections[2].querySelectorAll("a")];
    // `javascript:` is not a link markdown-it makes, so it is not an anchor.
    assert.ok(!links.some((a) => (a.getAttribute("href") ?? "").startsWith("javascript:")));
    const click = (label: string): void => {
      const a = links.find((l) => l.textContent === label);
      assert.ok(a, label);
      a.click();
    };
    dom.posted.length = 0;
    click("web");
    click("src");
    // A resolved external link whose href isn't http(s) is never posted.
    click("ext");
    assert.deepStrictEqual(dom.posted, [
      { type: "openExternal", href: "https://example.com/x" },
      { type: "reveal", uri: "file:///other.bynk", range },
    ]);
  });

  it("scrolls to a resolved entry link, un-hiding the section first", () => {
    const root = dom.root;
    const target = dom.document.getElementById("entry-1") as HTMLElement;
    let scrolled = 0;
    target.scrollIntoView = () => void scrolled++;
    const toggle = root.querySelector(".toggle input") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event("change"));
    assert.strictEqual(root.dataset.hideUndocumented, "true");
    (root.querySelector("section#entry-0 a") as HTMLElement).click();
    assert.strictEqual(scrolled, 1);
    assert.strictEqual(root.dataset.hideUndocumented, "false");
    assert.strictEqual(toggle.checked, false);
  });

  it("keeps the reader's toggle across a live update", async () => {
    const toggle = dom.root.querySelector(".toggle input") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event("change"));
    dom.post({ type: "update", payload: docPayload(), view: { target: { uri: "file:///doc.bynk" }, followsCursor: false } });
    await settle();
    assert.strictEqual((dom.root.querySelector(".toggle input") as HTMLInputElement).checked, true);
  });

  it("says so for an empty unit and for no payload", async () => {
    const payload = docPayload();
    payload.model.entries = [];
    dom.post({ type: "update", payload, view: { target: { uri: "file:///doc.bynk" }, followsCursor: false } });
    await settle();
    assert.strictEqual(dom.root.querySelector("p.no-doc")?.textContent, "This unit declares nothing to document.");
    dom.post({ type: "update", payload: null, view: { target: { uri: "file:///doc.bynk" }, followsCursor: false } });
    await settle();
    assert.strictEqual(dom.root.textContent, "No documentation to render.");
  });
});

function statePayload(): AgentStatePayload {
  const violation = { transition: `t${HOSTILE}`, range, certainty: "Known" as const, from: ["Open"], targets: ["Closed"] };
  return {
    uri: "file:///agent.bynk",
    model: {
      agent: `Cart${HOSTILE}`,
      range,
      handlers: [
        { name: `close${HOSTILE}`, range },
        { name: "peek", range },
      ],
      machines: [
        {
          field: `status${HOSTILE}`,
          fieldRange: range,
          states: ["Open", "Closed", "Orphan"],
          initial: "Open",
          edges: [
            {
              handler: `close${HOSTILE}`,
              from: ["Open"],
              guards: [`x > ${HOSTILE}`],
              to: { kind: "State", state: "Closed" },
              outcome: null,
              range,
              violations: [violation],
            },
          ],
          reachable: ["Open", "Closed"],
          truncated: ["peek"],
          notEvaluated: [{ name: `weird${HOSTILE}`, range }],
        },
        { field: "other", fieldRange: range, states: ["A"], initial: "A", edges: [], reachable: ["A"], truncated: [], notEvaluated: [] },
      ],
      effects: [
        {
          handler: `close${HOSTILE}`,
          truncated: false,
          rows: [
            {
              guards: [],
              writes: [{ field: "status", op: ":=", key: null, range }],
              reads: [`r${HOSTILE}`],
              calls: ["audit"],
              outcomes: [],
            },
          ],
        },
        { handler: "peek", truncated: true, rows: [] },
      ],
    },
  };
}

describe("state view (jsdom)", () => {
  let dom: Dom;
  const open = async (payload: AgentStatePayload | null = statePayload()): Promise<void> => {
    dom = setupDom({ __BYNK_AGENT_STATE__: payload, __BYNK_VIEW__: { target: { uri: "file:///agent.bynk" }, followsCursor: true, focus: "peek" } });
    dom.load("state");
    await settle();
  };
  afterEach(() => dom.dispose());

  it("renders the controls, the handler-by-state table, the legend and the effects", async () => {
    await open();
    assert.strictEqual(dom.mermaid.calls.length, 1);
    assert.ok(dom.root.querySelector("select#bynk-state-field"));
    assert.deepStrictEqual(
      [...dom.root.querySelectorAll("select option")].map((o) => (o as HTMLOptionElement).value).slice(1),
      ["other"],
    );
    const heads = [...dom.root.querySelectorAll("table.states:not(.effects-table) thead th")];
    assert.deepStrictEqual(
      heads.map((h) => h.textContent),
      ["Handler \\ state", "Open", "Closed", "Orphan"],
    );
    assert.strictEqual(heads[1].getAttribute("title"), "Initial state");
    assert.ok(heads[3].classList.contains("unreachable"));
    const rows = [...dom.root.querySelectorAll("table.states:not(.effects-table) tbody tr")];
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1].querySelector("td")?.textContent, "too many paths");
    assert.ok(rows[0].querySelector(".entry.flag-known"));
    assert.ok(dom.root.querySelector(".legend .flag-known"));
    assert.strictEqual(dom.root.querySelectorAll("details.effects-details .effects").length, 2);
    assert.strictEqual(dom.root.querySelector(".effects-table tbody td:first-child")?.textContent, "always");
  });

  it("renders every payload string as text, never as elements", async () => {
    await open();
    noMarkup(dom.root);
    assert.ok((dom.root.textContent ?? "").includes(HOSTILE));
    // The diagram's failure text is the thrown message, shown as text too.
    dom.mermaid.fail = new Error(HOSTILE);
    dom.post({ type: "update", payload: statePayload(), view: { target: { uri: "file:///agent.bynk" }, followsCursor: true } });
    await settle();
    const holder = dom.root.querySelector(".diagram") as HTMLElement;
    assert.ok(holder.textContent?.startsWith("Failed to render diagram: "));
    noMarkup(dom.root);
  });

  it("marks the focused handler and reveals source on a click", async () => {
    await open();
    assert.deepStrictEqual(
      [...dom.root.querySelectorAll("tr.focus, .effects.focus")].map((e) => (e as HTMLElement).dataset.handler),
      ["peek", "peek"],
    );
    (dom.root.querySelector("tr[data-handler] a") as HTMLElement).click();
    assert.deepStrictEqual(dom.posted.slice(-1), [{ type: "reveal", uri: "file:///agent.bynk", range }]);
  });

  it("redraws through the shared queue when the field is switched", async () => {
    await open();
    const select = dom.root.querySelector("select") as HTMLSelectElement;
    select.value = "other";
    select.dispatchEvent(new dom.window.Event("change"));
    await settle();
    assert.strictEqual(dom.mermaid.calls.length, 2);
    assert.ok(dom.mermaid.calls[1].text.includes("A"));
    assert.strictEqual(dom.root.querySelectorAll("table.states:not(.effects-table) thead th").length, 2);
  });

  it("falls back to the effects alone for an agent with no state machine", async () => {
    const payload = statePayload();
    payload.model.machines = [];
    await open(payload);
    assert.strictEqual(dom.mermaid.calls.length, 0);
    assert.ok(dom.root.textContent?.includes("No state machine"));
    assert.strictEqual(dom.root.querySelectorAll(".effects").length, 2);
  });

  it("says so when there is no agent at the cursor", async () => {
    await open(null);
    assert.strictEqual(dom.root.textContent, "No agent at the cursor.");
  });
});

function archPayload(): ArchPayload {
  const loc = { uri: "file:///a.bynk", range };
  return {
    model: {
      nodes: [
        {
          name: "Billing",
          kind: "Context",
          loc,
          capabilities: [{ name: "Clock", local: true, from: null, loc }],
          providers: [],
          services: [],
          agents: [],
        },
        { name: `Other${HOSTILE}`, kind: "Adapter", loc: { uri: "file:///b.bynk", range }, capabilities: [], providers: [], services: [], agents: [] },
      ],
      edges: [],
    },
  };
}

describe("architecture view (jsdom)", () => {
  let dom: Dom;
  const open = async (payload: ArchPayload | null = archPayload()): Promise<void> => {
    dom = setupDom({ __BYNK_ARCH_MODEL__: payload });
    dom.mermaid.svg =
      '<svg><g id="m-flowchart-ctx0-1"></g><g id="m-flowchart-ctx0_t-2"></g><g id="m-flowchart-ctx1-3"></g></svg>';
    dom.load("architecture");
    await settle();
  };
  afterEach(() => dom.dispose());

  it("embeds the diagram and wires a box to reveal and the toggle to expand", async () => {
    await open();
    assert.strictEqual(dom.mermaid.calls.length, 1);
    (dom.root.querySelector('[id*="flowchart-ctx0-"]') as HTMLElement).dispatchEvent(new dom.window.Event("click"));
    assert.deepStrictEqual(dom.posted.slice(-1), [{ type: "reveal", uri: "file:///a.bynk", range }]);

    assert.ok(!dom.mermaid.calls[0].text.includes("Clock"));
    (dom.root.querySelector('[id*="flowchart-ctx0_t-"]') as HTMLElement).dispatchEvent(new dom.window.Event("click"));
    await settle();
    assert.strictEqual(dom.mermaid.calls.length, 2);
    assert.ok(dom.mermaid.calls[1].text.includes("Clock"));
    assert.notStrictEqual(dom.mermaid.calls[0].id, dom.mermaid.calls[1].id);
  });

  it("shows a failed render, and a payload string, as text", async () => {
    await open();
    dom.mermaid.fail = new Error(HOSTILE);
    dom.post({ type: "update", payload: archPayload(), view: { target: { uri: "file:///a.bynk" }, followsCursor: false } });
    await settle();
    assert.ok(dom.root.textContent?.startsWith("Failed to render diagram: "));
    noMarkup(dom.root);
    // The node name carrying markup is escaped into the diagram source.
    assert.ok(dom.mermaid.calls[0].text.includes("Other"));
  });

  it("says so when the project has no contexts", async () => {
    await open({ model: { nodes: [], edges: [] } });
    assert.strictEqual(dom.mermaid.calls.length, 0);
    assert.strictEqual(dom.root.textContent, "No contexts found in this project.");
  });
});

function refinedPayload(base: "Int" | "String" = "String"): RefinedPayload {
  return {
    model: {
      name: `Code${HOSTILE}`,
      base,
      opaque: true,
      declaration: `type Code = ${HOSTILE}`,
      clauses: [{ source: `Matches(${HOSTILE})`, description: `a ${HOSTILE}`, predicate: { kind: "nonEmpty" }, message: "m" }],
      examples: [`ex${HOSTILE}`, "plain"],
      examplesNote: `note ${HOSTILE}`,
      seed: 1,
    },
  };
}

describe("refined type explorer (jsdom)", () => {
  let dom: Dom;
  const open = (payload: RefinedPayload | null = refinedPayload()): void => {
    dom = setupDom({ __BYNK_REFINED__: payload });
    dom.load("refinedExplorer");
  };
  afterEach(() => dom.dispose());

  it("renders the declaration, the clauses, the example chips and the input", () => {
    open();
    assert.strictEqual(dom.root.querySelector("h1 .rx-kind")?.textContent, " opaque refined type");
    assert.strictEqual(dom.root.querySelectorAll(".rx-clauses li").length, 1);
    assert.deepStrictEqual(
      [...dom.root.querySelectorAll(".rx-chip")].map((c) => c.textContent),
      [JSON.stringify(`ex${HOSTILE}`), JSON.stringify("plain")],
    );
    assert.strictEqual((dom.root.querySelector("#rx-input") as HTMLInputElement).placeholder, "Type a string…");
    assert.ok(dom.root.querySelector(".rx-verdict[role=status]"));
  });

  it("renders the name, declaration, clauses and examples as text, never as elements", () => {
    open();
    noMarkup(dom.root);
    assert.ok((dom.root.textContent ?? "").includes(HOSTILE));
  });

  it("asks the host to check a chip's text and shows only the verdict for the latest text", () => {
    open(refinedPayload("Int"));
    assert.strictEqual((dom.root.querySelector("#rx-input") as HTMLInputElement).placeholder, "Type an Int…");
    const chip = dom.root.querySelectorAll<HTMLButtonElement>(".rx-chip")[1];
    chip.click();
    assert.deepStrictEqual(dom.posted, [{ type: "check", text: "plain" }]);
    const verdict = dom.root.querySelector(".rx-verdict") as HTMLElement;

    dom.post({ type: "verdict", text: "stale", verdict: { kind: "valid" } });
    assert.strictEqual(verdict.textContent, "");
    dom.post({ type: "verdict", text: "plain", verdict: { kind: "valid" } });
    assert.ok(verdict.classList.contains("rx-ok"));
    dom.post({
      type: "verdict",
      text: "plain",
      verdict: { kind: "invalid", failures: [{ source: `S${HOSTILE}`, message: `bad ${HOSTILE}` }] },
    });
    assert.ok(verdict.classList.contains("rx-bad"));
    assert.strictEqual(verdict.querySelectorAll("li").length, 1);
    dom.post({ type: "verdict", text: "plain", verdict: { kind: "unreadable", message: HOSTILE } });
    assert.strictEqual(verdict.textContent, `✗ ${HOSTILE}`);
    noMarkup(dom.root);
    dom.post({
      type: "verdict",
      text: "plain",
      verdict: { kind: "unchecked", failures: [], unchecked: [{ source: `U${HOSTILE}`, reason: `needs ${HOSTILE}` }] },
    });
    assert.ok(verdict.classList.contains("rx-bad"));
    assert.ok(String(verdict.textContent).includes("could not be checked"));
    noMarkup(dom.root);
    dom.post({ type: "verdict", text: "plain", verdict: { kind: "timeout" } });
    assert.ok(String(verdict.textContent).includes("too long"));
  });

  it("says so when there is no model", () => {
    open(null);
    assert.strictEqual(dom.root.textContent, "No refined type to explore.");
  });
});
