# Changelog

All notable changes to HackBench are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Palette view is now editable. Click a swatch, change its colour through a
  colour picker or the BGR555 hex field, and the working copy updates live -
  a recolour of a written cell is visible in the GFX viewer too, since both
  now read the same in-memory working copy rather than the base cartridge.
  Edits are recorded as `{address, old, new}` ops, stacked into layers under
  a project's `ops/` (fully committed, portable across machines), and a new
  `HackBench: Export Patch` command diffs the working copy against the base
  cartridge into a real `.ips` under `<project>/export/`. Pick a colour with
  the native picker or the hex field, then click OK to commit one layer;
  nothing downstream updates until you confirm.
- Back Area Colors is its own palette group, next to Layer 2 Background,
  rather than a swatch paired one-to-one with each BG variant. That pairing
  implied a link the cartridge does not have: BG palette is level header
  byte 0, back area colour is the independent header byte 1, and the colour
  itself is a PPU register (`$2132`/COLDATA) fed to colour math, not CGRAM
  data at all.
- Sprite $93 (Bouncin' Chuck) renders the canonical arms-up bounce pose
  (`SpriteMisc1602 = $06` written by `CODE_02C53C` in bank_02.asm:9204 once
  `SpriteTableC2` advances to $06 after the chuck triggers). Body uses
  symmetric `$40` halves with the asymmetric `$0C` arm pair the in-game OAM
  emits — geometry verified directly against a Mesen capture on level $010.
- Sprite $97 (Puntin' Chuck) renders the canonical kick wind-up pose
  (`SpriteMisc1602 = $11` per `DATA_02C4B5` in bank_02.asm:9136) with the
  spawned football composed at its `ChuckSprGenDispX` offset so the editor
  view conveys "chuck just kicked the ball". Geometry verified directly
  against a Mesen OAM dump on level $1F1.
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

- Sprite $0A (Red Vertical Para-Koopa) and $0B (Red Horizontal Para-Koopa)
  patrol overlay no longer renders as a symmetric `±amplitudePx` band. Per
  `RedVertParaKoopa` (bank_01.asm:1881), `SpriteXSpeed` and `SpriteMisc151C`
  both init to 0, so `STEP[0]=-1` drives the very first speed update — the
  sprite always moves in the negative direction first (left for $0B, up for
  $0A) and oscillates back toward spawn without ever crossing past it
  (8K-frame simulation confirms `pos ∈ [-112, 0]`). `simulateAmplitude` →
  `simulateRange`, returning `{minPos, maxPos}`; `WingedSpriteAppearance`
  draws a single one-sided dashed segment with solid endcaps at both
  reversal points, body-edge offset so the near cap stays visible
  immediately past the sprite body.
- Sprite $97 (Puntin' Chuck) face-right body1 (kick foot tile `$CB`)
  now renders at `dx=+16` instead of `+8`. The original PR #262 derived
  face-right offsets by simple negation from a face-left Mesen capture,
  but the chuck X-offset tables in bank_02 are face-doubled
  (`DATA_02C909` / `DATA_02C93D` carry 52 entries; face-LEFT 0..25,
  face-RIGHT 26..51) and `CODE_02CA27` (bank_02.asm:9755) reads body1
  from `DATA_02C909[pose+$1A]` for face-right. For pose `$11` that is
  `DATA_02C909[$2B] = $10 = +16` (vs face-left `$F8 = -8`), not the
  simple negation. Body2 (`DATA_02C93D[$2B] = $00`) is unchanged because
  that entry coincides with its face-left value.
- Sprite $64 (Rope Mechanism) smoke puffs now animate correctly in the
  editor preview (issue #235). Previously the smoke rendered as a static
  3-puff cluster with palette inferred from the rope body's hardcoded
  attr `$31`. Re-traced `CODE_029927` (bank_02.asm:3280-3339)
  branch-by-branch: smoke OAM attr is sourced from `SpriteProperties`
  (DP $64), set once per level at bank_00.asm:2401-2402 to
  `!OBJ_Priority2 = $20` and never reloaded per-sprite. Replaced the
  static cluster with an `animFrame`-driven 8-phase cohort lifecycle
  matching the in-game tile/yRise/lifetime tables: tile by age (0..6
  $62, 7..10 $64, 11..18 $66), yRise transitions at age 3 and 11 (DEC
  SmokeSpriteYPos when pre-DEC timer & 7 == 0), 19-frame lifetime,
  X parity flips per spawn cycle. Lifecycle math is exposed as a pure
  `smokeCohortsAt(effFrame)`. Editor `tickAnimation` advances the
  smoke frame at `GAME_FRAMES_PER_TICK = 3` so all 8 phases — including
  the brief phase-7 state where the newest cohort renders as $64 — are
  visited over each 8-tick cycle, matching the in-game time-share.
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
