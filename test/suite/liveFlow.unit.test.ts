// Unit tests for the live panel's request ordering (#32), driven with
// controllable promises: a later request must never be overwritten by an
// earlier one that resumes after it.

import * as assert from "assert";

import { FlowScope, FlowTarget, LiveFlow } from "../../src/liveFlow";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

const at = (uri: string): FlowTarget => ({ uri, position: { line: 1, character: 0 } });

/** A flow wired to scripted requests and scope lookups. */
function harness() {
  const requests: { uri: string; fresh: boolean; d: Deferred<string | null | undefined> }[] = [];
  const lookups: { uri: string; d: Deferred<FlowScope> }[] = [];
  const rendered: (string | null)[] = [];
  let open = false;
  let loaded = false;
  const flow: LiveFlow<string, FlowTarget> = new LiveFlow<string, FlowTarget>({
    request: (target, fresh) => {
      const d = deferred<string | null | undefined>();
      requests.push({ uri: target.uri, fresh, d });
      return d.promise;
    },
    lookup: (target) => {
      const d = deferred<FlowScope>();
      lookups.push({ uri: target.uri, d });
      return d.promise;
    },
    panel: () => (open ? "panel" : undefined),
    visible: () => open,
    pageLoaded: () => loaded,
    ensurePanel: () => {
      open = true;
    },
    render: (payload) => {
      loaded = true;
      rendered.push(payload);
    },
    reveal: () => {},
    setDirty: () => {},
    onError: () => {},
    onMiss: () => {},
    onRefresh: () => {},
    onNullRefresh: () => {},
  });
  return {
    flow,
    requests,
    lookups,
    rendered,
    openPanel: () => {
      open = true;
    },
  };
}

describe("LiveFlow", () => {
  it("drops a show that was superseded while its request was in flight", async () => {
    const h = harness();
    const first = h.flow.show(at("a"));
    const second = h.flow.show(at("b"));
    h.requests[1].d.resolve("B");
    await tick();
    h.lookups[0].d.resolve({ handler: "b" });
    await second;
    h.requests[0].d.resolve("A");
    await first;
    assert.deepStrictEqual(h.rendered, ["B"]);
    assert.strictEqual(h.flow.target?.uri, "b");
    assert.strictEqual(h.lookups.length, 1, "the stale show never reached its lookup");
  });

  it("drops a show that was superseded while its scope lookup was pending", async () => {
    const h = harness();
    const first = h.flow.show(at("a"));
    h.requests[0].d.resolve("A");
    await tick();
    const second = h.flow.show(at("b"));
    h.requests[1].d.resolve("B");
    await tick();
    h.lookups[1].d.resolve({ handler: "b" });
    await second;
    h.lookups[0].d.resolve({ handler: "a" }); // the older lookup lands last
    await first;
    assert.deepStrictEqual(h.rendered, ["B"]);
    assert.strictEqual(h.flow.target?.uri, "b");
    assert.strictEqual(h.flow.handler, "b");
  });

  it("does not let a stale restore lookup overwrite a newer show", async () => {
    const h = harness();
    h.openPanel();
    const restored = h.flow.restore(at("old"));
    const shown = h.flow.show(at("new"));
    h.requests[0].d.resolve("NEW");
    await tick();
    h.lookups[1].d.resolve({ handler: "new" });
    await shown;
    h.lookups[0].d.resolve({ handler: "old" });
    await restored;
    assert.strictEqual(h.flow.handler, "new");
    assert.strictEqual(h.requests.length, 1, "the stale restore never refreshed");
  });

  it("re-issues a refresh that a model-less retarget superseded", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    const refreshed = h.flow.refresh();
    const followed = h.flow.retarget(at("agent"), { handler: "agent" });
    h.requests[1].d.resolve(null); // the follow finds no model
    assert.strictEqual(await followed, "empty");
    assert.strictEqual(h.requests.length, 3, "the refresh was re-issued");
    assert.strictEqual(h.requests[2].uri, "a", "for the current target");
    h.requests[0].d.resolve("STALE"); // the superseded refresh lands, and is dropped
    await refreshed;
    assert.deepStrictEqual(h.rendered, []);
    h.requests[2].d.resolve("SAVED");
    await tick();
    assert.deepStrictEqual(h.rendered, ["SAVED"]);
  });

  it("re-issues when the refresh answered before the model-less retarget did", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    const refreshed = h.flow.refresh();
    const followed = h.flow.retarget(at("agent"), { handler: "agent" });
    h.requests[0].d.resolve("SAVED"); // dropped: the retarget is newer
    await refreshed;
    assert.deepStrictEqual(h.rendered, []);
    h.requests[1].d.resolve(null);
    assert.strictEqual(await followed, "empty");
    assert.strictEqual(h.requests.length, 3);
    h.requests[2].d.resolve("SAVED");
    await tick();
    assert.deepStrictEqual(h.rendered, ["SAVED"]);
  });

  it("does not re-issue when the superseding retarget renders", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    const refreshed = h.flow.refresh();
    const followed = h.flow.retarget(at("b"), { handler: "b" });
    h.requests[1].d.resolve("B");
    assert.strictEqual(await followed, "applied");
    h.requests[0].d.resolve("A");
    await refreshed;
    assert.strictEqual(h.requests.length, 2);
    assert.deepStrictEqual(h.rendered, ["B"]);
  });

  it("reports a retarget superseded by a newer one", async () => {
    const h = harness();
    h.openPanel();
    const first = h.flow.retarget(at("a"), {});
    const second = h.flow.retarget(at("b"), {});
    h.requests[1].d.resolve("B");
    assert.strictEqual(await second, "applied");
    h.requests[0].d.resolve("A");
    assert.strictEqual(await first, "superseded");
    assert.deepStrictEqual(h.rendered, ["B"]);
  });
});
