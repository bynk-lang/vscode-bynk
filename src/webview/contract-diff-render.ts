// #2467: the contract-diff view's renderer. The sentence and label helpers
// are DOM-free and unit-tested (`contract-diff-render.unit.test.ts`); the DOM
// construction below them is not, for the reason `wire-render.ts` gives.

import type { CdChange, CdLedgerState, CdLoc, CdLockState, CdModel, CdPayload, CdService, Range } from "./contractDiffTypes";

/** `orders.Cart` -> `orders.Cart`; kept as a function so the label has one
 *  home if it ever needs to change. */
export function changeLabel(c: CdChange): string {
  return `${c.kind} ${c.unit}.${c.name}`;
}

/** One line for the header: how many of each, in the view's own words. The
 *  schema-change counts and the service-contract counts are separate groups,
 *  because "breaking" means a different thing in each (`bynk check` refuses a
 *  breaking schema change; a service change is refused at deploy whatever its
 *  verdict). */
export function summarySentence(model: CdModel): string {
  const breaking = model.changes.filter((c) => c.class === "breaking").length;
  const compatible = model.changes.length - breaking;
  const moved = model.services.length;
  if (model.changes.length === 0 && moved === 0) return "No boundary changes since the lock.";
  const groups: string[] = [];
  if (model.changes.length > 0) {
    const kinds: string[] = [];
    if (breaking > 0) kinds.push(`${breaking} breaking`);
    if (compatible > 0) kinds.push(`${compatible} compatible`);
    groups.push(`${kinds.join(", ")} schema change${model.changes.length === 1 ? "" : "s"}`);
  }
  if (moved > 0) groups.push(`${moved} service contract${moved === 1 ? "" : "s"} changed${serviceVerdicts(model.services)}`);
  return groups.join("; ") + ".";
}

/** ` (1 breaking, 2 compatible for callers)` for the service rows that carry a
 *  verdict; empty when none does. Rows without one are counted only as
 *  changed. "Compatible" is for callers only: the deploy is still refused. */
function serviceVerdicts(services: CdService[]): string {
  const breaking = services.filter((s) => s.compat?.verdict === "breaking").length;
  const compatible = services.filter((s) => s.compat?.verdict === "compatible").length;
  const parts: string[] = [];
  if (breaking > 0) parts.push(`${breaking} breaking`);
  if (compatible > 0) parts.push(`${compatible} compatible for callers`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** What to say when there is no readable `bynk.schema.lock` to diff against;
 *  `null` when there is one. */
export function lockSentence(state: CdLockState): string | null {
  switch (state) {
    case "absent":
      return (
        "There is no bynk.schema.lock, so events and agent state have nothing to be compared with. " +
        "It is created the first time the project is built for deploy."
      );
    case "unreadable":
      return "bynk.schema.lock could not be read (see the diagnostic on bynk.toml), so events and agent state were not compared.";
    case "read":
      return null;
  }
}

export const NO_CHANGES_SENTENCE = "Every event and agent class matches the lock.";

export function ledgerSentence(state: CdLedgerState, rows: number): string | null {
  switch (state) {
    case "absent":
      return "There is no bynk.deploy.lock, so nothing is recorded as live: service contracts have nothing to be compared with.";
    case "unreadable":
      return "bynk.deploy.lock could not be read, so service contracts were not compared.";
    case "read":
      return rows === 0 ? "No service contract differs from what bynk.deploy.lock records as live." : null;
  }
}

export function serviceSentence(s: CdService): string {
  switch (s.status) {
    case "changed":
      return `${s.service}: contract ${short(s.live)} → ${short(s.current)}`;
    case "added":
      return `${s.service}: not in the live record (now ${short(s.current)})`;
    case "removed":
      return `${s.service}: live as ${short(s.live)}, no longer provided`;
  }
}

function short(hash: string | null): string {
  return hash ? hash.slice(0, 8) : "—";
}

/** The label of a service row: the verdict when the compiler could classify
 *  the change, otherwise the plain status. A compatible change is labelled for
 *  callers, because the deploy gate still refuses it. */
export function serviceClass(s: CdService): string {
  if (!s.compat) return s.status;
  return s.compat.verdict === "compatible" ? "compatible for callers" : "breaking";
}

/** The row's style class. Neither verdict gets the schema table's green: a
 *  service change is refused at deploy either way. */
export function serviceRowClass(s: CdService): string {
  if (!s.compat) return "cd-row cd-changed";
  return s.compat.verdict === "breaking" ? "cd-row cd-breaking" : "cd-row cd-service-compatible";
}

/** How many reasons a row shows before the rest fold behind a "more" toggle. */
export const REASONS_SHOWN = 3;

/** A service row's reasons, breaking first (the server sorts them, but the view
 *  does not rely on it) with the rest of an order kept stable, split into the
 *  lines shown and the lines folded. */
export function foldReasons(reasons: string[], limit = REASONS_SHOWN): { shown: string[]; folded: string[] } {
  const breaking = reasons.filter((r) => r.startsWith("breaking "));
  const ordered = [...breaking, ...reasons.filter((r) => !r.startsWith("breaking "))];
  return { shown: ordered.slice(0, limit), folded: ordered.slice(limit) };
}

/** Everything the DOM needs to draw one service row, so that what a row says
 *  is testable without a DOM. `compat` may be `null` or absent (an older
 *  `bynk-lsp`); both mean no verdict. */
export interface ServiceRowView {
  className: string;
  label: string;
  sentence: string;
  shown: string[];
  folded: string[];
}

export function serviceRowView(s: CdService): ServiceRowView {
  return {
    className: serviceRowClass(s),
    label: serviceClass(s),
    sentence: serviceSentence(s),
    ...foldReasons(s.compat?.reasons ?? []),
  };
}

/** The note under the services list, built from the rows it sits under. A
 *  verdict says whether a caller of the live contract still works; it does
 *  not make the deploy allowed. */
export function serviceNote(services: CdService[]): string {
  let note =
    "Service rows compare contract hashes with the deploy ledger. A changed hash means a live caller " +
    "would be refused (bynk.deploy.contract_skew)";
  note += services.some((s) => s.compat?.verdict === "compatible") ? ", even when the change is compatible for callers." : ".";
  // Only a changed row can carry a verdict: an added or removed service has
  // no live contract to compare with.
  if (services.some((s) => s.status === "changed" && !s.compat)) {
    note += " A changed row with no verdict has no recorded structure to classify yet; the next whole-project deploy records it.";
  }
  return note;
}

// ---------------------------------------------------------------------
// DOM construction.
// ---------------------------------------------------------------------

type Reveal = (uri: string, range: Range) => void;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clickable(node: HTMLElement, loc: CdLoc | null, reveal: Reveal): void {
  if (!loc) return;
  node.classList.add("cd-clickable");
  node.addEventListener("click", () => reveal(loc.uri, loc.range));
}

export function renderContractDiff(root: HTMLElement, payload: CdPayload, reveal: Reveal): void {
  const model = payload.model;
  root.replaceChildren();
  root.append(el("h1", undefined, "Contract Diff"), el("p", "cd-summary", summarySentence(model)));

  const changes = el("section", "cd-card");
  changes.append(el("h2", undefined, "Events and agents — against bynk.schema.lock"));
  const lockNote = lockSentence(model.lock);
  if (lockNote) {
    changes.append(el("p", "cd-muted", lockNote));
  } else if (model.changes.length === 0) {
    changes.append(el("p", "cd-muted", NO_CHANGES_SENTENCE));
  } else {
    const table = el("table", "cd-table");
    for (const c of model.changes) {
      const row = el("tr", `cd-row cd-${c.class}`);
      row.append(
        el("td", "cd-class", c.class),
        el("td", "cd-name", changeLabel(c)),
        el("td", "cd-detail", `${c.detail} (locked at v${c.lockedVersion})`),
      );
      clickable(row, c.loc, reveal);
      table.append(row);
    }
    changes.append(table);
  }
  root.append(changes);

  const services = el("section", "cd-card");
  services.append(el("h2", undefined, "Services — against bynk.deploy.lock"));
  const note = ledgerSentence(model.ledger, model.services.length);
  if (note) services.append(el("p", "cd-muted", note));
  if (model.services.length > 0) {
    const table = el("table", "cd-table");
    for (const s of model.services) {
      const view = serviceRowView(s);
      const row = el("tr", view.className);
      const detail = el("td", "cd-detail", view.sentence);
      for (const reason of view.shown) detail.append(el("div", "cd-reason", reason));
      if (view.folded.length > 0) {
        const more = el("details", "cd-more");
        more.append(el("summary", "cd-reason", `${view.folded.length} more`));
        for (const reason of view.folded) more.append(el("div", "cd-reason", reason));
        detail.append(more);
      }
      row.append(el("td", "cd-class", view.label), el("td", "cd-name", `${s.context} (${s.environment})`), detail);
      clickable(row, s.loc, reveal);
      table.append(row);
    }
    services.append(table, el("p", "cd-muted", serviceNote(model.services)));
  }
  root.append(services);
}
