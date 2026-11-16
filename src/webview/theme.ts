// Call `onChange` when VS Code switches colour theme while a webview is open.
//
// VS Code marks the theme on the webview's `<body>` (the `vscode-light`,
// `vscode-dark` and `vscode-high-contrast` classes, and
// `data-vscode-theme-kind`) and updates both on a switch. A view that snapshots
// `--vscode-*` colours into its drawing (the Mermaid views do: Mermaid bakes
// colours into its SVG) watches this to redraw with the new palette.

/** Watch the body for a theme switch; returns a function that stops watching. */
export function watchTheme(onChange: () => void): () => void {
  const body = document.body;
  const kind = (): string => `${body.className}|${body.getAttribute("data-vscode-theme-kind") ?? ""}`;
  let last = kind();
  const observer = new MutationObserver(() => {
    const now = kind();
    if (now === last) return;
    last = now;
    onChange();
  });
  observer.observe(body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-kind"] });
  return () => observer.disconnect();
}
