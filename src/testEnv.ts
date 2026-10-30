import type * as vscode from "vscode";

import type { SeedState } from "./testSeedState";
import type { DriverSupport } from "./testStream";
import type { ViewRefresh } from "./viewRefresh";

/** What a run and a discovery share: the controller, the Problems collection, the seed
 *  memory and the views' symbol cache. Owned by `registerTesting`, passed in. */
export interface RunEnv {
  ctrl: vscode.TestController;
  problems: vscode.DiagnosticCollection;
  seeds: SeedState;
  hub: ViewRefresh;
  driverSupport: DriverSupport;
}
