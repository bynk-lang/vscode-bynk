// #157: the Contract Diff panel's optional scope — a context and/or an
// environment — as a dependency-free presentation filter (no `vscode` import,
// so the unit tests compile against it directly).
//
// The rule: a filter narrows the *service* rows, which are the only rows that
// carry a context and an environment. Boundary changes (events and agent
// state, compared with `bynk.schema.lock`) belong to the whole project and to
// no environment, so a filtered view hides them, and says so: `applyFilter`
// reports how many it hid and the panel shows that count beside the chip, so a
// scoped view is never mistaken for "no other changes".

import { sameContext } from "./contextNames";
import type { CdModel, CdService } from "./webview/contractDiffTypes";

export interface ContractDiffFilter {
  /** A dotted context name (`shop.payment`); a Worker key (`shop-payment`) matches too. */
  context?: string;
  environment?: string;
}

export interface FilteredModel {
  model: CdModel;
  hiddenChanges: number;
  hiddenServices: number;
}

/** Whether `filter` narrows anything; an empty filter shows everything. */
export function isActive(filter: ContractDiffFilter | null | undefined): filter is ContractDiffFilter {
  return !!filter && (!!filter.context || !!filter.environment);
}

export function matchesService(filter: ContractDiffFilter, s: CdService): boolean {
  if (filter.context && !sameContext(filter.context, s.context)) return false;
  if (filter.environment && filter.environment !== s.environment) return false;
  return true;
}

export function applyFilter(model: CdModel, filter: ContractDiffFilter | null | undefined): FilteredModel {
  if (!isActive(filter)) return { model, hiddenChanges: 0, hiddenServices: 0 };
  const services = model.services.filter((s) => matchesService(filter, s));
  return {
    model: { ...model, changes: [], services },
    hiddenChanges: model.changes.length,
    hiddenServices: model.services.length - services.length,
  };
}

/** "Showing shop.payment in staging" — the chip's label (without the clear action). */
export function filterLabel(filter: ContractDiffFilter): string {
  const parts: string[] = [];
  if (filter.context) parts.push(filter.context);
  if (filter.environment) parts.push(filter.context ? `in ${filter.environment}` : `environment ${filter.environment}`);
  return `Showing ${parts.join(" ")}`;
}

/** What the chip says was left out, or `null` when nothing was. */
export function hiddenSentence(hiddenChanges: number, hiddenServices: number): string | null {
  const parts: string[] = [];
  if (hiddenServices > 0) parts.push(`${hiddenServices} other service contract${hiddenServices === 1 ? "" : "s"}`);
  if (hiddenChanges > 0) {
    parts.push(`${hiddenChanges} event and agent change${hiddenChanges === 1 ? "" : "s"} (project-wide, not tied to a context)`);
  }
  return parts.length > 0 ? `Hidden by the filter: ${parts.join(" and ")}.` : null;
}

/** Read a filter from an untrusted command argument. Empty strings are dropped. */
export function parseFilter(value: unknown): ContractDiffFilter | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { context?: unknown; environment?: unknown };
  const filter: ContractDiffFilter = {};
  if (typeof v.context === "string" && v.context !== "") filter.context = v.context;
  if (typeof v.environment === "string" && v.environment !== "") filter.environment = v.environment;
  return isActive(filter) ? filter : undefined;
}
