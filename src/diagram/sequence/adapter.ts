// `SequenceModel` (the `bynk/sequenceModel` wire shape) → the sequence IR.
//
// The ordering rules are the ones `webview/mermaid-gen.ts` established (#846,
// ADRs 0261, 0274, 0275), now producing structure instead of Mermaid text:
//
// - Content is a recursive walk of the block tree (`AltBlock.parent` and
//   `parentBranch`), not a pass over the flat `messages` array. A branch can
//   hold no messages and still contain a nested block, so the flat array alone
//   cannot place it. At each level, messages and child blocks are merged in
//   source order (`range.start`).
// - A branch's reply (the value the handler yields on that path) is a note over
//   the entry lifeline. A branch with nothing at all gets a `…` note, so the
//   fragment still has a body.
// - A `Collapsed` block (nesting past the server's depth budget) is a note that
//   links to the block's source.
// - A state write (#2194) is a note over the entry lifeline that links to the
//   write itself.
// - Notes anchor to the entry lifeline found by kind, not by position: with a
//   principal, the actor is inserted ahead of the entry.
//
// Unlike Mermaid, UML needs no label on a reply arrow, so an empty return label
// stays empty, and labels need no escaping (drawing sets text, never markup).

import type { AltBlock, Message, MessageKind, Participant, ParticipantKind, Range, SequenceModel } from "../../webview/types";
import type { ArrowKind, Lifeline, LifelineKind, NoteTone, SequenceDiagram, SequenceEvent } from "./ir";

const LIFELINE: Record<ParticipantKind, { kind: LifelineKind; stereotype: string | null }> = {
  Actor: { kind: "actor", stereotype: null },
  Entry: { kind: "entry", stereotype: null },
  Capability: { kind: "capability", stereotype: "capability" },
  Context: { kind: "context", stereotype: "context" },
  Agent: { kind: "agent", stereotype: "agent" },
};

const ARROW: Record<Exclude<MessageKind, "StateWrite">, ArrowKind> = {
  Call: "sync",
  Return: "reply",
  Send: "async",
};

/** Ids are stable for one model: `p<participant id>`, `m<message index>`,
 *  `b<block id>`, `b<block id>.<branch>`, and `n<k>` for the k-th note. */
export const ids = {
  participant: (id: number): string => `p${id}`,
  message: (index: number): string => `m${index}`,
  block: (id: number): string => `b${id}`,
  operand: (block: number, branch: number): string => `b${block}.${branch}`,
  note: (k: number): string => `n${k}`,
};

function clean(label: string): string {
  return label.replace(/\s+/g, " ").trim();
}

function startOf(range: Range): [number, number] {
  return [range.start.line, range.start.character];
}

type Item = { start: [number, number]; message?: { m: Message; index: number }; block?: AltBlock };

export function toSequenceDiagram(model: SequenceModel): SequenceDiagram {
  const indexOf = new Map<number, number>();
  const lifelines: Lifeline[] = model.participants.map((p: Participant, i) => {
    indexOf.set(p.id, i);
    const { kind, stereotype } = LIFELINE[p.kind] ?? { kind: "capability", stereotype: null };
    return { ref: { id: ids.participant(p.id), range: p.range }, kind, name: clean(p.name), stereotype };
  });
  const entry = Math.max(0, lifelines.findIndex((l) => l.kind === "entry"));
  const lifelineOf = (participantId: number): number => indexOf.get(participantId) ?? entry;

  let notes = 0;
  const note = (range: Range | null, text: string, tone: NoteTone): SequenceEvent => ({
    type: "note",
    ref: { id: ids.note(notes++), range },
    over: entry,
    text,
    tone,
  });

  const messageIndex = new Map<Message, number>();
  model.messages.forEach((m, i) => messageIndex.set(m, i));

  const content = (messages: Message[], blocks: AltBlock[]): SequenceEvent[] => {
    const items: Item[] = [
      ...messages.map((m) => ({ start: startOf(m.range), message: { m, index: messageIndex.get(m) ?? -1 } })),
      ...blocks.map((b) => ({ start: startOf(b.range), block: b })),
    ];
    // Stable sort: a message and a block at the same position keep their
    // message-then-block order, as `mermaid-gen.ts` did.
    items.sort((a, b) => a.start[0] - b.start[0] || a.start[1] - b.start[1]);
    return items.map((item) => (item.message ? messageEvent(item.message.m, item.message.index) : blockEvent(item.block as AltBlock)));
  };

  const messageEvent = (m: Message, index: number): SequenceEvent => {
    if (m.kind === "StateWrite") return note(m.range, clean(m.label), "state");
    return {
      type: "message",
      ref: { id: ids.message(index), range: m.range },
      from: lifelineOf(m.from),
      to: lifelineOf(m.to),
      arrow: ARROW[m.kind] ?? "sync",
      label: clean(m.label),
    };
  };

  const blockEvent = (block: AltBlock): SequenceEvent => {
    if (block.kind === "Collapsed") return note(block.range, "nested branching — click to view source", "collapsed");
    const operands = block.branches.map((branch, b) => {
      const branchMessages = branch.messageIds
        .map((id) => model.messages[id])
        .filter((m): m is Message => m !== undefined);
      const children = model.blocks.filter((c) => c.parent === block.id && c.parentBranch === b);
      const events = content(branchMessages, children);
      if (branch.reply) events.push(note(block.range, clean(branch.reply), "reply"));
      if (events.length === 0) events.push(note(block.range, "…", "empty"));
      return { ref: { id: ids.operand(block.id, b), range: block.range }, guard: clean(branch.label), events };
    });
    return {
      type: "fragment",
      ref: { id: ids.block(block.id), range: block.range },
      operator: block.branches.length <= 1 ? "opt" : "alt",
      operands,
    };
  };

  const events = content(
    model.messages.filter((m) => m.block === null),
    model.blocks.filter((b) => b.parent === null),
  );
  return { lifelines, events };
}
