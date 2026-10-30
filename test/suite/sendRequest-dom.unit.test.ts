// #67: the Send Request page in jsdom: the form, the sends it posts, and which
// of the host's answers it takes. Server- and workspace-derived strings must
// land as text, never as elements.

import * as assert from "assert";

import type { SrPayload } from "../../src/sendRequestCore";
import { HOSTILE, setupDom, settle, type Dom } from "./domHarness";

const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } };

function payload(over: Partial<SrPayload> = {}): SrPayload {
  return {
    uri: "file:///p/shop.bynk",
    key: "shop PUT /items/:id",
    unit: "shop",
    service: `api${HOSTILE}`,
    range,
    form: { method: "PUT", path: "/items/:id", pathParams: ["id"], body: { kind: "json", skeleton: "{}" }, readsHeaders: false },
    target: { kind: "ready", url: "http://localhost:8787" },
    ...over,
  };
}

type Posted = { type: string; key?: string; id?: number; input?: { path: Record<string, string> } };

describe("Send Request page (jsdom)", () => {
  let dom: Dom;
  const open = async (p: SrPayload | null = payload()): Promise<void> => {
    dom = setupDom({ __BYNK_SEND_REQUEST__: p, __BYNK_VIEW__: { target: { uri: "file:///p/shop.bynk" }, followsCursor: true } });
    dom.load("sendRequest");
    await settle();
  };
  const sends = (): Posted[] => (dom.posted as Posted[]).filter((m) => m.type === "send");
  const button = (id: string) => dom.root.querySelector(`#${id}`) as HTMLButtonElement;
  const ctrlEnter = () =>
    dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
  afterEach(() => dom.dispose());

  it("draws the route's form, its names as text", async () => {
    await open();
    assert.strictEqual(dom.root.querySelector("h1")?.textContent, "PUT/items/:id");
    assert.ok(dom.root.querySelector("input[data-param=id]"));
    assert.strictEqual((dom.root.querySelector("#sr-body") as HTMLTextAreaElement).value, "{}");
    assert.strictEqual(dom.root.querySelectorAll("img, script").length, 0);
    assert.ok((dom.root.textContent ?? "").includes(HOSTILE));
  });

  it("offers to start the dev server, and won't send without one", async () => {
    await open(payload({ target: { kind: "stopped" } }));
    assert.ok(button("sr-send").disabled);
    ctrlEnter();
    assert.deepStrictEqual(sends(), []);
    [...dom.root.querySelectorAll("button")].find((b) => b.textContent === "Start Dev Server")!.click();
    assert.ok(dom.posted.some((m) => (m as Posted).type === "startDev"));
  });

  it("does not send again while the route's send is in flight, Ctrl+Enter included", async () => {
    await open();
    const input = dom.root.querySelector("input[data-param=id]") as HTMLInputElement;
    input.value = "a";
    input.dispatchEvent(new dom.window.Event("input"));
    button("sr-send").click();
    const [first] = sends();
    assert.deepStrictEqual(first.input?.path, { id: "a" });
    dom.post({ type: "sending", key: first.key, id: first.id });
    assert.ok(button("sr-send").disabled);
    assert.ok(!button("sr-cancel").hidden);
    ctrlEnter();
    assert.strictEqual(sends().length, 1, "no second send");
    button("sr-cancel").click();
    assert.deepStrictEqual(dom.posted.at(-1), { type: "cancel", key: first.key });
  });

  it("takes only the latest send's result for a route", async () => {
    await open();
    (dom.root.querySelector("input[data-param=id]") as HTMLInputElement).value = "a";
    const id = dom.root.querySelector("input[data-param=id]") as HTMLInputElement;
    id.dispatchEvent(new dom.window.Event("input"));
    button("sr-send").click();
    const old = sends()[0];
    // Rejected before sending (say the form was wrong): the next send is free.
    dom.post({ type: "result", key: old.key, id: old.id, result: { kind: "error", message: "Fill in :id." } });
    button("sr-send").click();
    const now = sends()[1];
    assert.notStrictEqual(now.id, old.id);
    dom.post({ type: "sending", key: now.key, id: now.id });
    // A late answer for the replaced send changes nothing.
    dom.post({ type: "result", key: old.key, id: old.id, result: { kind: "error", message: "Cancelled." } });
    assert.ok((dom.root.textContent ?? "").includes("Sending…"));
    assert.ok(button("sr-send").disabled);
    dom.post({
      type: "result",
      key: now.key,
      id: now.id,
      result: {
        kind: "response",
        method: "PUT",
        url: "http://localhost:8787/items/a",
        status: 201,
        statusText: `Created${HOSTILE}`,
        ms: 3,
        headers: [["x-a", HOSTILE]],
        body: HOSTILE,
        json: false,
        partial: "The body was still arriving after 30 s; this is what came.",
      },
    });
    assert.ok(!button("sr-send").disabled);
    assert.ok(dom.root.querySelector(".sr-status.ok"));
    assert.ok((dom.root.textContent ?? "").includes("still arriving"));
    assert.strictEqual(dom.root.querySelectorAll("img, script").length, 0);
  });

  it("keeps what was typed across an update of the same route", async () => {
    await open();
    const id = dom.root.querySelector("input[data-param=id]") as HTMLInputElement;
    id.value = "kept";
    id.dispatchEvent(new dom.window.Event("input"));
    dom.post({
      type: "update",
      payload: payload({ target: { kind: "ready", url: "http://localhost:9", note: "Rebuilding." } }),
      view: { target: { uri: "file:///p/shop.bynk" }, followsCursor: true },
    });
    await settle();
    assert.strictEqual(dom.root.querySelector("input[data-param=id]"), id, "the same input, so focus stays");
    assert.strictEqual(id.value, "kept");
    assert.strictEqual(dom.root.querySelector("#sr-url")?.textContent, "PUT http://localhost:9/items/kept");
    assert.ok((dom.root.textContent ?? "").includes("Rebuilding."));
  });
});
