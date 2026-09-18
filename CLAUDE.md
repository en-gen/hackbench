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
  maps/000.smwmap         ← { romPath, levelIndex }
  palettes/global.smwpalette
  gfx/GFX00.smwgfx        ← { romPath, gfxIndex }
```

Domain terms (slot, map, level, entry map, sub area, launch tile, submap) are
defined in [docs/glossary.md](docs/glossary.md). They are not interchangeable;
using them loosely is how this project produced five different level counts.

### Providers (`src/providers/`)

| Provider | Virtual file | Editor |
|----------|-------------|--------|
| `SmwFileSystemProvider` | - | Implements `vscode.FileSystemProvider` for `smwrom://` |
| `RomExplorerProvider` | - | TreeDataProvider sidebar |
| `MapEditorProvider` | `.smwmap` | Map tile grid + object/sprite overlay |
| `PaletteEditorProvider` | `.smwpalette` | Palette group browser |
| `GfxViewerProvider` | `.smwgfx` | Tile sheet viewer |

### Webview layer (`src/webview/`)

Webpack bundles each editor's `main.ts` into `dist/webview/<name>.js`. Communication is via `postMessage`: webview sends `{ type: 'ready' }`, extension replies `{ type: 'load', ...payload }` or `{ type: 'error', message }`. GFX viewer payload includes `rawBytes` + `defaultBpp` for client-side re-decode.

## The ROM is a collection of lookup tables

Read the tables. Do not model the behaviour.

SMW stores what it needs in tables, and a romhack still has to run on a stock
SNES, so those tables stay where the hardware expects them. Almost every
question this project asks ("which levels exist", "what does this exit lead
to", "what is this level called") is answered by finding the right table and
the right index into it. We are not building an ASM interpreter.

**The table is never the hard part. The index is.** Reading 512 three-byte
entries is trivial. The work is knowing what indexes them. The exit-graph bug
took a day and the answer was that `DATA_05F800` is indexed
`(submapFlag << 8) | rawByte`, with the high byte coming from `OWPlayerSubmap`
and NOT from the translevel: two independent gates in one routine
(`bank_05.asm:7217-7226`). Trace the ASM to learn the index, then read the
table. Do not port the routine.

**If you are describing behaviour, you have lost the thread.** Every defect
this project has shipped came from modelling instead of reading:

| Defect | What it did | What it should have done |
|---|---|---|
| `screenHasExitTrigger` | invented Map16 tile scanning, cited an address with zero hits in the disassembly | read `DATA_05F800` |
| `levelHasObjects()` | invented a "modes 0-20 valid" rule with a fabricated line citation | compare the L1 pointer against the filler |
| exit-graph high byte | derived it from `ExitTableHigh` bit 3, which the game never reads for this | take it from the submap flag |

Both fabricated citations are tracked in issue #311. Neither was caught by
tests; both were caught by someone re-reading the disassembly.

**The one case where table-reading is not enough.** Lunar Magic replaces
routines, not just data. `$05D8B1` holds the `BEQ` opcode `$F0` in a stock ROM
(`bank_05.asm:7224`); in this repo's 6-ROM corpus the 2 stock ROMs hold `$F0`
and the 4 edited ones hold `$22` (a JSL), which is an empirical observation of
ROM bytes, not an ASM claim. On such a ROM the stock table may be bypassed
entirely in favour of a precomputed one. So: read the table, but check that
the routine which reads it still exists. When it does not, fail closed and say
the tier is unavailable. Emitting vanilla-shaped output for a patched ROM is
the worst outcome available, because it is confidently wrong and looks right.

## Knowledge Integration (External Disassembly)

Domain library: `C:\Projects\SMWDisX`. SMW ROM constants, handler ports, and ASM-behavior questions are authoritative there - not in this file. This section is the router; `SMWDisX` is the store.

**Global SNES rulebook** (addressing, BGR555, VRAM layout): `@C:\Projects\SMWDisX\.claude\rules\snes-global.md` - load this whenever any `src/rom/` task touches color math, LoROM offsets, or VRAM slot assignments.

**Pillar 1 - Scoped Rules (`src/rom/`)**: Any work touching `src/rom/` requires cross-referencing the matching bank folder in `SMWDisX`. Do not port or assert ROM behavior without tracing to an ASM line there first.

**Pillar 2 - Context Budgeting**: Load domain knowledge on demand using `@C:\Projects\SMWDisX\<bank_xx>\MEMO.md` syntax. Never read entire bank folders speculatively; load only the MEMO.md for the bank(s) directly relevant to the current task.

**Pillar 3 - Memory Snapshot Protocol**: After resolving a complex SNES logic problem (multi-routine control flow, OAM layout, palette tricks), propose a Memory Snapshot: a concise summary for `SMWDisX/<bank_xx>/MEMO.md`. Include the address range covered, the behavior decoded, non-obvious invariants, and the PR that exercised it. Only propose a snapshot when the analysis is non-trivial - single-table lookups do not warrant one.

## Files never to commit

`*.smc`, `*.sfc`, `*.rom`, `*.ips`, `*.bps`, `test/roms/`, `test/magic/` are gitignored.

<!-- gitnexus:start -->
# Quality gates

These exist because each one corresponds to a defect that actually reached review in this repo. They are not generic best practice.

## Enforced mechanically

Enable the hooks once per clone:

```bash
git config core.hooksPath .githooks
```

`tools/scripts/check-staged-content.sh` runs on pre-commit and in CI. It blocks ROM-derived bytes (the copyright rule in `docs/testing.md`, previously guarded only by `.gitignore`, which `git add -f` silently defeats) and em-dashes in newly added lines. Override with `git commit --no-verify` only with a stated reason in the PR.

## Claim discipline

State the evidence scope with every claim, in comments, docs and commit messages. Not "deterministic" but "byte-identical across 6 cold runs, one machine, Mesen 2.x". Two separate claims in this repo were asserted far past their evidence and nearly shipped: "memory callbacks do not fire under `--testrunner`" (false: only `$7E`-prefixed absolute addresses fail) and a determinism result generalised from three title-screen frames.

Cite ROM behaviour to `SMWDisX file:line`. Trace it; do not copy the assembly into our source. Copies rot when the disassembly is regenerated.

## Oracles must be proven able to fail

Any check, harness or test that reports a verdict needs a committed test proving it goes red on a planted defect. Verdicts that cannot fail are worse than no verdict. Real examples from this repo: a determinism check that printed "all artifacts byte-identical across 5 runs" having compared zero files, and a wrapper that exited 0 on run codes `14,14,14,14,0`.

Never accept a single-case acceptance test. A debounce tuned to level `$105` false-failed 22% of levels with a factually wrong diagnosis. Sweep the range.

## Size budgets

State an expected size in every implementation brief, and stop and ask if the work is heading past it. A Phase 1 task scoped at roughly 150 lines of mechanism returned 813 lines, most of it narration.

Comment-to-code ratio is the house signal: `tools/mesen/l1_dump.lua` sits near 0.60. Much above that means the code is being explained rather than written. Comments should say WHY, not restate WHAT.

Do not build scaffolding for phases that have not been approved.

## Agent workflow

- One agent per worktree. Two agents in one worktree produced a review whose findings referenced files another agent was editing underneath it.
- Worktrees go in `C:/Projects/.worktrees/<repo>/<task>`, never inside the repo and never as a sibling.
- The implementer never certifies its own work. Every non-trivial change gets two fresh-agent reviews against the diff, adversarial and simplification, and the orchestrator independently builds and runs before accepting.
- Never use a small model for the adversarial gate.

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **hackbench**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely. Symbol and relationship counts drift as the code changes; check `gitnexus://repo/hackbench/context` for current figures rather than trusting a number written here.

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
