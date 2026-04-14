# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A VS Code extension for editing Super Mario World (SNES) ROM files. Treats the ROM as a virtual filesystem — opening a ROM mounts it as a navigable folder tree in VS Code. Custom editors handle level viewing/editing.

See `docs/` for deeper documentation:
- `docs/architecture.md` — extension model, virtual FS, provider structure, webview messaging
- `docs/rom-format.md` — SMW binary structures (LoROM mapping, level pointers, GFX, palettes)
- `docs/level-rendering.md` — current renderer state and full pipeline plan

## Branch strategy

- `master` — do not commit here
- `develop` — integration base; all feature branches merge here
- `feature/*` — branch off `develop`, one concern per branch

Do not add `Co-Authored-By: Claude` lines to commits.

## Commands

```bash
npm install            # install dependencies
npm run compile        # build extension + webviews (webpack, dev mode)
npm run watch          # rebuild on file changes (use during development)
npm run package        # production build
npm run lint           # ESLint src/ (TypeScript)
npm run lint:fix       # auto-fix
npm run test:unit      # Vitest unit tests
npm run test:unit:watch
```

To run the extension in VS Code: open the repo, press **F5** (launches Extension Development Host).

## Architecture

### Extension host (Node.js)

```
src/extension.ts          — activate(); registers all providers and commands
src/RomSession.ts         — holds the open SmwRom instance + slug for the session
src/rom/                  — pure ROM parsing, no VS Code dependency
  addressing.ts           — LoROM address ↔ file offset mapping
  RomFile.ts              — binary ROM wrapper with SNES-addressed reads
  SmwRom.ts               — SMW-specific pointer tables, header validation
  LevelParser.ts          — layer-1 object + sprite stream parser
  GraphicsDecoder.ts      — 3BPP/4BPP tile decoder, BGR555 palette decoder
src/providers/
  SmwFileSystemProvider.ts  — vscode.FileSystemProvider for smwrom:// URIs
  RomExplorerProvider.ts    — TreeDataProvider for the SMW Explorer sidebar
  LevelEditorProvider.ts    — CustomReadonlyEditorProvider for .smwlevel files
```

### Virtual filesystem

When a ROM is opened, `SmwFileSystemProvider` mounts it at `smwrom://<slug>/`:
```
smwrom://<slug>/
  levels/
    000.smwlevel    ← JSON descriptor; opens in LevelEditorProvider
    001.smwlevel
    ...
```
Each `.smwlevel` "file" contains `{ romPath, levelIndex }`. The editor reads it, loads the actual binary data from the ROM, and sends it to the webview.

### Webview layer

Webviews are sandboxed HTML/JS pages bundled by webpack to `dist/webview/`.

```
src/webview/
  levelEditor/main.ts     — webview entry; receives parsed level, calls renderLevel()
  shared/levelRenderer.ts — Canvas renderer (no VS Code dep; usable in any browser ctx)
```

**Message protocol** (`LevelEditorProvider` ↔ webview):
- Webview → Extension: `{ type: 'ready' }` on mount
- Extension → Webview: `{ type: 'load', level, levelIndex }` or `{ type: 'error', message }`

### Adding a new editor

1. Add a new `filenamePattern` entry in `contributes.customEditors` in `package.json`
2. Create `src/providers/MyEditorProvider.ts` implementing `CustomReadonlyEditorProvider`
3. Create `src/webview/myEditor/main.ts` as the webview entry point
4. Add the webview entry to `webpack.config.js`
5. Register the provider in `src/extension.ts`

### Key SNES/SMW domain facts

- SMW is **LoROM**: SNES `$XXYYYY` → offset `(bank & 0x7F) * 0x8000 + (addr - 0x8000)`. Banks `$7E–$7F` = WRAM, not in file.
- Copier header: 512 bytes prepended in some `.smc` files. Detected by `fileSize % 1024 === 512`.
- Level pointers: lo/hi/bank split tables at `$05E000` / `$05E200` / `$05E400`.
- Palettes: BGR555 — `r=(v&0x1F)<<3`, `g=((v>>5)&0x1F)<<3`, `b=((v>>10)&0x1F)<<3`.
- Map16 tiles: 16×16 definitions at `$0D8000` (lo) / `$0DC000` (hi).

### ROM/patch files

`*.smc`, `*.sfc`, `*.rom`, `*.ips`, `*.bps`, `test/roms/` are gitignored. **Never commit ROM or patch files.**
