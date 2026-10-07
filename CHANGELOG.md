# Changelog

All notable changes to HackBench are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Two Playwright tests pin the Maps zoom anchor across the gap between a zoom and its React
  commit: a scroll landing there, and a second Zoom In before the first commit. They fail if
  `restoreAnchor` runs from `sync` or the `renderedZoom` guard goes (#547).

- A unit test pins tile $11A's star column over all 16 X columns: coin unless Mario is
  invincible, star only while invincible (`bank_00.asm:12887-12891`). The Maps view already
  draws it that way (#567).

- The map view has a collision toggle (`layout-panel-dock` icon, after the layer buttons; command
  `hackbench.maps.toggleCollision`; off by default): floors, ceilings, slopes and walls as 2 px
  vector lines over the map, yellow for surfaces and purple for walls, with a tile the probe could
  not classify hatched. The lines come from SMW's own block collision run on the 65816 core, once
  per Map16 tile on the map (cached per tileset and working copy), not from the hand-ported
  classifier (#435). Nothing is probed until the toggle is pressed. The overlay follows the palace and blue P-switch toggles; the silver P-switch is not modelled. Vanilla block code and horizontal levels only; a ROM whose level loader
  refuses, or a vertical level, disables the toggle with the reason. Cold map about 3 s on one
  machine, a revisit from cache; checked against the spike's output on three vanilla maps, not
  against an emulator.
- The Maps view shows what a block holds: each item block carries its item at half size in the bottom-right quadrant, filling the block on hover, drawn in the block's own graphics layer at screen resolution so nearer graphics layers and sprites cover it. Progressive blocks and the two-outcome blocks show both items split along the anti-diagonal, the base item (mushroom or coin) bottom-right and the upgrade (flower, feather, star or 1-up) top-left, with a black line on it, multi-coin blocks a "+" on the coin, and each cell shows the item for its own column ($111 and $11A by X column, `bank_00.asm:12868-12876`; $125 by X column mod 4, `bank_02.asm:1199-1212`; the P-switch colour by column parity, `bank_02.asm:1280-1295`; traced in SMWDisX and checked over a census of vanilla's 512 map slots, 578 indicators, all drawn). Item art comes from running the game's own item-block spawn on the 65816 core; a block whose item cannot be drawn is listed in a note with the reason (#566).
- 65816 core: emulation-mode `(dp,X)` and JSR (a,X) follow Clark and Snes9x, WAI and STP halt `step()`, WDM makes no read, and setting `e` applies the XCE invariant. The SingleStep harness gains planted-defect proofs and a named list of disputed vectors; CI now pins its edge cases and the SingleStep harness's own checks with synthetic tests (#646).
- The GFX view paints: pick a palette color, click or drag on a tile sheet, and the pixel changes
  at once. Strokes can be undone and redone before Save; Save records them as one undoable op
  layer (any number of 8x8 characters) and never writes the base ROM. Closing the view with
  unsaved strokes asks first (#558). A gfx layer file now holds a `chars` list; the older
  one-character form still reads.
- The map view toolbar warns when the open level's mode is on an unverified list, which holds
  mode 1E only (sprite layering not verified, #617). Rendering is unchanged (#618).
- The map view composites the main and sub screens for every level mode, with SNES color math:
  Layer 3 translucency, and halving and additive blends. Per mode, the main and sub screen
  planes and CGADSUB come from the ROM's tables (`LevMainScrnTbl`, `LevSubScrnTbl`,
  `LevCGADSUBtable`, bank_05.asm:485-499), and the fixed color from `CODE_00AE47`
  (bank_00.asm:5867-5885). Layer 3 now draws on 22 vanilla slots, up from 8 (#598). The halving
  rule is from snes9x and bsnes source reads (GitHub master, 2026-10-05), with no hardware run.
- Level mode 0C renders from its own table entry, CGADSUB $70 (bank_05.asm:497, add and half), so
  Layer 2 shows halved there where Layer 1 and Layer 3 are empty (#598). Derived from the table, not
  a capture.
- A reused map tab clears its composite canvas on open, so it no longer shows the previous map
  while the next one loads (#604).
- The map view has a grid toggle (table icon, "Show grid", off by default; command
  `hackbench.maps.toggleGrid`): a thin line on every 16x16 tile, a medium one where a screen's
  top and bottom halves meet (row 16; column 16 in vertical maps), a thick one on screen
  boundaries. It draws only what is in view, so it stays crisp and cheap on long maps at any
  zoom.
- A grid toggle (table icon, "Show grid") in the Graphics and Map16 views draws a one-pixel
  line around every 8x8 character or 16x16 tile, crisp at any zoom and display scale. Graphics
  tabs share one switch; Map16 keeps its own. The Map16 selection and hover outlines draw above
  it.
- Map explorer lists Area 1..N under Overworld, each opening its own 256x224 tab drawn with that
  area's tileset and palette; the Overworld view is the hub only (#364).
- Map view draws L2 (background) behind and in front of L1 in priority planes, with a
  Background toggle in the toolbar. L2 comes from the working copy, image or object
  stream, placed at the level's start offset. A map whose L2 cannot be read draws L1
  alone and says why.
- The desktop app's window and taskbar icon is the HackBench mushroom, the
  same mark as the title bar, shaded with a gray gradient so it reads on light
  and dark taskbars. It was Electron's default icon.
- Overworld view, opened from an Overworld row in the map explorer, after Title Screen
  and New Game. It draws the hub
  (half 0, 512x512) from the working copy before any event, in area 0's tileset and
  palette. Area 1..N rows under it each open a 256x224 camera window over half 1 in that
  area's own tileset and palette, in a tab of their own. Rows preview on a click and pin
  on a double-click, as map rows do. Toolbar toggles show or hide Foreground and
  Background, and a zoom control scales each view. On a ROM whose overworld code it
  cannot read, it shows the reason instead of drawing.
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

- GFX decompression reads LC_LZ2 back-reference offsets in the byte order the ROM's own decompressor routine uses (J and E1 builds add an XBA that makes them little-endian), and the decompressor check now covers that routine, not only the entry: a ROM whose routine is neither known form is refused instead of decoded wrongly. A stock J, E0 or E1 ROM is still refused at the entry check (#696), so this changes no real ROM's verdict today; a little-endian ROM, once accepted, can be read but not saved. Checked on the 6-ROM corpus and the 101-hack store: no ROM that passed before is refused now (#274).
- Map $005's ON/OFF track tile `$095`, hidden while the switch byte `$14AF` is 0, no longer draws as if shown. Its one-pixel diagonal fell wholly on the screen door's full-strength squares; a hidden tile with more pixels on those squares than on the dim ones is now drawn on the dim squares, in the map and Map16 views alike. `$094` (hidden while `$14AF` is 1) was already faint. The game's gate is `bank_01.asm:11985-11995` (#560).
- `levelHasObjects` no longer rejects level modes $15-$1F: the game masks the mode with $1F and its six mode tables have 32 entries, so every mode $00-$1F is valid (#130).
- Block contents resolver: tiles $021 and $022 now resolve to a coin and a 1-up when hit from below (`bank_00.asm:12195-12212`); $114 says a coin replaces the directional coins once a run has started (`bank_02.asm:1162-1172`); content id 0 gives nothing, and a balloon rewritten to the P-switch or egg sprite no longer gets their colour or contents (`bank_02.asm:1053-1054`, `:1215-1223`); a zero sprite entry with a live status reads as Sprite $00, as the ROM spawns it, and spawn status 0 is no sprite (`bank_01.asm:182-183`); the gate table is read from the ROM, and a differing Yoshi-loose copy is shown beside the normal one (`bank_02.asm:1143-1151`); $12A and $12B say they open only from the side; two surviving mutants are now pinned by tests; the doc's head-bump wording follows the gate table (`bank_00.asm:12850-12853`) (#672, #626).
- `npm run typecheck:theia` uses theia's own TypeScript and exits 1 only when TypeScript is absent from both `theia/extension/node_modules` and `theia/node_modules`, naming `yarn --cwd theia install --frozen-lockfile --ignore-scripts` instead of failing with TS5107 under the root's TypeScript 6 (#669).

- Develop builds again: `mapBlockContents` no longer calls a working-copy watch that moved into the project connection in #662, which broke the Theia type-check after #677 merged (#682).

- Opening another project closes the previous project's GFX, Map16 and map views, so
  Ctrl+Z in a leftover view no longer undoes the new project's layer. A view with
  unsaved strokes asks first, and cancelling keeps the old project open (#628).
- A `setWord` or GFX Save whose layer file write fails after an undo now keeps the redo
  history, in memory and on disk, and the held working copy; a failure after the redo
  clear still loses it, as before. Synthetic fault tests, no ROM (#634).
- The sprite interpreter's machine is stricter and shared: one call helper (`src/rom/cpu/call.ts`) replaces four copies of the call loop and reports a wrong or unbalanced return, WAI, a fetch outside ROM, a HiROM cart and a runaway level load by their real cause (the level load now has a total step cap); the bus mirrors ROM past the image, models SRAM as a buffer and shares the Mode 7 latch; the Mesen replay test now asserts the exact 1110 of 1122 (#647).

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

- Tests close three sprite-layer gaps from #564 (#589): `mapSprites` with a stream in the ROM's last bytes, `paintSpriteCanvas` clear and screen selection, and map-view assertions made after the sprites load.
- The two wall-clock gates (`perfPairedE2E`, the `perfSampler` plant-precision test) are named `*.timing.test.ts`, excluded from `npm run test:unit` and run serially by `npm run test:timing`, which CI runs after the unit tests (#668, #537).
- Agent manual: auto-merge stays on across fix pushes.
- `npm run gitnexus` no longer rewrites CLAUDE.md and AGENTS.md (`.gitnexusrc` and `--skip-agents-md`), so parallel worktrees stop conflicting on the generated counts, which are removed from the marked region (#644).
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
