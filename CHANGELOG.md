# Changelog

All notable changes to HackBench are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Level Settings panel scaffold in the map-editor right panel
  (issue #248). The panel is now split into three regions: the
  selection inspector (top, unchanged), three property tabs in the
  middle (General / Layer 2 / Layer 3), and the switch-state toggles
  anchored at the bottom. Each tab surfaces level-header bits and
  L3 routine metadata read from `$05F200` bits 7:6 (`Layer3Setting`)
  and `$009F88` (`Layer3TilemapSettings`).
- Editable header-bit controls in the new tabs (music, time limit,
  level mode, item memory, L1 V-scroll, L3 priority, L3 setting) wired
  to the existing render-override pipeline. Note: changes are session-
  scoped and not yet persisted to ROM — real ROM write-back lands in a
  follow-up PR.
- `readL3RoutineSummary(rom, levelId, tileset)` and `classifyL3Routine`
  helpers in `src/rom/L3Loader.ts` that return the routine kind
  (`tide` / `fixed` / `camera-tracked` / `none` / `disabled`) from
  the `(layer3Setting, $009F88 byte, tileset)` triple.

### Fixed

- L3 scroll-range overlay no longer draws Min/Max sweep lines for
  Tide_Stationary levels (e.g. $102). Per CODE_05C494
  (bank_05.asm:5576-5578), only byte `$01` (Tide_UpAndDown) actually
  animates `Layer3YPos`; bytes `$00` and `$02..$7F` jump to
  CODE_05C4EC which only updates `Layer3XPos`. `computeL3ScrollRange`
  and `classifyL3Routine` now classify those bytes as `kind: 'fixed'`
  (Y stays at `l3InitialYPx`).
- `l3InitialYPx` returns `$70` for byte `$00` (was `$40`), matching
  the LSR-then-Z=1 branch at bank_00.asm:4154-4161. Vanilla never
  uses byte `$00` in the table so this is harmless in practice, but
  the existing unit test asserted the wrong value.
- Layer 3 Y-position bug for most L3-using vanilla levels.
  `readInitialLayer1YPos` now reads camera-Y idx from `DATA_05F400` bits
  3:2 — the level-load path at bank_05.asm:7323-7335 reloads `_2` from
  `$05F400` before extracting the idx. The previous `$05F200` read
  produced camera Y = `$00` instead of the correct `$C0` for ~all L3-
  using vanilla levels (\$009, \$002, \$127, etc.), shifting the rendered
  L3 plane 192 px above where the game actually displays it. Verified
  against live game runtime via Mesen Memory Viewer at `$7E:001C`.
- Koopa patrol overlay no longer teleports up to a parallel slope at
  stair-step slope corners (visible regression at level $006 col 92 with
  the blue koopa $006). The overlay scan now uses edge-matched surface
  continuity from a new `SurfacePath` module instead of a `±1`-row
  heuristic, so the patrol band tracks the same polyline the editor's
  "Show surfaces" overlay draws.
- Koopa / ground-walker patrol overlays now correctly walk on $11A item
  blocks, $11C wood-plank platforms, and other page-1 tiles whose acts-
  like low byte falls in `$17-$1C` (block-behavior table value $00).
  The sprite-side floor / wall / ceiling classification was incorrectly
  gating on `DATA_00F05C` (the block-behavior table), but the ROM's
  sprite-collision routines (`CODE_01928E`, `CODE_0192C9`,
  `CODE_01933B` at bank_01.asm:2613/2646/2705) only check the page-0
  high-byte BEQ and a low-byte range. F05C governs Mario's
  hit-from-below dispatch (`CODE_00F17F`), not collidability.

### Changed

- "Show surfaces" editor overlay now consumes the shared `SurfacePath`
  module — same source of truth as the sprite-patrol scan. Both views
  agree on silhouette suppression, slope vs flat classification, and
  priority-decorative passthrough; only the floor predicate differs
  (Mario perspective for the overlay, sprite for the scan).
- Project renamed from `smw-editor` to `hackbench`. Marketplace ID,
  command IDs, view IDs, and viewType IDs are now under the
  `hackbench.*` namespace. Virtual filesystem URI scheme (`smwrom://`)
  and content file extensions (`.smwlevel`, `.smwpalette`, `.smwgfx`,
  `.smwmusic`) are unchanged.

### Added

- "Show L3 BG range" editor toolbar toggle (`btn-l3range`, codicon
  `symbol-namespace`) that draws the Layer 3 scroll-range visualization
  on the level canvas. For tide levels (Tide_UpAndDown / Tide_Stationary
  in `Layer3TilemapSettings` at `$009F88`), bright magenta horizontal
  lines mark the wave-surface position at the BG3VOFS sweep extremes
  (`$30..$A0` per CODE_05C494, bank_05.asm:5576-5630), labeled "L3 Max"
  (high BG3VOFS) and "L3 Min" (low BG3VOFS). For fixed and
  camera-tracked L3 modes, a
  translucent cyan rect marks the band the layer occupies. New
  `computeL3ScrollRange()` helper in `src/rom/L3Loader.ts` derives the
  range from the L3 tilemap + ASM-derived bounds.
- Mesen 2 Lua capture scripts for per-frame layer-state recording:
  `tools/mesen/l1_dump.lua` (renamed from `auto_walker.lua` for naming
  symmetry; existing L1 Map16 sweep with a compacted single-line HUD),
  `tools/mesen/l2_dump.lua`, and `tools/mesen/l3_dump.lua`. The new
  scripts capture per-frame scroll registers, tide-state diagnostics
  (Layer3TideSetting, Layer3TideTimer, Layer3ScrollX/YSpeed,
  Layer1YPos), and write CSV + on-entry tilemap/VRAM snapshots into
  the same `OneDrive maps/<id>/` folder as the L1 fixture pipeline. All
  three scripts auto-trigger on game-mode `$14` (no hotkeys) and can run
  simultaneously in Mesen since frame numbers are emulator-global.
- Spike Top ($2E) sprite rendering — 2-frame animated OBJ
  (`EffFrame >> 3 & 1`, `WallFollowersMain` bank_02.asm:8079-8087) plus a
  patrol-path overlay that simulates the wall-follower in tile space.
  The trace supports both wall-following tracks: dirs 0-3 (right-hand
  rule) when Mario is to the right, dirs 4-7 (left-hand rule) when Mario
  is to the left, per `InitSpikeTop` → `CODE_01840E`
  (bank_01.asm:602-626). The overlay terminates at level boundaries
  (sprite despawn) and uses `cell.collision` for solidity so cave /
  fortress walls (page-0 acts-like) register correctly.
- `LICENSE` - MIT
- `THIRD_PARTY_LICENSES.md` - LGPL-2.1 attribution for
  `@smwcentral/spc-player`
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`
- GitHub issue forms, pull request template, Dependabot config

## [0.1.0] - 2026-04-17

Initial pre-alpha release.

### Added

- Virtual filesystem provider for `smwrom://` - opens a SMW ROM as a
  navigable folder tree.
- Level viewer: Layer 1 object + sprite parsing from ROM bytecode,
  rendered against live Map16 + GFX + palette data.
- Palette editor: all 16 CGRAM rows per palette group, BGR555 with
  bit-replicated 8-bit display.
- GFX viewer: all 50 decompressed tile sheets, auto-detected 2BPP /
  3BPP / 4BPP, palette-swappable in-view.
- Music player: SPC700 playback via `@smwcentral/spc-player`.
- Tree-view sidebar with Maps and Resources sections.

### Known limitations

- Read-only - write-back of edited levels/palettes/GFX is not yet
  implemented.
- Layer 2 preset backgrounds (ROM bank `$FF` sentinel) are not
  decodable without CPU emulation and show a placeholder.
- Some tall/slope object handlers have alignment edge cases under
  investigation.

[Unreleased]: https://github.com/en-gen/hackbench/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/en-gen/hackbench/releases/tag/v0.1.0
