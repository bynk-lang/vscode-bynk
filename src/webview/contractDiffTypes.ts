// #2467: hand-mirrored TS types for `bynk-lsp`'s `bynk/contractDiff` wire
// shape (`bynk-lsp/src/contract_diff_request.rs`), maintained by hand like
// `architectureTypes.ts`. Project-scoped, so every location carries its own
// `uri`.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface CdLoc {
  uri: string;
  range: Range;
}

/** `compatible`: a build accepts it. `breaking`: `bynk check` refuses it. */
export type CdClass = "compatible" | "breaking";

export interface CdChange {
  kind: "event" | "agent";
  unit: string;
  name: string;
  class: CdClass;
  /** The schema version (event) or state version (agent) the lock records. */
  lockedVersion: number;
  detail: string;
  loc: CdLoc | null;
}

/** Whether a service row is present, changed or gone: a hash comparison
 *  (ADR 0491). The verdict, when there is one, is `CdService.compat`. */
export type CdServiceStatus = "changed" | "added" | "removed";

/** bynk#2485: whether callers of the live contract still work against the
 *  contract this source provides, from `bynk-check`'s classifier. */
export interface CdCompat {
  verdict: CdClass;
  /** One line per difference, breaking ones first:
   *  `breaking response.at: the caller requires …`. */
  reasons: string[];
}

export interface CdService {
  environment: string;
  context: string;
  service: string;
  status: CdServiceStatus;
  live: string | null;
  current: string | null;
  /** Only on a `changed` row whose live and current structure the ledger and
   *  the build both recorded; `null` otherwise (an older ledger holds hashes
   *  only), in which case the row is a hash comparison and no more. Absent
   *  from a `bynk-lsp` older than bynk#2485. */
  compat?: CdCompat | null;
  loc: CdLoc | null;
}

export type CdLedgerState = "absent" | "unreadable" | "read";

/** What reading `bynk.schema.lock` gave. */
export type CdLockState = "absent" | "unreadable" | "read";

export interface CdModel {
  lock: CdLockState;
  ledger: CdLedgerState;
  changes: CdChange[];
  services: CdService[];
}

export interface CdPayload {
  model: CdModel;
  uri: string;
}

export interface CdRevealMessage {
  type: "reveal";
  uri: string;
  range: Range;
}
