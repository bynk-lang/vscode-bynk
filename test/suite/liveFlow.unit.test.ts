// Unit tests for the live panel's request ordering (#32), driven with
// controllable promises: a later request must never be overwritten by an
// earlier one that resumes after it.

import * as assert from "assert";

import { FlowScope, FlowTarget, LiveFlow } from "../../src/liveFlow";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  it("does not let a failed retarget supersede a newer show with a re-issue", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    const refreshed = h.flow.refresh();
    const followed = h.flow.retarget(at("agent"), {});
    const shown = h.flow.show(at("b"));
    h.requests[1].d.reject(new Error("boom"));
    await followed;
    assert.strictEqual(h.requests.length, 3, "no refresh was issued over the show");
    h.requests[2].d.resolve("B");
    await tick();
    h.lookups[0].d.resolve({});
    await shown;
    h.requests[0].d.resolve("A");
    await refreshed;
    assert.deepStrictEqual(h.rendered, ["B"]);
    assert.strictEqual(h.flow.target?.uri, "b");
  });

  it("re-issues a lost refresh when the retarget has no client yet", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    void h.flow.refresh();
    const followed = h.flow.retarget(at("b"), {});
    h.requests[1].d.resolve(undefined);
    assert.strictEqual(await followed, "empty");
    assert.strictEqual(h.requests.length, 3);
    assert.strictEqual(h.requests[2].uri, "a");
  });

  it("re-issues a lost refresh when a show finds nothing", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    void h.flow.refresh();
    const shown = h.flow.show(at("b"));
    h.requests[1].d.resolve(null);
    await shown;
    assert.strictEqual(h.requests.length, 3);
    assert.strictEqual(h.requests[2].uri, "a");
  });

  it("re-issues a lost refresh when a show fails", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    void h.flow.refresh();
    const shown = h.flow.show(at("b"));
    h.requests[1].d.reject(new Error("boom"));
    await shown;
    assert.strictEqual(h.requests.length, 3);
  });

  it("does not let a refresh cancel a show in flight", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    const shown = h.flow.show(at("b"));
    await h.flow.refresh(); // dropped while the show runs
    assert.strictEqual(h.requests.length, 1);
    h.requests[0].d.resolve("B");
    await tick();
    h.lookups[0].d.resolve({});
    await shown;
    assert.deepStrictEqual(h.rendered, ["B"]);
    assert.strictEqual(h.flow.target?.uri, "b");
  });

  it("redoes the refresh it dropped when the show ends without rendering", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    const shown = h.flow.show(at("b"));
    await h.flow.refresh();
    h.requests[0].d.resolve(null);
    await shown;
    assert.strictEqual(h.requests.length, 2);
    assert.strictEqual(h.requests[1].uri, "a");
  });

  it("redoes a refresh deferred behind a show that a retarget then superseded", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    const shown = h.flow.show(at("b"));
    void h.flow.refresh(); // deferred: the show is the newest request
    const followed = h.flow.retarget(at("agent"), {});
    h.requests[1].d.resolve(null); // the follow has no model: the refresh is owed
    assert.strictEqual(await followed, "empty");
    assert.strictEqual(h.requests.length, 3, "re-issued, not deferred again");
    assert.strictEqual(h.requests[2].uri, "a");
    h.requests[0].d.resolve("B"); // the superseded show drops out
    await shown;
    assert.deepStrictEqual(h.rendered, []);
  });

  it("refreshes after a show when an edit arrived after its request began", async () => {
    const h = harness();
    h.openPanel();
    h.flow.target = at("a");
    const shown = h.flow.show(at("b"));
    await h.flow.refresh(); // an edit: deferred behind the show
    h.requests[0].d.resolve("B");
    await tick();
    h.lookups[0].d.resolve({});
    await shown;
    assert.deepStrictEqual(h.rendered, ["B"]);
    assert.strictEqual(h.requests.length, 2, "the stale render is followed by a refresh");
    assert.strictEqual(h.requests[1].uri, "b");
    assert.strictEqual(h.requests[1].fresh, false);
  });
});
