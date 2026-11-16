// @webview-entry mermaid
// The one copy of Mermaid the extension ships (`out/mermaid.js`, model-diagrams
// slice 0). Before this, each Mermaid view bundled its own copy, about 5.3 MB
// each. The views that still draw with Mermaid load this script first, and
// `scripts/build.mjs` resolves their `import mermaid from "mermaid"` to the
// global it sets, so their own bundles stay small.

import mermaid from "mermaid";

(globalThis as unknown as { __BYNK_MERMAID__: typeof mermaid }).__BYNK_MERMAID__ = mermaid;
