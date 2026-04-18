# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**HackBench** — a VS Code extension for editing Super Mario World (SNES) ROM files. Opening a ROM mounts it as a navigable virtual folder tree. Custom editors handle level, palette, and GFX tile-sheet viewing/editing. Package name `hackbench`; marketplace ID `engenb.hackbench`; command/view/viewType IDs use the `hackbench.*` namespace.

## Branch strategy

- `master` — do not commit here directly
- `develop` — integration base; all PRs target here
- `feature/*` — branch off `develop`, one concern per branch
- After merging a PR: `git checkout develop && git pull origin develop && git checkout -b feature/<next>`

Do not add `Co-Authored-By: Claude` lines to commits.

## Commands

```bash
npm run compile        # webpack dev build — extension + all four webview bundles
npm run watch          # rebuild on save
npm run package        # production build (minified, hidden source maps)
npm run lint           # ESLint src/ (.ts files)
npm run lint:fix       # auto-fix
npm run test:unit      # Vitest unit tests (single run)
npm run test:unit:watch
```

To run a single test file: `npx vitest run test/suite/unit/GraphicsDecoder.test.ts`

To launch the extension: **F5** in VS Code (Extension Development Host).

## Architecture

### Extension host (`src/`)

```
extension.ts              — activate(); registers all providers and commands
RomSession.ts             — holds the open SmwRom + URI slug for the session
rom/                      — pure ROM parsing, zero VS Code dependency
providers/                — VS Code integration layer (FileSystem, TreeView, editors)
webview/                  — sandboxed browser bundles, one subfolder per editor
```

### ROM parsing layer (`src/rom/`)

All modules are plain TypeScript with no VS Code imports — independently testable.

| File | Purpose |
|------|---------|
| `addressing.ts` | LoROM SNES address ↔ file offset conversion |
| `RomFile.ts` | Binary ROM wrapper; all reads go through SNES-addressed helpers |
| `SmwRom.ts` | SMW pointer tables, level list, header parsing |
| `LcLz2.ts` | LC_LZ2 decompressor (used for all GFX files) |
| `GfxLoader.ts` | GFX file loading: pointer tables → decompress → decode tiles into VRAM slots |
| `GraphicsDecoder.ts` | 2BPP/3BPP/4BPP tile decoders; BGR555 → RGBA conversion |
| `PaletteLoader.ts` | ROM palette groups → CGRAM rows |
| `LevelParser.ts` | Layer-1 object + sprite stream parser; level header |
| `ObjectExpander.ts` | Level object → 2D Map16 tile grid |

### Virtual filesystem

Opening a ROM mounts `smwrom://<slug>/`. Each virtual file is a small JSON descriptor; the editor provider reads it and fetches actual ROM data on demand.

```
smwrom://<slug>/
  levels/000.smwlevel     ← { romPath, levelIndex }
  palettes/global.smwpalette
  gfx/GFX00.smwgfx        ← { romPath, gfxIndex }
```

### Providers (`src/providers/`)

| Provider | Virtual file | Editor |
|----------|-------------|--------|
| `SmwFileSystemProvider` | — | Implements `vscode.FileSystemProvider` for `smwrom://` |
| `RomExplorerProvider` | — | TreeDataProvider sidebar |
| `LevelEditorProvider` | `.smwlevel` | Level tile grid + object/sprite overlay |
| `PaletteEditorProvider` | `.smwpalette` | Palette group browser |
| `GfxViewerProvider` | `.smwgfx` | Tile sheet viewer |

### Webview layer (`src/webview/`)

Webpack bundles each editor's `main.ts` into `dist/webview/<name>.js`. All communication is via `postMessage`.

**Standard protocol:**
- Webview → Extension: `{ type: 'ready' }` on mount
- Extension → Webview: `{ type: 'load', ...payload }` or `{ type: 'error', message }`

**GFX viewer payload** also includes `rawBytes` (decompressed tile data) and `defaultBpp` so the webview can re-decode client-side when the BPP selector changes.

### Adding a new editor

1. `package.json` → `contributes.customEditors`: add filename pattern
2. `src/providers/MyEditorProvider.ts` — implement `CustomReadonlyEditorProvider`
3. `src/webview/myEditor/main.ts` — webview entry
4. `webpack.config.js` — add entry to the webview configs array
5. `src/extension.ts` — register provider in `activate()`

## GFX / graphics domain

- **50 GFX files** (GFX00–GFX31 hex = indices 0–49). Pointer tables at `$00B992` (lo), `$00B9C4` (hi), `$00B9F6` (bank).
- **3BPP is the default format** for standard 3072-byte files (128 tiles, fills a VRAM slot exactly). Only files whose decompressed size divides by 32 but not by 24 are 4BPP. 2BPP is used for some BG Layer 2 files. Auto-detected in `GfxLoader.loadGfxFile()`.
- **VRAM slots**: fg1=`$000`, fg2=`$080`, fg3=`$100`, an1=`$180`, an2=`$200`, bg1=`$280` (128 chars each).
- **Palettes**: BGR555 — bit-replicate for accurate range: `(c5 << 3) | (c5 >> 2)`. 16 CGRAM rows: rows 0–1 BG, 2–3 FG terrain, 4–8 sprites, 13 player (Mario).

## Key SNES/SMW domain facts

- **LoROM**: SNES `$XXYYYY` → file offset `(bank & 0x7F) * 0x8000 + (addr & 0x7FFF)`. Banks `$7E–$7F` = WRAM (not in ROM file).
- **Copier header**: 512 bytes prepended in some `.smc` files — detected by `fileSize % 1024 === 512`.
- **Level pointers**: L1 (`$05E000`) and L2 (`$05E600`) use interleaved **3-byte** entries (lo, hi, bank) at `base + i*3`; `ptr = (bank<<16)|(hi<<8)|lo`. Sprites (`$05EC00`) use **2-byte** entries (lo, hi) at `base + i*2`; bank is always $07 implicit. L2 bank=$FF means a preset BG (65816 subroutine at bank $0D — not decodeable without CPU emulation).
- **Map16**: 16×16 tile definitions at `$0D8000` (page 0) / `$0DC000` (page 1). Each entry = 4 words (TL, BL, TR, BR subtiles, column-major).

## Files never to commit

`*.smc`, `*.sfc`, `*.rom`, `*.ips`, `*.bps`, `test/roms/`, `test/magic/` are gitignored.
