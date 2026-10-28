// #2465: unit coverage for `chatCore` (src/chatCore.ts), the pure core of the
// `@bynk` chat participant, driven with a stubbed model — no extension host.

import * as assert from "assert";

import {
  type ChatDeps,
  type CheckOutcome,
  type ChatMsg,
  type EditorContext,
  type ModelPart,
  codesIn,
  firstCodeBlock,
  bynkBlocks,
  runCommand,
  sourcesIn,
} from "../../src/chatCore";
import type { CompileDiagnostic } from "../../src/richDiagnostics";

const EXPLANATION =
  "# `bynk.resolve.unknown_type`\n\nA type name is not in scope.\n\nBook: https://bynk-lang.org/book/reference/diagnostics/#bynk-resolve-unknown-type\n";

interface Stub {
  deps: ChatDeps;
  sent: ChatMsg[][];
  toolsOffered: (readonly string[])[];
  invoked: { name: string; input: object }[];
}

/** A model that replies with each script entry in turn. */
function stub(script: ModelPart[][], editor: EditorContext, tools: Record<string, string> = {}): Stub {
  const sent: ChatMsg[][] = [];
  const toolsOffered: (readonly string[])[] = [];
  const invoked: { name: string; input: object }[] = [];
  let turn = 0;
  const deps: ChatDeps = {
    model: {
      async send(messages, toolNames) {
        sent.push([...messages]);
        toolsOffered.push(toolNames);
        const parts = script[turn++] ?? [];
        return (async function* () {
          yield* parts;
        })();
      },
    },
    editor,
    async invokeTool(name, input) {
      invoked.push({ name, input });
      if (!(name in tools)) throw new Error(`no ${name}`);
      return tools[name];
    },
    hasTool: (name) => name in tools,
    modelTools: ["bynk_check"],
    isCancelled: () => false,
  };
  return { deps, sent, toolsOffered, invoked };
}

const text = (value: string): ModelPart => ({ kind: "text", value });

const broken: EditorContext = {
  file: "src/a.bynk",
  line: 3,
  diagnostics: [
    { path: "src/a.bynk", line: 3, column: 10, severity: "error", code: "bynk.resolve.unknown_type", message: "unknown type `Usr`" },
  ],
  lines: ["commons a", "", "fn f(u: Usr) -> Int {", "  1", "}"],
};

describe("chatCore (#2465)", () => {
  it("finds diagnostic codes and sources in text", () => {
    assert.deepStrictEqual(codesIn("see bynk.a.b and bynk.a.b, bynk.x_y"), ["bynk.a.b", "bynk.x_y"]);
    assert.deepStrictEqual(sourcesIn(EXPLANATION + "at src/a.bynk:3:10."), [
      "https://bynk-lang.org/book/reference/diagnostics/#bynk-resolve-unknown-type",
      "src/a.bynk:3:10",
    ]);
  });

  it("takes the first fenced block of a reply", () => {
    assert.strictEqual(firstCodeBlock("Because.\n```bynk\nfn f() {}\n```\nmore"), "fn f() {}");
    assert.strictEqual(firstCodeBlock("no code"), undefined);
  });

  it("/explain quotes the toolchain's explanation and cites the Book link", async () => {
    const s = stub([[text("The type `Usr` is not in scope.")]], broken, { bynk_explain_diagnostic: EXPLANATION });
    const out = await runCommand("explain", "", s.deps, () => {});
    assert.deepStrictEqual(s.invoked, [{ name: "bynk_explain_diagnostic", input: { code: "bynk.resolve.unknown_type" } }]);
    // The explanation reaches the model as material, ahead of its answer.
    const prompt = (s.sent[0][0] as { text: string }).text;
    assert.ok(prompt.includes("A type name is not in scope."));
    assert.ok(prompt.includes("Answer only from the MATERIAL"));
    const md = out.markdown.join("");
    assert.ok(md.includes("The type `Usr` is not in scope."));
    assert.ok(md.includes("**Sources**"));
    assert.ok(out.sources.includes("https://bynk-lang.org/book/reference/diagnostics/#bynk-resolve-unknown-type"));
    assert.ok(md.includes("src/a.bynk:3"));
  });

  it("/explain with nothing to explain asks for something, and does not call the model", async () => {
    const s = stub([], { diagnostics: [] });
    const out = await runCommand("explain", "", s.deps, () => {});
    assert.strictEqual(s.sent.length, 0);
    assert.ok(out.markdown.join("").includes("Put the cursor on a diagnostic"));
  });

  it("answers the model's tool calls and feeds the results back", async () => {
    const s = stub(
      [
        [{ kind: "toolCall", id: "c1", name: "bynk_check", input: {} }],
        [text("It compiles: `bynk check` found no problems.")],
      ],
      broken,
      { bynk_explain_diagnostic: EXPLANATION, bynk_check: "No problems from `bynk check`.\n" },
    );
    const out = await runCommand("explain", "", s.deps, () => {});
    assert.deepStrictEqual(s.invoked.map((i) => i.name), ["bynk_explain_diagnostic", "bynk_check"]);
    assert.strictEqual(s.sent.length, 2);
    assert.ok(s.sent[1].some((m) => "toolResult" in m && m.toolResult.id === "c1"));
    assert.ok(out.markdown.join("").includes("It compiles"));
  });

  it("stops offering tools after a bounded number of rounds", async () => {
    const call: ModelPart[] = [{ kind: "toolCall", id: "c", name: "bynk_check", input: {} }];
    const s = stub([call, call, call, call, call, [text("done")]], broken, {
      bynk_explain_diagnostic: EXPLANATION,
      bynk_check: "ok\n",
    });
    await runCommand("explain", "", s.deps, () => {});
    assert.deepStrictEqual(s.toolsOffered.at(-1), []);
  });

  it("refuses a tool call for a tool that was not offered", async () => {
    const s = stub(
      [[{ kind: "toolCall", id: "c1", name: "other_extension_tool", input: {} }], [text("Done.")]],
      broken,
      { bynk_explain_diagnostic: EXPLANATION, other_extension_tool: "secret\n" },
    );
    await runCommand("explain", "", s.deps, () => {});
    assert.deepStrictEqual(s.invoked.map((i) => i.name), ["bynk_explain_diagnostic"]);
    const result = s.sent[1].find((m) => "toolResult" in m) as { toolResult: { text: string } };
    assert.ok(result.toolResult.text.includes("not available"));
  });

  it("stops after a bounded number of rounds even if the model keeps calling tools", async () => {
    const call: ModelPart[] = [{ kind: "toolCall", id: "c", name: "bynk_check", input: {} }];
    const s = stub(Array.from({ length: 50 }, () => call), broken, {
      bynk_explain_diagnostic: EXPLANATION,
      bynk_check: "ok\n",
    });
    await runCommand("explain", "", s.deps, () => {});
    assert.ok(s.sent.length <= 6, `${s.sent.length} model turns`);
  });

  it("keeps the text a model says alongside its tool calls", async () => {
    const s = stub(
      [[text("Checking. "), { kind: "toolCall", id: "c1", name: "bynk_check", input: {} }], [text("Done.")]],
      broken,
      { bynk_explain_diagnostic: EXPLANATION, bynk_check: "ok\n" },
    );
    await runCommand("explain", "", s.deps, () => {});
    assert.ok(s.sent[1].some((m) => "text" in m && m.role === "assistant" && m.text === "Checking. "));
  });

  it("reports a failed tool call to the model instead of throwing", async () => {
    const s = stub(
      [[{ kind: "toolCall", id: "c1", name: "bynk_check", input: {} }], [text("Could not check.")]],
      broken,
      { bynk_explain_diagnostic: EXPLANATION },
    );
    await runCommand("explain", "", s.deps, () => {});
    const result = s.sent[1].find((m) => "toolResult" in m) as { toolResult: { text: string } };
    assert.ok(result.toolResult.text.startsWith("The tool failed"));
  });

  it("/learn uses the Book search tool when it exists", async () => {
    const book = "## Services\nA service handles requests.\nBook: https://bynk-lang.org/book/services/\n";
    const s = stub([[text("A service handles requests.")]], { diagnostics: [] }, { bynk_search_book: book });
    const out = await runCommand("learn", "services", s.deps, () => {});
    assert.deepStrictEqual(s.invoked, [{ name: "bynk_search_book", input: { query: "services" } }]);
    assert.deepStrictEqual(out.sources, ["https://bynk-lang.org/book/services/"]);
  });

  it("/learn without the Book search tool says so and links the Book, without asking the model", async () => {
    const s = stub([], { diagnostics: [] });
    const out = await runCommand("learn", "services", s.deps, () => {});
    assert.strictEqual(s.sent.length, 0);
    const md = out.markdown.join("");
    assert.ok(md.includes("no Book material"));
    assert.deepStrictEqual(out.sources, ["https://bynk-lang.org/book/"]);
    assert.ok(md.includes("**Sources**"));
  });

  it("/learn needs a topic", async () => {
    const s = stub([], { diagnostics: [] });
    const out = await runCommand("learn", "  ", s.deps, () => {});
    assert.ok(out.markdown.join("").includes("Give a topic"));
  });

  it("/architecture walks the toolchain's architecture", async () => {
    const arch = "# Architecture\nContext `shop` at src/shop.bynk:1:1\n";
    const s = stub([[text("There is one context, shop.")]], broken, { bynk_get_architecture: arch });
    const out = await runCommand("architecture", "", s.deps, () => {});
    assert.deepStrictEqual(s.invoked, [{ name: "bynk_get_architecture", input: { file: "src/a.bynk" } }]);
    assert.ok(out.markdown.join("").includes("src/shop.bynk:1:1"));
  });

  it("/fix proposes the edit as a diff and applies nothing", async () => {
    const reply = "The type is misspelt.\n```bynk\ncommons a\n\nfn f(u: User) -> Int {\n  1\n}\n```";
    const s = stub([[text(reply)]], broken, { bynk_explain_diagnostic: EXPLANATION });
    const streamed: string[] = [];
    const out = await runCommand("fix", "", s.deps, (m) => streamed.push(m));
    assert.deepStrictEqual(out.fix, {
      path: "src/a.bynk",
      startLine: 1,
      endLine: 5,
      replacement: "commons a\n\nfn f(u: User) -> Int {\n  1\n}",
      original: broken.lines!.join("\n"),
    });
    const md = out.markdown.join("");
    assert.ok(md.includes("```diff"));
    assert.ok(md.includes("- fn f(u: Usr) -> Int {"));
    assert.ok(md.includes("+ fn f(u: User) -> Int {"));
    // The model's raw reply is not streamed; the diff is.
    assert.ok(!streamed.join("").includes("```bynk"));
  });

  it("/fix proposes nothing when the reply has no code, or no error exists", async () => {
    const s = stub([[text("I am not sure.")]], broken, { bynk_explain_diagnostic: EXPLANATION });
    const out = await runCommand("fix", "", s.deps, () => {});
    assert.strictEqual(out.fix, undefined);
    assert.ok(out.markdown.join("").includes("no change is proposed"));
    const none = await runCommand("fix", "", stub([], { diagnostics: [] }).deps, () => {});
    assert.ok(none.markdown.join("").includes("no error to fix"));
  });

  it("admits when nothing backs an answer", async () => {
    const s = stub([[text("Something.")]], { file: "x.bynk", line: 1, diagnostics: [] }, { bynk_describe_symbol: "Nothing known.\n" });
    const out = await runCommand("explain", "thing", s.deps, () => {});
    assert.ok(out.markdown.join("").includes("No toolchain source backed this answer"));
  });

  // #2516: what the toolchain says about the Bynk code before it is shown.

  const diag = (code: string, message: string, line = 3): CompileDiagnostic => ({
    code, severity: "error", message, path: "src/a.bynk", line, column: 1,
  });
  const UNKNOWN = diag("bynk.resolve.unknown_type", "unknown type `Usr`");
  const errors = (...e: CompileDiagnostic[]): CheckOutcome => ({ kind: "errors", errors: e });
  const OK: CheckOutcome = { kind: "ok" };
  const FIXED = "The type is misspelt.\n```bynk\ncommons a\n\nfn f(u: User) -> Int {\n  1\n}\n```";
  const STILL_BAD = "Try again.\n```bynk\ncommons a\n\nfn f(u: Person) -> Int {\n  1\n}\n```";

  /** Give `deps` project and scratch checkers that answer in turn, recording what they were asked. */
  function checkers(deps: ChatDeps, inProject: CheckOutcome[], scratch: CheckOutcome[] = []) {
    const projectAsked: string[] = [];
    const scratchAsked: string[] = [];
    deps.checkInProject = async (_file, text) => (projectAsked.push(text), inProject.shift() ?? OK);
    deps.checkScratch = async (source) => (scratchAsked.push(source), scratch.shift() ?? OK);
    return { projectAsked, scratchAsked };
  }

  describe("/fix checks its edit (#2516)", () => {
    it("offers a fix the compiler accepts, having compiled the project as it is and with the edit", async () => {
      const s = stub([[text(FIXED)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      const c = checkers(s.deps, [errors(UNKNOWN), OK]);
      const out = await runCommand("fix", "", s.deps, () => {});
      assert.strictEqual(out.checked, "verified");
      assert.ok(out.fix);
      assert.ok(out.markdown.join("").includes("Checked: `bynk compile` accepts this edit"));
      assert.ok(c.projectAsked[0].includes("fn f(u: Usr)"), "the baseline is the buffer as it is");
      assert.ok(c.projectAsked[1].includes("fn f(u: User)"), "the candidate has the edit");
    });

    it("gives the model a round to repair an edit that leaves the error, then offers the repair", async () => {
      const s = stub([[text(STILL_BAD)], [text(FIXED)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      checkers(s.deps, [errors(UNKNOWN), errors(UNKNOWN), OK]);
      const out = await runCommand("fix", "", s.deps, () => {});
      assert.strictEqual(out.checked, "verified");
      assert.ok(out.fix?.replacement.includes("User"));
      const repair = s.sent[1][s.sent[1].length - 1];
      assert.ok("text" in repair && repair.text.includes("does not remove the error"), JSON.stringify(repair));
      assert.ok("text" in repair && repair.text.includes("bynk.resolve.unknown_type"));
    });

    it("treats an edit that brings a new error as failing, even if the target is gone", async () => {
      const fresh = diag("bynk.types.mismatch", "mismatch", 4);
      const s = stub([[text(STILL_BAD)], [text(FIXED)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      checkers(s.deps, [errors(UNKNOWN), errors(fresh), OK]);
      const out = await runCommand("fix", "", s.deps, () => {});
      const repair = s.sent[1][s.sent[1].length - 1];
      assert.ok("text" in repair && repair.text.includes("introduces new errors"), JSON.stringify(repair));
      assert.strictEqual(out.checked, "verified");
    });

    it("does not count an error the project already had against the edit", async () => {
      const other = diag("bynk.types.mismatch", "mismatch", 5);
      const s = stub([[text(FIXED)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      checkers(s.deps, [errors(UNKNOWN, other), errors(diag("bynk.types.mismatch", "mismatch", 9))]);
      const out = await runCommand("fix", "", s.deps, () => {});
      assert.strictEqual(out.checked, "verified", "the same error moved to another line is not new");
    });

    it("withholds a fix that still fails after the repair, and says why", async () => {
      const s = stub([[text(STILL_BAD)], [text(STILL_BAD)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      checkers(s.deps, [errors(UNKNOWN), errors(UNKNOWN), errors(UNKNOWN)]);
      const out = await runCommand("fix", "", s.deps, () => {});
      assert.strictEqual(out.fix, undefined);
      const md = out.markdown.join("");
      assert.ok(md.includes("not offering it"));
      assert.ok(md.includes("Rejected:") && md.includes("```diff"));
      assert.ok(md.includes("bynk.resolve.unknown_type"));
    });

    it("offers the fix as unchecked when the toolchain cannot run, and says so", async () => {
      const s = stub([[text(FIXED)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      checkers(s.deps, [{ kind: "unavailable", reason: "the Bynk toolchain is not installed" }]);
      const out = await runCommand("fix", "", s.deps, () => {});
      assert.strictEqual(out.checked, "unchecked");
      assert.ok(out.fix);
      assert.ok(out.markdown.join("").includes("Not checked: the Bynk toolchain is not installed"));
    });

    it("says it cannot check a diagnostic the compiler does not report", async () => {
      const s = stub([[text(FIXED)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      checkers(s.deps, [errors(diag("bynk.other.thing", "something else"))]);
      const out = await runCommand("fix", "", s.deps, () => {});
      assert.strictEqual(out.checked, "unchecked");
      assert.ok(out.markdown.join("").includes("does not report this diagnostic"));
    });

    it("offers the fix as unchecked, not as passing, where there is no checker at all", async () => {
      const s = stub([[text(FIXED)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      const out = await runCommand("fix", "", s.deps, () => {});
      assert.strictEqual(out.checked, "unchecked");
      assert.ok(!out.markdown.join("").includes("Checked:"));
    });
  });

  describe("/learn checks its examples (#2516)", () => {
    const BOOK = "## Functions\nA function.\nBook: https://bynk-lang.org/book/functions/\n";
    const GOOD = "A function takes values.\n\n```bynk\nfn double(n: Int) -> Int { n * 2 }\n```\n";
    const BAD = "A function takes values.\n\n```bynk\nfn double(n: Int) -> Int { n * missing }\n```\n";
    const learn = (script: ModelPart[][], tools = { bynk_search_book: BOOK }) => stub(script, { diagnostics: [] }, tools);

    it("shows a lesson whose example compiles, and says it was checked", async () => {
      const s = learn([[text(GOOD)]]);
      const c = checkers(s.deps, [], [OK]);
      const out = await runCommand("learn", "functions", s.deps, () => {});
      const md = out.markdown.join("");
      assert.ok(md.includes("fn double(n: Int) -> Int { n * 2 }"));
      assert.ok(md.includes("Examples checked with `bynk compile`"));
      assert.strictEqual(c.scratchAsked[0], "commons example\n\nfn double(n: Int) -> Int { n * 2 }");
    });

    it("tries a context when the example does not compile as commons", async () => {
      const s = learn([[text(GOOD)]]);
      const c = checkers(s.deps, [], [errors(diag("bynk.x.y", "no")), OK]);
      const out = await runCommand("learn", "functions", s.deps, () => {});
      assert.deepStrictEqual(c.scratchAsked.map((a) => a.split("\n")[0]), ["commons example", "context example"]);
      assert.ok(out.markdown.join("").includes("Examples checked"));
    });

    it("checks an example that declares its own unit as given", async () => {
      const own = "```bynk\ncontext shop\n\nfn f() -> Int { 1 }\n```\n";
      const s = learn([[text(own)]]);
      const c = checkers(s.deps, [], [OK]);
      await runCommand("learn", "units", s.deps, () => {});
      assert.deepStrictEqual(c.scratchAsked, ["context shop\n\nfn f() -> Int { 1 }"]);
    });

    it("gives the model a round to repair a failing example, and shows the repair", async () => {
      const s = learn([[text(BAD)], [text(GOOD)]]);
      checkers(s.deps, [], [errors(diag("bynk.resolve.unknown_name", "unknown name `missing`")), errors(diag("bynk.resolve.unknown_name", "unknown name `missing`")), OK]);
      const out = await runCommand("learn", "functions", s.deps, () => {});
      const md = out.markdown.join("");
      assert.ok(md.includes("n * 2") && !md.includes("missing"));
      const repair = s.sent[1][s.sent[1].length - 1];
      assert.ok("text" in repair && repair.text.includes("do not compile") && repair.text.includes("unknown name `missing`"), JSON.stringify(repair));
    });

    it("leaves out an example that still fails, and never shows it as code", async () => {
      const s = learn([[text(BAD)], [text(BAD)]]);
      const bad = errors(diag("bynk.resolve.unknown_name", "unknown name `missing`"));
      checkers(s.deps, [], [bad, bad, bad, bad]);
      const out = await runCommand("learn", "functions", s.deps, () => {});
      const md = out.markdown.join("");
      assert.ok(!md.includes("n * missing"), "the failing code is not shown");
      assert.ok(md.includes("Example omitted"));
      assert.ok(md.includes("An example was left out because it did not compile"));
      assert.ok(!md.includes("Examples checked"));
      assert.ok(md.includes("A function takes values."), "the prose stays");
    });

    it("keeps the examples that pass when another fails", async () => {
      const both = "One.\n```bynk\nfn a() -> Int { 1 }\n```\nTwo.\n```bynk\nfn b() -> Int { oops }\n```\n";
      const s = learn([[text(both)], [text(both)]]);
      const bad = errors(diag("bynk.resolve.unknown_name", "unknown name `oops`"));
      // First pass: a ok, b fails as commons and context; repair pass: same.
      checkers(s.deps, [], [OK, bad, bad, OK, bad, bad]);
      const out = await runCommand("learn", "functions", s.deps, () => {});
      const md = out.markdown.join("");
      assert.ok(md.includes("fn a() -> Int { 1 }") && !md.includes("oops }"));
      assert.ok(md.includes("Example omitted"));
    });

    it("shows the lesson but says its examples were not checked when the toolchain cannot run", async () => {
      const s = learn([[text(GOOD)]]);
      checkers(s.deps, [], [{ kind: "unavailable", reason: "the Bynk toolchain is not installed" }]);
      const out = await runCommand("learn", "functions", s.deps, () => {});
      const md = out.markdown.join("");
      assert.ok(md.includes("n * 2"));
      assert.ok(md.includes("Examples were not checked: the Bynk toolchain is not installed"));
      assert.ok(!md.includes("Examples checked"));
    });

    it("says nothing about checking a lesson with no Bynk example", async () => {
      const s = learn([[text("A function takes values.")]]);
      const c = checkers(s.deps, []);
      const out = await runCommand("learn", "functions", s.deps, () => {});
      assert.deepStrictEqual(c.scratchAsked, []);
      assert.ok(!out.markdown.join("").includes("checked"));
    });

    it("holds the model's raw reply back until the examples are checked", async () => {
      const s = learn([[text(BAD)], [text(GOOD)]]);
      checkers(s.deps, [], [errors(diag("a.b", "x")), errors(diag("a.b", "x")), OK]);
      const streamed: string[] = [];
      await runCommand("learn", "functions", s.deps, (m) => streamed.push(m));
      assert.ok(!streamed.join("").includes("missing"), "the failing draft was never streamed");
    });
  });

  it("finds every ```bynk block, and only those", () => {
    const reply = "a\n```bynk\nx\n```\nb\n```ts\ny\n```\nc\n```bynk\nz\n```";
    assert.deepStrictEqual(bynkBlocks(reply).map((b) => b.code), ["x", "z"]);
  });

  describe("review fixes (#2516)", () => {
    const twice = (line: number) => diag("bynk.resolve.unknown_type", "unknown type `Usr`", line);

    it("counts identical errors: fixing one of two is a fix, fixing none is not", async () => {
      const mk = () => stub([[text(FIXED)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      const one = mk();
      checkers(one.deps, [errors(twice(3), twice(9)), errors(twice(9))]);
      assert.strictEqual((await runCommand("fix", "", one.deps, () => {})).checked, "verified");

      const none = stub([[text(FIXED)], [text(FIXED)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      checkers(none.deps, [errors(twice(3), twice(9)), errors(twice(3), twice(9)), errors(twice(3), twice(9))]);
      const out = await runCommand("fix", "", none.deps, () => {});
      assert.strictEqual(out.fix, undefined, "an edit that fixed neither copy is not offered");
    });

    it("rejects an edit that adds a copy of an error the project already had", async () => {
      const s = stub([[text(FIXED)], [text(FIXED)]], broken, { bynk_explain_diagnostic: EXPLANATION });
      checkers(s.deps, [errors(twice(3)), errors(twice(3), twice(8)), errors(twice(3), twice(8))]);
      const out = await runCommand("fix", "", s.deps, () => {});
      assert.strictEqual(out.fix, undefined);
      assert.ok(!out.markdown.join("").includes("Checked:"));
    });

    it("says so when the repair round produces no edit", async () => {
      const s = stub([[text(STILL_BAD)], [text("I cannot do better.")]], broken, { bynk_explain_diagnostic: EXPLANATION });
      checkers(s.deps, [errors(UNKNOWN), errors(UNKNOWN)]);
      const out = await runCommand("fix", "", s.deps, () => {});
      const md = out.markdown.join("");
      assert.strictEqual(out.fix, undefined);
      assert.ok(md.includes("I got no edit back") && md.includes("Rejected (first attempt)"), md);
    });

    it("stops starting example checks once the request is cancelled", async () => {
      const blocks = [1, 2, 3, 4].map((n) => `\`\`\`bynk\nfn f${n}() -> Int { ${n} }\n\`\`\``).join("\n");
      const s = stub([[text(blocks)]], { diagnostics: [] }, { bynk_search_book: "## B\nBook: https://bynk-lang.org/book/\n" });
      let cancelled = false;
      s.deps.isCancelled = () => cancelled;
      const asked: string[] = [];
      s.deps.checkScratch = async (src) => (asked.push(src), (cancelled = true), OK);
      await runCommand("learn", "functions", s.deps, () => {});
      // The first compile cancels; the others in its chunk and the fourth example
      // see that before they start, so nothing else is compiled.
      assert.strictEqual(asked.length, 1, "no compile starts after the request is cancelled");
    });

    it("checks several examples in one pass, not one compile at a time", async () => {
      const blocks = [1, 2, 3].map((n) => `\`\`\`bynk\nfn f${n}() -> Int { ${n} }\n\`\`\``).join("\n");
      const s = stub([[text(blocks)]], { diagnostics: [] }, { bynk_search_book: "## B\nBook: https://bynk-lang.org/book/\n" });
      let running = 0;
      let peak = 0;
      s.deps.checkScratch = async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return OK;
      };
      await runCommand("learn", "functions", s.deps, () => {});
      assert.strictEqual(peak, 3);
    });

    it("shows a bynk-fragment example without compiling it, and says so", async () => {
      const reply = "Real.\n```bynk\nfn a() -> Int { 1 }\n```\nPartial.\n```bynk-fragment\nservice s { on call(\n```\n";
      const s = stub([[text(reply)]], { diagnostics: [] }, { bynk_search_book: "## B\nBook: https://bynk-lang.org/book/\n" });
      const c = checkers(s.deps, [], [OK]);
      const out = await runCommand("learn", "services", s.deps, () => {});
      const md = out.markdown.join("");
      assert.strictEqual(c.scratchAsked.length, 1, "only the plain bynk block was compiled");
      assert.ok(md.includes("```bynk\nservice s { on call("), "shown, with a fence the editor highlights");
      assert.ok(!md.includes("bynk-fragment"));
      assert.ok(md.includes("An illustrative example was not compiled"));
      assert.ok(md.includes("Examples checked"));
    });

    it("does not claim anything was checked for a lesson of only fragments", async () => {
      const reply = "Partial.\n```bynk-fragment\nservice s {\n```\n";
      const s = stub([[text(reply)]], { diagnostics: [] }, { bynk_search_book: "## B\nBook: https://bynk-lang.org/book/\n" });
      const c = checkers(s.deps, []);
      const out = await runCommand("learn", "services", s.deps, () => {});
      const md = out.markdown.join("");
      assert.deepStrictEqual(c.scratchAsked, []);
      assert.ok(md.includes("not compiled") && !md.includes("Examples checked"));
    });

    it("does not treat a bynk-fragment fence as an example to check", () => {
      assert.deepStrictEqual(bynkBlocks("```bynk-fragment\nx\n```"), []);
    });
  });
});
