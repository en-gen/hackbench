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
- **Used for:** SPC700 audio playback in the music player webview.

HackBench distributes this library bundled into its webview JavaScript
output. Under LGPL-2.1 §6, users are entitled to replace the library
with a modified version. To exercise that right:

1. Fork this repository.
2. Replace `node_modules/@smwcentral/spc-player` with your modified
   build (same directory layout — `dist/spc.js` is the entry point).
3. Run `npm run compile` (webpack rebuilds the music player webview
   against your modified copy).

The full text of the LGPL-2.1 is available at
https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html and in the
`node_modules/@smwcentral/spc-player/LICENSE` file after installation.

---

## snesrev/smw — vendored LC_LZ2 decompressor (test-only)

- **License:** MIT
- **Copyright:** (c) 2023 snesrev, (c) 2021 elzo_d
- **Upstream:** https://github.com/snesrev/smw
- **Vendored at:** [`tools/vendor/snesrev-smw/`](./tools/vendor/snesrev-smw/)
- **Used for:** generating byte-for-byte reference fixtures at
  `test/fixtures/gfx/` that validate HackBench's own LC_LZ2
  implementation (`src/rom/LcLz2.ts`). The Python decompressor is
  invoked only by the developer-run script
  [`tools/dump-vanilla-gfx.py`](./tools/dump-vanilla-gfx.py) when
  regenerating fixtures; it is **not shipped in the packaged
  extension**.

The MIT license text is preserved verbatim in
[`tools/vendor/snesrev-smw/LICENSE.txt`](./tools/vendor/snesrev-smw/LICENSE.txt).

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
