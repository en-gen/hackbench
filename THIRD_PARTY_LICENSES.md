# Third-Party Licenses

HackBench bundles and links against third-party components that are
distributed under their own licenses. This file lists those components
and preserves their required notices.

HackBench's own code is MIT-licensed, but bundled components below keep
their own terms. The LGPL-2.1 component in particular imposes obligations
on any distribution of HackBench (not just on its own source).

---

## @smwcentral/spc-player

- **License:** LGPL-2.1-only
- **Copyright:** Telinc1
- **Upstream:** https://github.com/telinc1/smwcentral-spc-player
- **Used for:** SPC700 audio playback in the Music panel.
- **Contains:** Blargg's snes_spc and logic from cosinusoidally's
  snes_spc_js, both LGPL-2.1 in their own right (upstream README).

The Theia shell does NOT bundle this library. `dist/spc.js` and
`dist/spc.wasm` are served as files, straight out of `node_modules`, by
`theia/extension/src/node/spc-assets.ts`, and the frontend loads them by
URL. That makes the LGPL-2.1 §6 relink right easier to exercise, not
harder: replacing the files replaces the library, with no rebuild of
anything that links against it.

1. Replace `node_modules/@smwcentral/spc-player/dist/spc.js` and
   `spc.wasm` with your modified build.
2. Restart the app. The Theia shell picks them up on next load.

The legacy VS Code extension under `src/webview/` still bundles the
library into its webview output through webpack, so a modified copy there
needs `npm run compile` as well.

The full text of the LGPL-2.1 is available at
https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html and in the
`node_modules/@smwcentral/spc-player/LICENSE` file after installation.

---

## VS Code API (`@types/vscode`, `vscode` module)

- **License:** MIT (type declarations); the VS Code extension host API
  is made available to extensions by Microsoft's VS Code. Consuming
  the API from an extension does not create license obligations beyond
  the type-declaration MIT terms.

---

## Build-time dependencies

All development dependencies listed in `package.json` under
`devDependencies` (TypeScript, webpack, vitest, ESLint, etc.) are
consumed only at build time and are not redistributed as part of the
packaged extension. Their licenses are available under their respective
entries in `node_modules/`.

---

## Documentation sources

HackBench's `docs/` folder contains HackBench's own writing: derivations
traced against the cart, design proposals, and records of what the code
does. It does not reproduce third-party documentation.

The published SNES and SMW references this project relies on are listed,
with links, in [docs/references.md](./docs/references.md). Those works
remain under their authors' terms and are not redistributed here.

---

## Mushroom icon

- **License:** Public domain (below the threshold of originality, per Wikimedia Commons)
- **Author:** Lucian Novosel, after Nintendo's Super Mushroom design
- **Upstream:** https://commons.wikimedia.org/wiki/File:Novosel_mushroom.svg
- **Used for:** the title-bar mark (`build/icons/icon.svg`) and the window and taskbar icon (`build/icons/app/`), which adds a gray gradient and white backing.
