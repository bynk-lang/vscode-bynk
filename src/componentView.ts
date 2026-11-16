// Model-diagrams slice 5: "Bynk: Show Component View" — one context opened
// up as a UML component diagram (`design/tracks/model-diagrams.md` §8). A
// projection of the same `bynk/architectureModel` the map draws (D4), so the
// request goes through the map's cache and the two views agree.
//
// A `LivePanel` that follows the cursor's context (`followScope: "unit"`: a
// file belongs to one unit), and reports the service or agent under the
// cursor so the page can mark that part. Cross-view navigation (§9): an
// operation's ↗ opens its sequence diagram; a neighbouring context's ↗ opens
// that context's component view (`openComponent`, handled in `diagramHost.ts`
// for every diagram page).

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { requestArchitectureModel } from "./architectureMap";
import { unitOfUri } from "./diagram/structure/component";
import { diagramMessages } from "./diagramHost";
import { commandTarget, LivePanel, type ViewTarget } from "./livePanel";
import { isOpenSequence } from "./sequenceMessages";
import type { ViewRefresh } from "./viewRefresh";
import type { ComponentPayload } from "./webview/architectureTypes";
import { allowedPageUri, revealLocation } from "./webviewHost";

export function registerComponentView(
  context: vscode.ExtensionContext,
  hub: ViewRefresh,
): LivePanel<ComponentPayload> {
  const shared = diagramMessages(context, "component view");
  const view = new LivePanel<ComponentPayload>(context, {
    viewType: "bynkComponentView",
    commandLabel: "Show Component View",
    script: "component.js",
    globalName: "__BYNK_COMPONENT_MODEL__",
    followsCursor: true,
    followScope: "unit",
    scopeNoun: "context",
    title: (p) => (p ? `Bynk Components: ${p.unit}` : "Bynk Component View"),
    request: async (client: LanguageClient, target: ViewTarget, h: ViewRefresh, fresh: boolean) => {
      const model = await requestArchitectureModel(client, h, target.uri, fresh);
      const unit = model ? unitOfUri(model, target.uri) : null;
      return model && unit ? { model, unit } : null;
    },
    missMessage: "Bynk: no context or adapter declared in this file (or no committed analysis yet).",
    onMessage: (message) => {
      if (shared.handle(message)) return;
      if (isOpenSequence(message) && allowedPageUri(message.uri)) {
        void revealLocation(message.uri, message.range).then(() =>
          vscode.commands.executeCommand("bynk.showSequenceDiagram", message.uri, message.range.start),
        );
      }
    },
    onDispose: () => shared.dispose(),
  }, hub);
  context.subscriptions.push(
    view,
    vscode.commands.registerCommand("bynk.showComponentView", (uriArg?: unknown, positionArg?: unknown) => {
      const target = commandTarget(uriArg, positionArg, true) ?? commandTarget(uriArg, undefined, false);
      if (!target) {
        void vscode.window.showErrorMessage("Bynk: Show Component View needs a .bynk file open.");
        return;
      }
      return view.show(target);
    }),
  );
  return view;
}
