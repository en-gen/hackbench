# Layer 3 on every level mode: per-screen planes and color math - design

Status: design settled with the owner 2026-10-05; this spec has not been
implemented. Issue: en-gen/hackbench#562, on top of #561 (standard layout
only, merged as PR #581). Evidence scope for every ROM claim below: the vanilla
USA ROM, read by a probe on one machine on 2026-10-05, plus SMWDisX by
`file:line`. Hacks were not probed.

## Problem

#561 draws layer 3 only when a level mode has the "standard" layout (main
screen BG1, BG3, OBJ; sub screen BG2; no special setting; layer 2 not
interactive). `mapPlaneOrder` in `theia/extension/src/common/project-protocol.ts`
special-cases that one layout and `layoutRefusal` in `src/rom/LevelScreenTables.ts`
refuses everything else. The SNES does more than stack planes: it composites the
main and the sub screen separately and then does color math between them. The
standard layout hides that, because BG2 sits alone on the sub screen. Other
modes put BG2 on the main screen, or BG3 alone on it, and then the math shows.

## Settled design

1. **One plane-order function, per screen.** Inputs: the mode's main
   designation ($212C, `ModeLayout.main`), its sub designation ($212D,
   `ModeLayout.sub`) and the header's BG3 priority bit. Output: two bottom-to-top
   lists, `main` and `sub`, of `MapPlaneKey`. Bit 0 is BG1, bit 1 BG2, bit 2
   BG3; bit 4 is OBJ and is dropped until #564 (sprites are not drawn on the map
   tab today, "Sprite toggle not wired yet"). Bit 3 (BG4) is ignored: BG mode 1
   has none. Each list is `ppuDrawOrder(priority)` filtered to the layers on
   that screen, so `RenderPass.ts` stays a one-screen table and is called once per
   screen. The #561 order (`l2Low, l2High, l3Low, l1Low, l1High, l3High` or its
   priority-clear twin) is then the case main = $15, sub = $02: sub is
   `[l2Low, l2High]`, main is the rest. `mapPlaneOrder` is deleted. New file
   `src/rom/model/ScreenPlanes.ts`; Map16 and GFX views are untouched.
2. **A generic color-math stage.** A pure function in `src/rom/model/ColorMath.ts`
   (no shell imports) that takes one screen's decoded planes, both lists, the
   backdrop color, the effective CGADSUB and the fixed color, and returns RGBA.
   Per pixel it composites main and sub separately (topmost opaque plane of each
   list, backdrop when none). If the main pixel's layer, or the backdrop, has its
   bit in CGADSUB, it adds (bit 7 clear) or subtracts (bit 7 set) the sub pixel,
   or the fixed color where the sub screen drew nothing. Bit 6 halves the result
   when the sub pixel is a real pixel (see the settled fact below). The result is
   clamped per channel to 0..31 in 5-bit space (convert with `>> 3`, expand with
   the same `(v << 3) | (v >> 2)` as `bgr555ToRgba`; a test round-trips all 32
   values). Add halves as `(a + b) >> 1`, subtract as `max(a - b, 0) >> 1`.
   CGWSEL is $02 (add subscreen, no clip, no prevent: bank_00.asm:1285), so
   windows and the clip/prevent bits are not modeled. The frontend reruns the
   stage on every layer toggle, because a toggle changes both lists.
3. **Layer 2 role tooltip.** "Layer 2 · Foreground" when layer 2 is interactive,
   else "Layer 2 · Background". The tables already encode it: bit 7 of
   VerticalTable, `ModeLayout.vertical & 0x80` (bank_00.asm:11736-11738, the
   ScrMode_EnableL2Int bit). Probed: that bit is set for modes 02, 04, 06, 08 and
   1F only. Mode 11 has BG2 on the main screen but bit 7 clear, so it reads
   Background. `LevelScreenTables` already reads the byte; the wire carries it.
4. **Scope.** Draw layer 3 on every non-Mode-7 mode. Out: #563 camera-locked
   layer 3, #571 vertical maps, #115 tide animation, #564 the sprite toggle, #569
   `l3InitialYPx`.

## The CGADSUB input

- Table value: `LevCGADSUBtable`, bank_05.asm:495-499, stored to ColorSettings at
  bank_05.asm:548-549. The load site `readModeLayouts` already fingerprints
  (`SITE` in `LevelScreenTables.ts`) holds its operand as the third `LDA.L`, so
  `ModeLayout` gains a `cgadsub` field read the same way, at offset 15. A hooked
  loader still reads as unverified.
- Minus BG3 (bit 2) wherever CODE_009FB8 clears it: `TRB.B ColorSettings` at
  CODE_00A01B, bank_00.asm:4196-4198. Every path reaches it (no layer 3 at
  :4146, tide at :4164, crusher CODE_00A007 and the bit-6 path through
  CODE_00A012, the Castle 1 and Underground 1 autoscroll at :4170-4179) except
  CODE_00A01F, which is entered only for a settings byte in $81-$BF off those two
  tilesets. That is exactly the camera-locked case `l3LoadTimeY` already returns
  null for, so `bg3InCgadsub = (l3LoadTimeY(byte, tileset) === null)` and the
  layer is skipped under #563 anyway. A level with no layer 3 clears it too.
- Fixed color: `BackAreaColors[header byte 1 >> 5]`, bank_00.asm:5623-5628.
  Every vanilla back color index used is 3, which is $0000 (black).

## The open fact, settled: half against the fixed color

The question: with CGWSEL "add subscreen" and a transparent sub pixel, the math
uses the fixed color. Is the half bit still applied? **No: the half is skipped.**

- snes9x, the core HackBench drives (`hackbench-cores/snes9x-wasm`, set with
  `HB_CORE_JS`; recorded in `%APPDATA%\hackbench\core-registry.json`):
  `tileimpl.h:176-181`, `MATHS1_2::Calc` returns
  `(SD & 0x20) ? Op::fn1_2(Main, Sub) : Op::fn(Main, GFX.FixedColour)`. The
  halving `fn1_2` runs only when a sub pixel exists (`SD & 0x20`); with the fixed
  color it is the plain `fn`.
- bsnes, corroborating: `bsnes/sfc/ppu-fast/line.cpp:111`,
  `halve && windowAbove[x] && below.source != Source::COL` (COL is the
  backdrop/fixed color); `bsnes/sfc/ppu/screen.cpp:118` likewise.
- Scope: both read from GitHub master on 2026-10-05 (snes9x
  `1bcc369e89f08243e0a462882fb1f3e42e51de3a`); the wasm build HackBench ships was
  not diffed against that commit, and no hardware or ROM run was made.
- Effect: $10E and $1BD (mode 11, CGADSUB $FF, $FB after the BG3 clear: subtract
  and half, black fixed color, sub screen $00) render unchanged. Subtracting
  black changes nothing and the half is skipped. Without this fact they would
  show at half brightness.

## What changes on screen

From the tables and the probe (vanilla ROM; level counts by header mode):

- Mode 02, 12 levels including $009 (main $17, sub $00, BG3 priority clear): BG3
  is behind layers 1 and 2. CGADSUB $24 adds a black fixed color: no change.
- Mode 08: $0E7 and $1CE, same shape as mode 02.
- Mode 0E: $018 only (main $04, sub $13, CGADSUB $24 kept): BG3 is the only main
  layer and is added onto the sub screen's layers 1 and 2 (and sprites later).
  A real add, and the only level where layer 3 over another layer is not an
  occlusion.
- Mode 11: $10E, $1BD, no layer 3: unchanged (above).
- Modes 04, 06, 0F, 1E, 1F: no vanilla levels, so they get synthetic tests only.

## Payload

`MapScreenResult` (status `ok`) carries today `planes` (six base64 RGBA, null
where nothing drew), `layer3 { layout: 'standard' | 'other'; priority; reason }`,
`backdrop`, `note`, `layerNotes`. After:

- `planes`: unchanged, the six keys.
- `layer3`: `{ priority; reason }`; `layout` is removed (it was the special case).
- new `screens: { main: MapPlaneKey[]; sub: MapPlaneKey[] }`, the lists above.
- new `math: { cgadsub: number; fixed: [number, number, number] } | null`, null
  when the mode table could not be verified (no math, the #561 stacking).
- new `layer2Interactive: boolean`, for the tooltip.

The widget replaces its z-ordered plane canvases with one composite canvas per
screen, drawn by `ColorMath` from the plane canvases' pixels (kept, hidden, as
the source and for the specs that read them).

## Skip reasons that remain

- Mode 7 rooms (modes 09, 0B, 10, nonzero `ModeLayout.special`): the refusal now
  names Mode 7 instead of "non-standard layer layout". The brief identifies
  these as the Mode 7 rooms; re-derive that from bank_00 when implementing.
- Camera-locked layer 3 (#563), vertical maps (#571), hooked layer 3 code,
  unverified BG mode, no layer 3 on the map, unreadable tilemap: as in #561.
- The interactive-layer-2 refusal is deleted.

## Acceptance criteria

1. Per-mode plane lists. For each of the 32 modes, a synthetic ROM whose tables
   are built in the test (`modeTablesRom` in `test/suite/support/l3Rom.ts`) gives
   `main` and `sub` lists equal to an independent hand table, both priority
   values. Planted defect, each caught: BG3 high plane left in the wrong slot,
   sub list read from the main byte, BG4 bit not ignored.
2. Color math, synthetic: add; subtract; half; half skipped against the fixed
   color; clamp at 0 and 31; a layer not in CGADSUB unaffected; BG3 absent from
   the mask when CODE_009FB8 clears it (and kept for the camera-locked byte);
   backdrop bit; the 5-bit round trip. Planted defects: half applied to the
   fixed color, clamp dropped, subtract treated as add.
3. $009 draws layer 3 behind layers 1 and 2 with its toggle enabled
   (`pressed`, not `disabled`).
4. $018: a pixel where layer 3 is over a layer 1 or 2 pixel equals the 5-bit sum,
   clamped (assert the value); toggling layer 3 off removes the add (the pixel
   equals layer 1 or 2 alone). The issue also says "and sprites": sprites are
   not on the map tab until #564, so this asserts layers 1 and 2 only.
5. Corpus sweep, `describe.skipIf(!hasRom(VANILLA))`: every vanilla map's skip
   verdict and both plane lists follow from its header and the tables read by
   address; the test reports how many maps it checked (more than 400) and per
   verdict.
6. Standard-layout maps keep the #561 plane order (`[l2Low, l2High, ...]` for the
   same priority) and, for a sampled mode-00 map with a black back color, byte
   identical pixels to #561. Not mode 0C: see the contradiction below.
7. Playwright on $009 and $018 (`map-view.spec.cjs`): read pixels from the
   composite canvas; $009 shows a layer 3 pixel only where layers 1 and 2 are
   empty, and the pixel returns when layer 1 is toggled off; $018's add pixel
   appears, then disappears when layer 3 is toggled off.
8. Layer 2's tooltip reads "Layer 2 · Foreground" on $009 and "Layer 2 ·
   Background" on a standard map and on $10E.
9. CI has no ROM: items 1 to 3 and 6's order check are synthetic, and each oracle
   has a planted-defect test.

## Where the settled design is contradicted by the code and ROM

1. **Mode 0C changes on screen, not only $018.** Modes 0C and 0D have CGADSUB
   $70 (add, half, OBJ and backdrop) with the standard layout, so #561 draws them
   as plain main over sub. Six vanilla levels use mode 0C ($004, $0F8, $114,
   $1D9, $1EA, $1FA; none use 0D). With the stage, where layer 1 and layer 3 are
   empty the main pixel is the backdrop (black) and the result is the sub pixel
   halved: layer 2 reads at half brightness there. "Only $018 renders
   differently" is true of the non-standard modes, not of the vanilla ROM overall.
   Criterion 6 is restricted to modes whose math is the identity (CGADSUB $24, black
   backdrop), and a sweep assertion counts the mode 0C maps that change. This
   rests on the table value and the half rule above, not on a rendered capture:
   confirm on one of the six against the core before the PR leaves draft.
2. **Sprites are not drawn on the map tab**, so the issue's "added onto layers 1,
   2 and sprites" is asserted on layers 1 and 2 only (criterion 4).
3. `ModeLayout` does not carry CGADSUB today (only main, sub, special, vertical),
   so the table-read site grows by one operand; `layer3.layout` and
   `mapPlaneOrder` are removed rather than extended.

## Files touched

New: `src/rom/model/ScreenPlanes.ts`, `src/rom/model/ColorMath.ts`,
`test/suite/unit/ScreenPlanes.test.ts`, `test/suite/unit/ColorMath.test.ts`.
Changed: `src/rom/LevelScreenTables.ts` (cgadsub, drop interactive and
non-standard refusals), `src/rom/model/L3Model.ts` (verdict carries the lists and
the effective CGADSUB), `theia/extension/src/common/project-protocol.ts`,
`theia/extension/src/node/map-screen.ts` (`screenResult`),
`theia/extension/src/browser/map-view-widget.tsx` (composite canvas, tooltip),
`test/suite/unit/MapScreenL3.test.ts`, `test/suite/support/l3Rom.ts`,
`theia/browser-app/test/map-view.spec.cjs`, and the docs that say layer 3 is
standard-layout only (`docs/architecture/theia-shell.md` if it does).

## Risks

- `map-view.spec.cjs` has 82 plane references; the ones about stacking (z-index,
  order) move to the composite. Keeping the plane canvases hidden holds the rest.
- Cost: a recompute per screen per toggle, 256 x 432 pixels a screen. A fast path
  when the effective CGADSUB hits no present layer returns the plain stack.
- Hacks: a hack with a non-black back color gets backdrop-plus-BG2 sums that #561
  did not show; that is the hardware rule, but it is a visible change.
- Camera-locked layer 3 (#563) keeps BG3 in CGADSUB, so it will need this stage
  with BG3 in the mask; #563 inherits that.
- Window masks and the CODE_00A0xx special cases of mid-level HDMA are not
  modeled.

## Size and review

Implementation about 400 lines (ScreenPlanes 70, ColorMath 100, tables and model
45, protocol and node 40, widget 130, minus the removed special case), tests
about 650 (unit 450, Playwright 200). Total about 1050, above the 150-250 spec
size by nature, so the PR should be split if the widget half passes 150 lines:
planes and payload first, the stage and the composite second. **Label the PR
needs-owner:** it changes what maps show (mode 0C dims layer 2, $018 gains an
additive layer 3, $009 and similar gain layer 3, the layer 2 tooltip changes).
