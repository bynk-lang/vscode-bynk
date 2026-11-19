// #218: the request timing page's payload and messages, shared by the host
// (`requestTiming.ts`) and the page (`timing.ts`).

import type { TimingSource } from "../requestTimingCore";

export interface TimingChoice {
  id: string;
  label: string;
}

export interface TimingPayload {
  source: TimingSource;
  /** A second trace of the same route, stacked under the first. */
  compare?: TimingSource;
  /** The traces of this route (newest first), for the picker and the comparison. */
  choices: TimingChoice[];
}

/** The host's update into the live page. */
export interface TimingUpdate {
  type: "timing";
  payload: TimingPayload;
}
