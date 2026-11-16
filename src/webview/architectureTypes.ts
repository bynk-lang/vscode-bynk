// #851: hand-mirrored TS types for `bynk-lsp`'s `bynk/architectureModel` wire
// shape (`bynk-lsp/src/architecture_request.rs`). No codegen exists in this
// repo for LSP payload types, so this is maintained by hand alongside the
// Rust side — the same posture `webview/types.ts` (#846) and `webview/
// docTypes.ts` (#847) take.
//
// Unlike both siblings' wire shapes, this one is project-scoped: there is no
// single document URI the whole payload is relative to, so every location
// here (`ArchLoc`) carries its own `uri` alongside its `range`.

export type NodeKind = "Context" | "Adapter";

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

/** A click-to-code target: a file URI plus the range within it. */
export interface ArchLoc {
  uri: string;
  range: Range;
}

export interface ArchCapability {
  name: string;
  local: boolean;
  /** The providing unit's qualified name, for a consumed (non-local)
   *  capability — `"bynk"` for the toolchain's built-in surface. `null` for a
   *  locally-declared capability. */
  from: string | null;
  loc: ArchLoc;
}

export interface ArchProvider {
  capability: string;
  providerName: string;
  external: boolean;
  loc: ArchLoc;
}

export interface ArchService {
  name: string;
  handlerCount: number;
  loc: ArchLoc;
  /** Model-diagrams slice 4 (bynk-lang/bynk#3654): how it is reached —
   *  `call`, `http`, `cron`, `queue`, `websocket`, `events` or `email`.
   *  Absent from older servers. */
  protocol?: string;
  /** Model-diagrams slice 4: the actors its handlers admit, sorted. */
  actors?: string[];
}

export interface ArchAgent {
  name: string;
  handlerCount: number;
  loc: ArchLoc;
}

export interface ArchNode {
  name: string;
  kind: NodeKind;
  loc: ArchLoc;
  capabilities: ArchCapability[];
  providers: ArchProvider[];
  services: ArchService[];
  agents: ArchAgent[];
  /** ADR 0854 (bynk v0.625.3). Absent from older servers. */
  uses?: ArchHandlerUses[];
}

export interface ArchEdge {
  from: string;
  to: string;
  /** Selected capability labels (braced `consumes` form); empty for a
   *  whole-unit consumes. */
  capabilities: string[];
  loc: ArchLoc;
}

/** ADR 0854: a handler, service operation or provider operation. */
export interface ArchMember {
  unit: string;
  kind: "service" | "agent" | "provider";
  container: string;
  handler: string;
  loc: ArchLoc;
}

/** ADR 0854: one capability a handler uses (its resolved `given`). */
export interface ArchUse {
  capability: string;
  /** The unit declaring the capability: this unit, a consumed one, or `bynk`. */
  from: string | null;
  inherited: boolean;
  loc: ArchLoc;
  stubbedIn: { suite: string; loc: ArchLoc }[];
}

export interface ArchHandlerUses {
  member: ArchMember;
  uses: ArchUse[];
}

/** ADR 0854: a declared event, who emits it and who subscribes. */
export interface ArchEvent {
  owner: string;
  name: string;
  loc: ArchLoc;
  emitters: { member: ArchMember; loc: ArchLoc }[];
  subscribers: { member: ArchMember; delivery: string; loc: ArchLoc }[];
}

export interface ArchModel {
  nodes: ArchNode[];
  edges: ArchEdge[];
  /** ADR 0854 (bynk v0.625.3). Absent from older servers. */
  events?: ArchEvent[];
}

/** The payload the extension host embeds into the webview. Unlike
 *  `SequencePayload`/`DocPayload`, there is no single `uri` — every location
 *  in the model already carries its own (see the module doc). */
export interface ArchPayload {
  model: ArchModel;
}

/** A click-to-code message the webview posts back to the extension host —
 *  the same shape `RevealMessage` (`webview/types.ts`) uses, kept as its own
 *  type here so this module has no import dependency on the sequence view's. */
export interface ArchRevealMessage {
  type: "reveal";
  uri: string;
  range: Range;
}
