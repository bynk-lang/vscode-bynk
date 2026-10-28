// #2465: the pure core of the `@bynk` chat participant (`chatParticipant.ts`) —
// what each slash command gathers from the toolchain, the prompt it builds, the
// tool-calling loop against the model, and the sources it cites. No `vscode`
// import, so the unit tests drive it with a stubbed model (see
// tsconfig.test.json).
//
// DECISION A: the model is whichever the user picked in chat
// (`request.model`); the extension holds no keys and makes no choice.
// DECISION B: `/fix` returns its edit as a proposal (`FixProposal`) that the
// caller shows as a diff behind a button; nothing here changes a file.
// DECISION D (#2516): Bynk code is checked before it is shown as working. A
// `/fix` edit is compiled against the project with the edit applied, and a
// `/learn` example in a scratch project; the model gets one round to repair what
// fails, and what still fails is not offered (`/fix`) or not shown as code
// (`/learn`). Both replies are held back until checked. If the toolchain can't
// run the check, the answer says it is unchecked rather than implying it passed.
// DECISION C: every answer cites its sources. They are collected from the
// toolchain's own output (Book links, `path:line` locations), not taken from
// the model's say-so, and an answer with none says so.

import { type CompileDiagnostic, describeDiagnostic, diagnosticKey } from "./richDiagnostics";

/** What compiling some text said: it compiles, it has these errors, or the
 *  check could not run (no toolchain, no project), which is no verdict at all. */
export type CheckOutcome =
  | { kind: "ok" }
  | { kind: "errors"; errors: CompileDiagnostic[] }
  | { kind: "unavailable"; reason: string };

/** One part of a model's streamed reply. */
export type ModelPart =
  | { kind: "text"; value: string }
  | { kind: "toolCall"; id: string; name: string; input: object };

/** A conversation message the core builds; the glue maps it onto the API. */
export type ChatMsg =
  | { role: "user" | "assistant"; text: string }
  | { role: "assistant"; toolCall: { id: string; name: string; input: object } }
  | { role: "user"; toolResult: { id: string; text: string } };

/** The model behind `request.model`, reduced to what the core needs. */
export interface ModelLike {
  send(
    messages: readonly ChatMsg[],
    toolNames: readonly string[],
  ): Promise<AsyncIterable<ModelPart>>;
}

/** A diagnostic in the editor, 1-based, with a workspace-relative path. */
export interface EditorDiagnostic {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  code: string | undefined;
  message: string;
}

/** What the editor shows the participant when a command is run. */
export interface EditorContext {
  /** The active `.bynk` file, workspace-relative. */
  file?: string;
  /** The cursor's (or selection start's) 1-based line. */
  line?: number;
  selectedText?: string;
  /** Diagnostics of the active file. */
  diagnostics: readonly EditorDiagnostic[];
  /** The active file's lines, for `/fix` to quote. */
  lines?: readonly string[];
}

export interface ChatDeps {
  model: ModelLike;
  editor: EditorContext;
  /** Run a registered tool and return its text. Throws with the tool's message. */
  invokeTool(name: string, input: object): Promise<string>;
  /** Whether a tool of that name is registered. */
  hasTool(name: string): boolean;
  /** The Bynk tools offered to the model for its own calls. */
  modelTools: readonly string[];
  isCancelled(): boolean;
  /** Compile the active file's project with `text` as that file's contents.
   *  Absent where there is no way to check (the answer then says so). */
  checkInProject?(file: string, text: string): Promise<CheckOutcome>;
  /** Compile `source` as the only unit of a throwaway project. */
  checkScratch?(source: string): Promise<CheckOutcome>;
}

/** An edit `/fix` proposes: replace 1-based lines `startLine..endLine`. */
export interface FixProposal {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
  original: string;
}

export interface ChatOutcome {
  /** Markdown to stream, in order. */
  markdown: string[];
  fix?: FixProposal;
  /** For a `fix`: whether the toolchain accepted it, or could not check it. */
  checked?: "verified" | "unchecked";
  /** The command that produced it, for follow-up suggestions. */
  command: string;
  sources: string[];
}

export const BOOK_INDEX = "https://bynk-lang.org/book/";
export const SEARCH_BOOK_TOOL = "bynk_search_book";
const MAX_TOOL_ROUNDS = 4;
const MAX_EXPLAINED_CODES = 3;
const FIX_CONTEXT_LINES = 3;

/** The grounding rule (DECISION C), common to every command. */
export const SYSTEM_PROMPT = [
  "You are @bynk, a guide to the Bynk programming language inside VS Code.",
  "Bynk is young and pre-1.0: what you remember of its syntax is likely wrong or out of date.",
  "Answer only from the MATERIAL below, which comes from the installed Bynk toolchain, and from tool results.",
  "Cite the source of every claim: a Book link, a diagnostic code, or a `path:line` location, exactly as the material gives it.",
  "If the material does not answer the question, say so plainly rather than guess.",
  "Before you say any Bynk code compiles or is fixed, call the `bynk_check` tool and report what it says.",
  "Keep answers short and in British English.",
].join("\n");

const COMMAND_TASKS: Record<string, string> = {
  explain:
    "Explain the diagnostic(s) or code in the MATERIAL to a learner: what it means, why it happened here, and how to resolve it.",
  learn:
    "Teach the topic as a short lesson (a few paragraphs and one small example) using only the Book material given. " +
    "Fence every Bynk example as ```bynk and make it a complete unit that compiles on its own: it is compiled before you are shown. " +
    "An example that is deliberately partial or meant not to compile may be fenced ```bynk-fragment instead; it is shown but not compiled, " +
    "and the reader is told so. Never use that for code you present as working.",
  architecture:
    "Walk through this project's architecture: its contexts, services, agents and how they connect. Start with the shape, then the details.",
  fix: [
    "Propose a fix for the target diagnostic. The MATERIAL gives the numbered lines to replace.",
    "Reply with one sentence on the cause, then exactly one fenced ```bynk block holding the complete replacement for those lines, with no line numbers.",
    "Change as little as possible.",
  ].join(" "),
};

/** The `bynk.*` diagnostic codes mentioned in `text`, in order, without repeats. */
export function codesIn(text: string): string[] {
  const found = text.match(/\bbynk\.[a-z0-9_]+(?:\.[a-z0-9_]+)*/g) ?? [];
  return [...new Set(found)];
}

/** Book links and `path.bynk:line` locations in a tool's output. */
export function sourcesIn(text: string): string[] {
  const urls = text.match(/https:\/\/bynk-lang\.org\/[^\s)>\]"'`]+/g) ?? [];
  const locs = text.match(/[\w./-]+\.bynk:\d+(?::\d+)?/g) ?? [];
  return [...urls.map((u) => u.replace(/[.,;]+$/, "")), ...locs];
}

function addSources(into: string[], text: string): void {
  for (const s of sourcesIn(text)) if (!into.includes(s)) into.push(s);
}

/** The `Sources` footer, or the plain admission that there are none. */
export function renderSources(sources: readonly string[]): string {
  if (sources.length === 0) {
    return "\n\n*No toolchain source backed this answer; treat it with caution.*\n";
  }
  return `\n\n**Sources**\n${sources.map((s) => `- ${s}`).join("\n")}\n`;
}

/** Run the model to completion, answering its tool calls, and return its text. */
export async function converse(
  deps: ChatDeps,
  messages: ChatMsg[],
  sources: string[],
  emit: (text: string) => void,
): Promise<string> {
  let all = "";
  for (let round = 0; ; round++) {
    const calls: Extract<ModelPart, { kind: "toolCall" }>[] = [];
    // The last round offers no tools, so the model must answer.
    const tools = round < MAX_TOOL_ROUNDS ? deps.modelTools : [];
    let said = "";
    for await (const part of await deps.model.send(messages, tools)) {
      if (deps.isCancelled()) return all;
      if (part.kind === "text") {
        said += part.value;
        all += part.value;
        emit(part.value);
      } else {
        calls.push(part);
      }
    }
    if (calls.length === 0) return all;
    // A model that ignores the missing tools gets no further turn.
    if (round >= MAX_TOOL_ROUNDS) return all;
    // What the model said alongside its calls belongs to the history.
    if (said) messages.push({ role: "assistant", text: said });
    for (const call of calls) {
      let text: string;
      if (!tools.includes(call.name)) {
        // Only the tools offered may run: the prompt carries file contents, so
        // a call for any other registered tool is not one the user's model chose.
        text = `The tool ${call.name} is not available here.`;
      } else {
        try {
          text = await deps.invokeTool(call.name, call.input);
        } catch (e) {
          text = `The tool failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      addSources(sources, text);
      messages.push({ role: "assistant", toolCall: call });
      messages.push({ role: "user", toolResult: { id: call.id, text } });
    }
  }
}

function buildMessages(command: string, material: string, prompt: string): ChatMsg[] {
  const task = COMMAND_TASKS[command] ?? "";
  const ask = prompt.trim() ? `\n\nThe user asks: ${prompt.trim()}` : "";
  return [
    { role: "user", text: `${SYSTEM_PROMPT}\n\nTask: ${task}${ask}\n\nMATERIAL\n${material}` },
  ];
}

/** `/explain`: the toolchain's explanation of the code on the cursor's line,
 *  of a code the user typed, or of the selected symbol. */
async function gatherExplain(deps: ChatDeps, prompt: string, sources: string[]): Promise<string> {
  const { editor } = deps;
  const onLine = editor.diagnostics.filter((d) => d.line === editor.line && d.code);
  const pool = onLine.length > 0 ? onLine : editor.diagnostics.filter((d) => d.code);
  const typed = codesIn(prompt);
  const codes = [...new Set([...typed, ...pool.map((d) => d.code as string)])].slice(
    0,
    MAX_EXPLAINED_CODES,
  );
  const parts: string[] = [];
  for (const d of pool.slice(0, MAX_EXPLAINED_CODES)) {
    parts.push(`Diagnostic at ${d.path}:${d.line}:${d.column}: ${d.severity} ${d.code}: ${d.message}`);
    sources.push(`${d.path}:${d.line}`);
  }
  for (const code of codes) {
    const text = await deps.invokeTool("bynk_explain_diagnostic", { code });
    addSources(sources, text);
    parts.push(text);
  }
  if (codes.length === 0) {
    // No diagnostic to explain: describe the symbol under the cursor instead.
    const input =
      editor.file && editor.line
        ? { file: editor.file, line: editor.line, name: editor.selectedText?.trim() || prompt.trim() || undefined }
        : { name: prompt.trim() };
    if (!("file" in input) && !input.name) {
      return "";
    }
    const text = await deps.invokeTool("bynk_describe_symbol", input);
    addSources(sources, text);
    parts.push(text);
  }
  return parts.join("\n\n");
}

async function gatherLearn(deps: ChatDeps, prompt: string, sources: string[]): Promise<string> {
  if (!deps.hasTool(SEARCH_BOOK_TOOL)) return "";
  const text = await deps.invokeTool(SEARCH_BOOK_TOOL, { query: prompt.trim() });
  addSources(sources, text);
  return text;
}

async function gatherArchitecture(deps: ChatDeps, sources: string[]): Promise<string> {
  const text = await deps.invokeTool("bynk_get_architecture", deps.editor.file ? { file: deps.editor.file } : {});
  addSources(sources, text);
  return text;
}

/** The lines `/fix` offers for replacement: the target diagnostic's line and a
 *  few either side, so the model sees what surrounds the error. */
export function fixTarget(editor: EditorContext): { diag: EditorDiagnostic; start: number; end: number } | undefined {
  const errors = editor.diagnostics.filter((d) => d.severity === "error");
  const diag = errors.find((d) => d.line === editor.line) ?? errors[0];
  if (!diag || !editor.lines) return undefined;
  const start = Math.max(1, diag.line - FIX_CONTEXT_LINES);
  const end = Math.min(editor.lines.length, diag.line + FIX_CONTEXT_LINES);
  return { diag, start, end };
}

/** The first fenced code block in a reply, if any. */
export function firstCodeBlock(reply: string): string | undefined {
  const m = /```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```/.exec(reply);
  return m ? m[1] : undefined;
}

/** Every ```bynk block in a reply: its code, and where the whole fence sits. */
export function bynkBlocks(reply: string): { code: string; start: number; end: number }[] {
  const blocks: { code: string; start: number; end: number }[] = [];
  for (const m of reply.matchAll(/```bynk[ \t]*\r?\n([\s\S]*?)\r?\n?```/g)) {
    blocks.push({ code: m[1], start: m.index, end: m.index + m[0].length });
  }
  return blocks;
}

/** Illustrative examples the model marked ```bynk-fragment: shown, not compiled. */
export function fragmentCount(reply: string): number {
  return [...reply.matchAll(/```bynk-fragment[ \t]*\r?\n/g)].length;
}

/** The fence tag a reader's editor knows how to highlight. */
function plainFragmentFences(reply: string): string {
  return reply.replace(/```bynk-fragment([ \t]*\r?\n)/g, "```bynk$1");
}

const UNIT_HEADER = /^\s*(?:context|commons|adapter|suite)\s+\w/m;

/** Check one example: as given if it declares its own unit, else inside a
 *  `commons` and then a `context`, the first that compiles. */
async function checkSnippet(deps: ChatDeps, code: string): Promise<CheckOutcome> {
  if (!deps.checkScratch) return { kind: "unavailable", reason: "this build has no way to compile an example" };
  const attempts = UNIT_HEADER.test(code) ? [code] : [`commons example\n\n${code}`, `context example\n\n${code}`];
  let best: CheckOutcome | undefined;
  for (const source of attempts) {
    if (deps.isCancelled()) return { kind: "unavailable", reason: "the check was cancelled" };
    const outcome = await deps.checkScratch(source);
    if (outcome.kind !== "errors") return outcome;
    if (!best || (best.kind === "errors" && outcome.errors.length < best.errors.length)) best = outcome;
  }
  return best as CheckOutcome;
}

/** Take the first diagnostics for a message to the model or the user. */
function listErrors(errors: readonly CompileDiagnostic[], limit = 5): string {
  return errors.slice(0, limit).map((e) => `- ${describeDiagnostic(e)}`).join("\n");
}

/** How many examples are compiled at once. */
const EXAMPLE_CONCURRENCY = 3;

/** Outcome of checking each ```bynk block in a lesson, a few at a time (each
 *  compile has its own scratch directory, so they cannot collide). A cancelled
 *  request stops starting new ones. */
async function checkExamples(deps: ChatDeps, reply: string): Promise<CheckOutcome[]> {
  const blocks = bynkBlocks(reply);
  const results: CheckOutcome[] = [];
  for (let i = 0; i < blocks.length; i += EXAMPLE_CONCURRENCY) {
    if (deps.isCancelled()) break;
    const chunk = blocks.slice(i, i + EXAMPLE_CONCURRENCY);
    results.push(...(await Promise.all(chunk.map((b) => checkSnippet(deps, b.code)))));
  }
  return results;
}

/** A lesson with every example that failed to compile replaced by a notice. */
function withoutFailedExamples(reply: string, results: readonly CheckOutcome[]): string {
  const blocks = bynkBlocks(reply);
  let out = "";
  let at = 0;
  blocks.forEach((b, i) => {
    out += reply.slice(at, b.start);
    const r = results[i];
    if (r?.kind === "errors") {
      out += `> Example omitted: it did not compile with the Bynk toolchain (${describeDiagnostic(r.errors[0])}).`;
    } else {
      out += reply.slice(b.start, b.end);
    }
    at = b.end;
  });
  return out + reply.slice(at);
}

/** What checking a `/fix` edit found. */
type FixVerdict =
  | { kind: "verified" }
  | { kind: "unchecked"; reason: string }
  | { kind: "rejected"; errors: CompileDiagnostic[]; targetRemains: boolean };

/** How many errors of each kind (file, code, message) there are. Two identical
 *  errors in a file share a key, so the number of them is what tells a fix of one
 *  from a fix of none, or an edit that adds a copy elsewhere. */
function countByKey(errors: readonly CompileDiagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(diagnosticKey(e), (counts.get(diagnosticKey(e)) ?? 0) + 1);
  return counts;
}

/** The project as it is, compiled once: the diagnostic to fix as the compiler
 *  reports it, and the errors the project already had. */
type FixBaseline =
  | { kind: "unchecked"; reason: string }
  | { kind: "ready"; target: CompileDiagnostic; known: ReadonlyMap<string, number> };

/** The file's text with 1-based lines `start..end` replaced. */
function applyReplacement(lines: readonly string[], start: number, end: number, replacement: string): string {
  return [...lines.slice(0, start - 1), ...replacement.split("\n"), ...lines.slice(end)].join("\n");
}

async function fixBaseline(deps: ChatDeps, diag: EditorDiagnostic): Promise<FixBaseline> {
  const { file, lines } = deps.editor;
  if (!deps.checkInProject || !file || !lines) {
    return { kind: "unchecked", reason: "this build has no way to compile the project" };
  }
  const before = await deps.checkInProject(file, lines.join("\n"));
  if (before.kind === "unavailable") return { kind: "unchecked", reason: before.reason };
  if (before.kind === "ok") {
    return { kind: "unchecked", reason: "the compiler reports no error in the project as it is, so it has nothing to check the edit against" };
  }
  const target =
    before.errors.find((e) => e.code === diag.code && e.message === diag.message && e.line === diag.line) ??
    before.errors.find((e) => e.code === diag.code && e.message === diag.message) ??
    before.errors.find((e) => e.code === diag.code);
  if (!target) {
    return { kind: "unchecked", reason: "the compiler does not report this diagnostic, so the edit can't be checked against it" };
  }
  return { kind: "ready", target, known: countByKey(before.errors) };
}

/** Compile the project with the edit; it passes if the target diagnostic is gone
 *  and it brought no error the project did not already have. */
async function verifyFix(
  deps: ChatDeps,
  base: FixBaseline,
  start: number,
  end: number,
  replacement: string,
): Promise<FixVerdict> {
  const { file, lines } = deps.editor;
  if (base.kind === "unchecked") return base;
  if (!deps.checkInProject || !file || !lines) {
    return { kind: "unchecked", reason: "this build has no way to compile the project" };
  }
  const after = await deps.checkInProject(file, applyReplacement(lines, start, end, replacement));
  if (after.kind === "unavailable") return { kind: "unchecked", reason: after.reason };
  if (after.kind === "ok") return { kind: "verified" };
  // An error is new if there are more of its kind than before (the later copies
  // are the new ones); the target remains unless there are fewer of its kind.
  const seen = new Map<string, number>();
  const fresh: CompileDiagnostic[] = [];
  for (const e of after.errors) {
    const key = diagnosticKey(e);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > (base.known.get(key) ?? 0)) fresh.push(e);
  }
  const targetKey = diagnosticKey(base.target);
  const targetRemains = (seen.get(targetKey) ?? 0) >= (base.known.get(targetKey) ?? 0);
  if (!targetRemains && fresh.length === 0) return { kind: "verified" };
  return { kind: "rejected", errors: targetRemains ? [base.target, ...fresh] : fresh, targetRemains };
}

/** A unified-style diff of the replaced lines, for the response. */
export function renderDiff(fix: FixProposal): string {
  const old = fix.original.split("\n").map((l) => `- ${l}`);
  const next = fix.replacement.split("\n").map((l) => `+ ${l}`);
  const head = `@@ ${fix.path}:${fix.startLine}-${fix.endLine} @@`;
  return ["```diff", head, ...old, ...next, "```"].join("\n");
}

/** Run one slash command to completion. `stream` receives Markdown as it is
 *  produced; the outcome carries the whole response and any proposed fix. */
export async function runCommand(
  command: string,
  prompt: string,
  deps: ChatDeps,
  stream: (markdown: string) => void,
): Promise<ChatOutcome> {
  const sources: string[] = [];
  const markdown: string[] = [];
  const say = (s: string) => {
    markdown.push(s);
    stream(s);
  };
  const done = (extra?: Partial<ChatOutcome>): ChatOutcome => ({ markdown, command, sources, ...extra });

  if (command === "learn") {
    if (!prompt.trim()) {
      say("Give a topic, for example `@bynk /learn services`.\n");
      return done();
    }
    const material = await gatherLearn(deps, prompt, sources);
    if (!material) {
      // Nothing to ground a lesson in: point at the Book rather than improvise.
      say(
        `I have no Book material for “${prompt.trim()}” to teach from, and Bynk is too young for me ` +
          `to rely on memory. Search the Book at ${BOOK_INDEX}.\n`,
      );
      sources.push(BOOK_INDEX);
      say(renderSources(sources));
      return done();
    }
    // Held back, like /fix: the examples are compiled before anyone reads them.
    const messages = buildMessages(command, material, prompt);
    let reply = await converse(deps, messages, sources, () => {});
    if (deps.isCancelled()) return done();
    let results = await checkExamples(deps, reply);
    if (deps.isCancelled()) return done();
    const failing = (rs: readonly CheckOutcome[]) =>
      rs.flatMap((r) => (r.kind === "errors" ? r.errors : []));
    if (failing(results).length > 0) {
      // One round to repair, with what the compiler said.
      messages.push({ role: "assistant", text: reply });
      messages.push({
        role: "user",
        text:
          "These examples do not compile with the Bynk toolchain:\n" +
          `${listErrors(failing(results))}\n\n` +
          "Rewrite the lesson with corrected examples, using only the MATERIAL and tool results. " +
          "If you cannot make an example compile, leave it out.",
      });
      reply = await converse(deps, messages, sources, () => {});
      if (deps.isCancelled()) return done();
      results = await checkExamples(deps, reply);
      if (deps.isCancelled()) return done();
    }
    say(plainFragmentFences(withoutFailedExamples(reply, results)).trim() + "\n");
    const omitted = results.filter((r) => r.kind === "errors").length;
    const unavailable = results.find((r) => r.kind === "unavailable");
    if (omitted > 0) {
      say(`\n*${omitted === 1 ? "An example was" : `${omitted} examples were`} left out because ${omitted === 1 ? "it" : "they"} did not compile.*\n`);
    }
    const fragments = fragmentCount(reply);
    if (fragments > 0) {
      say(`\n*${fragments === 1 ? "An illustrative example was" : `${fragments} illustrative examples were`} not compiled.*\n`);
    }
    if (unavailable?.kind === "unavailable") {
      say(`\n*Examples were not checked: ${unavailable.reason}.*\n`);
    } else if (results.length > 0 && omitted < results.length) {
      say("\n*Examples checked with `bynk compile`.*\n");
    }
    say(renderSources(sources));
    return done();
  }

  if (command === "architecture") {
    const material = await gatherArchitecture(deps, sources);
    await converse(deps, buildMessages(command, material, prompt), sources, say);
    say(renderSources(sources));
    return done();
  }

  if (command === "fix") {
    const target = fixTarget(deps.editor);
    if (!target || !deps.editor.file || !deps.editor.lines) {
      say("There is no error to fix: open a `.bynk` file whose diagnostics include an error.\n");
      return done();
    }
    const { diag, start, end } = target;
    const original = deps.editor.lines.slice(start - 1, end).join("\n");
    const numbered = deps.editor.lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}| ${l}`)
      .join("\n");
    const parts = [
      `Target: ${diag.path}:${diag.line}:${diag.column}: ${diag.code ?? "error"}: ${diag.message}`,
      `Lines ${start}-${end} of ${diag.path} (replace exactly these):\n${numbered}`,
    ];
    sources.push(`${diag.path}:${diag.line}`);
    if (diag.code) {
      const explained = await deps.invokeTool("bynk_explain_diagnostic", { code: diag.code });
      addSources(sources, explained);
      parts.push(explained);
    }
    // The reply is held back: the user sees the diff, not raw model output.
    const messages = buildMessages(command, parts.join("\n\n"), prompt);
    let reply = await converse(deps, messages, sources, () => {});
    if (deps.isCancelled()) return done();
    let replacement = firstCodeBlock(reply);
    const prose = reply.replace(/```[\s\S]*?```/g, "").trim();
    if (prose) say(`${prose}\n\n`);
    if (replacement === undefined) {
      say("I could not turn that into an edit; no change is proposed.\n");
      say(renderSources(sources));
      return done();
    }
    const base = await fixBaseline(deps, diag);
    let verdict = await verifyFix(deps, base, start, end, replacement);
    // Set when the repair round came back with no edit, so what is shown as
    // rejected is the first attempt and the answer says so.
    let repairEmpty = false;
    if (verdict.kind === "rejected") {
      // One round to repair, with what the compiler said about the edit.
      messages.push({ role: "assistant", text: reply });
      messages.push({
        role: "user",
        text:
          (verdict.targetRemains ? "That edit does not remove the error" : "That edit introduces new errors") +
          ` when the project is compiled with it:\n${listErrors(verdict.errors)}\n\n` +
          "Reply with one corrected fenced ```bynk block replacing the same lines.",
      });
      reply = await converse(deps, messages, sources, () => {});
      if (deps.isCancelled()) return done();
      const again = firstCodeBlock(reply);
      if (again !== undefined) {
        replacement = again;
        verdict = await verifyFix(deps, base, start, end, again);
      } else {
        repairEmpty = true;
      }
    }
    const fix: FixProposal = { path: diag.path, startLine: start, endLine: end, replacement, original };
    if (verdict.kind === "rejected") {
      say(
        (repairEmpty
          ? "My first edit does not compile cleanly, and when I asked for a correction I got no edit back, so I am not offering anything:\n"
          : "The edit I came up with does not compile cleanly, so I am not offering it:\n") +
          `${listErrors(verdict.errors)}\n\n`,
      );
      say(`${repairEmpty ? "Rejected (first attempt)" : "Rejected"}:\n${renderDiff(fix)}\n`);
      say(renderSources(sources));
      return done();
    }
    say(`${renderDiff(fix)}\n`);
    if (verdict.kind === "verified") {
      say("\n*Checked: `bynk compile` accepts this edit, and the diagnostic is gone.*\n");
    } else {
      say(`\n*Not checked: ${verdict.reason}.*\n`);
    }
    say(renderSources(sources));
    return done({ fix, checked: verdict.kind });
  }

  // /explain, and a bare `@bynk` message (treated as /explain when the editor
  // has something to explain, else a question answered from the toolchain).
  const material = await gatherExplain(deps, prompt, sources);
  if (!material) {
    say("Put the cursor on a diagnostic, select a symbol, or give a code, for example `@bynk /explain bynk.resolve.unknown_type`.\n");
    return done({ command: "explain" });
  }
  await converse(deps, buildMessages("explain", material, prompt), sources, say);
  say(renderSources(sources));
  return done({ command: "explain" });
}
