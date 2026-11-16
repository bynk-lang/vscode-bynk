// @webview-entry elk
// The one copy of ELK the extension ships (`out/elk.js`, model-diagrams slice
// 6), the layout engine behind the architecture map, the component view, the
// agent state machine and the model diff. Each of those pages loads this
// script first, and `scripts/build.mjs` resolves their
// `import ELK from "elkjs/lib/elk.bundled.js"` to the global it sets, so ELK
// (about 1.5 MB) ships once rather than in every page.

import ELK from "elkjs/lib/elk.bundled.js";

(globalThis as unknown as { __BYNK_ELK__: typeof ELK }).__BYNK_ELK__ = ELK;
