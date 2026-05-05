# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**HackBench** - a VS Code extension for editing Super Mario World (SNES) ROM files. Opening a ROM mounts it as a navigable virtual folder tree. Custom editors handle level, palette, and GFX tile-sheet viewing/editing. Package name `hackbench`; marketplace ID `engenb.hackbench`; command/view/viewType IDs use the `hackbench.*` namespace.

## Branch strategy

- `main` - do not commit here directly
- `develop` - integration base; all PRs target here
- `feature/*` - branch off `develop`, one concern per branch
- After merging a PR: `git checkout develop && git pull origin develop && git checkout -b feature/<next>`

Do not add `Co-Authored-By: Claude` lines to commits. Do not add "Generated with Claude Code" footers or any AI attribution to PR bodies or commit messages.

## Commands

```bash
npm run compile        # webpack dev build - extension + all four webview bundles
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
extension.ts              - activate(); registers all providers and commands
RomSession.ts             - holds the open SmwRom + URI slug for the session
rom/                      - pure ROM parsing, zero VS Code dependency
providers/                - VS Code integration layer (FileSystem, TreeView, editors)
webview/                  - sandboxed browser bundles, one subfolder per editor
```

### ROM parsing layer (`src/rom/`)

All modules are plain TypeScript with no VS Code imports - independently testable.

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
| `SmwFileSystemProvider` | - | Implements `vscode.FileSystemProvider` for `smwrom://` |
| `RomExplorerProvider` | - | TreeDataProvider sidebar |
| `LevelEditorProvider` | `.smwlevel` | Level tile grid + object/sprite overlay |
| `PaletteEditorProvider` | `.smwpalette` | Palette group browser |
| `GfxViewerProvider` | `.smwgfx` | Tile sheet viewer |

### Webview layer (`src/webview/`)

Webpack bundles each editor's `main.ts` into `dist/webview/<name>.js`. Communication is via `postMessage`: webview sends `{ type: 'ready' }`, extension replies `{ type: 'load', ...payload }` or `{ type: 'error', message }`. GFX viewer payload includes `rawBytes` + `defaultBpp` for client-side re-decode.

## Knowledge Integration (External Disassembly)

Domain library: `C:\Projects\SMWDisX`. SMW ROM constants, handler ports, and ASM-behavior questions are authoritative there - not in this file. This section is the router; `SMWDisX` is the store.

**Global SNES rulebook** (addressing, BGR555, VRAM layout): `@C:\Projects\SMWDisX\.claude\rules\snes-global.md` - load this whenever any `src/rom/` task touches color math, LoROM offsets, or VRAM slot assignments.

**Pillar 1 - Scoped Rules (`src/rom/`)**: Any work touching `src/rom/` requires cross-referencing the matching bank folder in `SMWDisX`. Do not port or assert ROM behavior without tracing to an ASM line there first.

**Pillar 2 - Context Budgeting**: Load domain knowledge on demand using `@C:\Projects\SMWDisX\<bank_xx>\MEMO.md` syntax. Never read entire bank folders speculatively; load only the MEMO.md for the bank(s) directly relevant to the current task.

**Pillar 3 - Memory Snapshot Protocol**: After resolving a complex SNES logic problem (multi-routine control flow, OAM layout, palette tricks), propose a Memory Snapshot: a concise summary for `SMWDisX/<bank_xx>/MEMO.md`. Include the address range covered, the behavior decoded, non-obvious invariants, and the PR that exercised it. Only propose a snapshot when the analysis is non-trivial - single-table lookups do not warrant one.

## Files never to commit

`*.smc`, `*.sfc`, `*.rom`, `*.ips`, `*.bps`, `test/roms/`, `test/magic/` are gitignored.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **hackbench** (7717 symbols, 15553 relationships, 299 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/hackbench/context` | Codebase overview, check index freshness |
| `gitnexus://repo/hackbench/clusters` | All functional areas |
| `gitnexus://repo/hackbench/processes` | All execution flows |
| `gitnexus://repo/hackbench/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
