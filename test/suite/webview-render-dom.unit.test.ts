// #45: the exported DOM renderers (`renderWireContract`, `renderContractDiff`)
// run against fixture payloads in jsdom. The structure is asserted, and that a
// name, hash, message or reason carrying markup lands as text, never as an
// element: those strings come from the server and the workspace.

import * as assert from "assert";

import type { CdPayload } from "../../src/webview/contractDiffTypes";
import type { WcPayload, WcRef } from "../../src/webview/wireContractTypes";
import { HOSTILE, setupDom, type Dom } from "./domHarness";

const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } };
const str: WcRef = { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } };

function wirePayload(): WcPayload {
  return {
    uri: "file:///a.bynk",
    model: {
      unit: `Unit${HOSTILE}`,
      service: "Billing",
      kind: { kind: "Http", method: "POST", path: `/pay/${HOSTILE}` },
      range,
      handlerLine: 7,
      envelope: {
        kind: "Keyed",
        params: [
          { name: `who${HOSTILE}`, shape: { kind: "Named", name: "Client" } },
          { name: "tags", shape: { kind: "Inst", key: "list" } },
        ],
      },
      contract: { normalForm: `call(${HOSTILE})`, hash: `h${HOSTILE}` },
      types: [
        {
          name: "Client",
          codecSuffix: "Record",
          provenance: { kind: "Consumed", ownerUnit: `Other${HOSTILE}` },
          body: {
            kind: "Record",
            fields: [
              { name: `id${HOSTILE}`, shape: str, pathSegment: "id", default: `"${HOSTILE}"` },
              { name: "self", shape: { kind: "Named", name: "Client" }, pathSegment: "self", default: null },
            ],
          },
          loc: { uri: "file:///b.bynk", range },
        },
        {
          name: "Code",
          codecSuffix: "Scalar",
          provenance: { kind: "Owned" },
          body: {
            kind: "Scalar",
            base: "String",
            json: "String",
            opaque: true,
            predicates: [`Matches(${HOSTILE})`],
            baseGuards: [],
            revalidation: "StructuralOnly",
          },
          loc: null,
        },
        {
          name: "Shape",
          codecSuffix: "Sum",
          provenance: { kind: "Owned" },
          body: {
            kind: "Sum",
            wireDiscriminant: `k${HOSTILE}`,
            memoryDiscriminant: "kind",
            variants: [
              { name: `Circle${HOSTILE}`, payload: [{ name: "r", shape: str, pathSegment: "r", default: null }] },
              { name: "Empty", payload: [] },
            ],
          },
          loc: null,
        },
      ],
      instantiations: [{ kind: "ListInst", key: "list", elem: { kind: "Named", name: "Code" } }],
      recursive: ["Client"],
      responses: [
        { status: 200, variant: "Ok", origin: { kind: "DeclaredSuccess" } },
        { status: 402, variant: `Declined${HOSTILE}`, origin: { kind: "Constructed", range } },
        { status: 400, variant: "BadRequest", origin: { kind: "BoundaryImplicit", why: `why${HOSTILE}` } },
      ],
      noCrossContext: null,
    },
  };
}

describe("renderWireContract (jsdom)", () => {
  let dom: Dom;
  let reveals: Array<{ uri: string; range: unknown }>;
  const render = (payload: WcPayload): HTMLElement => {
    const { renderWireContract } = dom.load<typeof import("../../src/webview/wire-render")>("wire-render");
    renderWireContract(dom.root, payload, (uri, r) => reveals.push({ uri, range: r }));
    return dom.root;
  };
  beforeEach(() => {
    dom = setupDom();
    reveals = [];
  });
  afterEach(() => dom.dispose());

  it("renders the header, cards, responses and one block per boundary type", () => {
    const root = render(wirePayload());
    assert.deepStrictEqual(
      [...root.querySelectorAll("h2")].map((h) => h.textContent),
      ["Contract", "Request", "Responses", "Boundary types"],
    );
    assert.strictEqual(root.querySelectorAll("tbody tr").length, 3);
    assert.deepStrictEqual(
      [...root.querySelectorAll("details.wc-type")].map((d) => d.id),
      ["wc-type-Client", "wc-type-Code", "wc-type-Shape"],
    );
    assert.ok(root.querySelector("h1")?.textContent?.includes("line 7"));
    // Consumed provenance and the recursive marker show on the right blocks.
    const client = root.querySelector("#wc-type-Client summary")?.textContent ?? "";
    assert.ok(client.includes("consumed from Other") && client.includes("(recursive)"));
    assert.ok(!(root.querySelector("#wc-type-Code summary")?.textContent ?? "").includes("(recursive)"));
  });

  it("labels a scalar whose predicates are not re-checked here", () => {
    const root = render(wirePayload());
    const badges = root.querySelectorAll("#wc-type-Code .wc-badge-opaque");
    assert.strictEqual(badges.length, 1);
    assert.ok(root.querySelector("#wc-type-Code")?.textContent?.includes("declared upstream (not re-checked here)"));
  });

  it("wires click-to-code and the type chips", () => {
    const root = render(wirePayload());
    (root.querySelector("h1") as HTMLElement).click();
    (root.querySelector("#wc-type-Client summary") as HTMLElement).click();
    (root.querySelector("tr.wc-row-clickable") as HTMLElement).click();
    assert.deepStrictEqual(
      reveals.map((r) => r.uri),
      ["file:///a.bynk", "file:///b.bynk", "file:///a.bynk"],
    );
    // A type without a location has no click target; the muted rows have none.
    assert.strictEqual(root.querySelectorAll("tr.wc-row-muted").length, 1);
    const chips = [...root.querySelectorAll<HTMLAnchorElement>("a.type-chip")];
    assert.ok(chips.some((c) => c.getAttribute("href") === "#wc-type-Client"));
    // A chip opens its target's block (jsdom has no layout, so stub the scroll).
    const code = root.querySelector("#wc-type-Code") as HTMLDetailsElement;
    code.open = false;
    code.scrollIntoView = () => undefined;
    chips.find((c) => c.getAttribute("href") === "#wc-type-Code")?.click();
    assert.strictEqual(code.open, true);
  });

  it("renders server-supplied strings as text, never as elements", () => {
    const root = render(wirePayload());
    for (const tag of ["img", "script"]) {
      assert.strictEqual(root.querySelectorAll(tag).length, 0, `a <${tag}> was created`);
    }
    // And the text itself is all there.
    const text = root.textContent ?? "";
    for (const where of ["Unit", "/pay/", "who", "call(", "Matches(", "Circle", "Declined", "why", "id"]) {
      assert.ok(text.includes(`${where}${HOSTILE}`) || text.includes(where), where);
    }
    assert.ok(text.includes(HOSTILE), "the hostile string appears verbatim as text");
    assert.ok(!root.innerHTML.includes("<img"), "no raw <img in the serialised page");
  });

  it("explains a handler with no cross-context contract instead of a hash", () => {
    const payload = wirePayload();
    payload.model.contract = null;
    payload.model.noCrossContext = "SingleContext";
    payload.model.responses = [];
    payload.model.types = [];
    const root = render(payload);
    assert.ok(!root.querySelector(".wc-hash"));
    assert.deepStrictEqual(
      [...root.querySelectorAll("h2")].map((h) => h.textContent),
      ["Contract", "Request"],
    );
  });

  it("clears the previous render", () => {
    render(wirePayload());
    render(wirePayload());
    assert.strictEqual(dom.root.querySelectorAll("h1").length, 1);
  });
});

function diffPayload(): CdPayload {
  return {
    uri: "file:///a.bynk",
    model: {
      lock: "read",
      ledger: "read",
      changes: [
        {
          kind: "event",
          unit: `u${HOSTILE}`,
          name: "Placed",
          class: "breaking",
          lockedVersion: 2,
          detail: `field removed ${HOSTILE}`,
          loc: { uri: "file:///e.bynk", range },
        },
        { kind: "agent", unit: "u", name: "Cart", class: "compatible", lockedVersion: 1, detail: "field added", loc: null },
      ],
      services: [
        {
          environment: "prod",
          context: `ctx${HOSTILE}`,
          service: "Billing",
          status: "changed",
          live: "abcdef0123",
          current: "0123456789",
          compat: {
            verdict: "breaking",
            reasons: [`breaking a: ${HOSTILE}`, "b", "c", "d", "e"],
          },
          loc: { uri: "file:///s.bynk", range },
        },
        { environment: "prod", context: "c", service: "Q", status: "added", live: null, current: "99999999aa", loc: null },
      ],
    },
  };
}

describe("renderContractDiff (jsdom)", () => {
  let dom: Dom;
  let reveals: string[];
  const render = (payload: CdPayload): HTMLElement => {
    const { renderContractDiff } = dom.load<typeof import("../../src/webview/contract-diff-render")>(
      "contract-diff-render",
    );
    renderContractDiff(dom.root, payload, (uri) => reveals.push(uri));
    return dom.root;
  };
  beforeEach(() => {
    dom = setupDom();
    reveals = [];
  });
  afterEach(() => dom.dispose());

  it("renders a summary, a change table and a service table", () => {
    const root = render(diffPayload());
    assert.strictEqual(root.querySelector("h1")?.textContent, "Contract Diff");
    assert.strictEqual(root.querySelector(".cd-summary")?.textContent, "1 breaking, 1 compatible schema changes; 2 service contracts changed (1 breaking).");
    const [changes, services] = [...root.querySelectorAll("table")];
    assert.strictEqual(changes.querySelectorAll("tr.cd-breaking").length, 1);
    assert.strictEqual(changes.querySelectorAll("tr.cd-compatible").length, 1);
    assert.strictEqual(services.querySelectorAll("tr").length, 2);
  });

  it("folds reasons past the limit behind a details element", () => {
    const root = render(diffPayload());
    const row = root.querySelectorAll("table")[1].querySelector("tr");
    assert.ok(row);
    assert.strictEqual(row.querySelectorAll(".cd-detail > .cd-reason").length, 3);
    const more = row.querySelector("details.cd-more");
    assert.strictEqual(more?.querySelector("summary")?.textContent, "2 more");
    assert.strictEqual(more?.querySelectorAll("div.cd-reason").length, 2);
  });

  it("reveals a row's location when clicked, and only rows that have one", () => {
    const root = render(diffPayload());
    const clickable = [...root.querySelectorAll<HTMLElement>("tr.cd-clickable")];
    assert.strictEqual(clickable.length, 2);
    clickable.forEach((r) => r.click());
    assert.deepStrictEqual(reveals, ["file:///e.bynk", "file:///s.bynk"]);
  });

  it("renders names, details and reasons as text, never as elements", () => {
    const root = render(diffPayload());
    assert.strictEqual(root.querySelectorAll("img, script").length, 0);
    assert.ok((root.textContent ?? "").includes(HOSTILE));
  });

  it("says why there is nothing to compare when a lock is missing", () => {
    const payload = diffPayload();
    payload.model.lock = "absent";
    payload.model.ledger = "absent";
    payload.model.services = [];
    const root = render(payload);
    assert.strictEqual(root.querySelectorAll("table").length, 0);
    assert.ok(root.textContent?.includes("There is no bynk.schema.lock"));
    assert.ok(root.textContent?.includes("There is no bynk.deploy.lock"));
  });
});
