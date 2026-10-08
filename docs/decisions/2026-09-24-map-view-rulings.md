Ruled 2026-09-26 (Brian)

## Question

What does the map view show, and how are capture mismatches handled?

## Options considered

Not recorded per ruling; each below is the owner's chosen option.

## Ruling

Owner rulings, dates per line, wording not recorded. `[EST]`

1. Load-time data, not screen: maps show raw data as the game holds it at load (2026-09-24). Screen pictures only prove the drawing code reproduces SNES pixels. Example: the sliding Koopa on `$105` faces right (first real frame). No screen-derived commentary in the view.
2. Render from map data once (2026-09-24): never stitch per-screen captures into a level-wide view (produced seams, frozen Marios, duplicated sprites). Renderer briefs name a map-data source per layer and carry a test that works with the windows directory absent.
3. Draw best effort (2026-09-25): if a ROM's Map16 animation frames cannot load, draw stock frames and report an error; never blank (#566, reverses #491 and #494).
4. Vanilla bugs are not intent (2026-09-26, #571): show the intended result; the gate lists the bug as an exact, ROM-derived allowed difference that still asserts the capture matches the bug's prediction, never a blanket skip. Case: pipe color is intended per screen; the first load strip and every vertical scroll build keep a stale pipe set. When a capture diff traces to code contradicting the evident design, ask the owner before calling HackBench wrong.
5. Background: no parallax; line up at x = 0, tile 1:1. No camera mode, no HUD.
6. Draw order: L2 (background), L1 non-priority, sprites (column order horizontal, row order vertical), L1 priority quadrants.
7. Game-state toggles (2026-09-26) are per-tab view state, never the `editorStore` singleton.
8. Hidden tiles (switch-off art blank, switch-on not; `$027-$02A` on vanilla) draw at 25% opacity in color in the Map16 sheet and inspector, one constant `HIDDEN_TILE_OPACITY` (`theia/extension/src/browser/map16-view-model.ts`, #621). No second constant. Show owners variants in wide steps (10% or more).

## Why

- Gate lifted 2026-09-25 for the vanilla Foreground (`$105` signed off; layers_v5 130 pass, 13 weak, 0 fail). `[EST]` one machine, Mesen.
- The capture viewer is the oracle: it draws from Mesen memory and imports nothing from `src/rom`, so a green viewer says nothing about HackBench rendering. `[EST]`
- Coverage accepted: 143 captured maps (13 weak signed off by eye, 18 empty-L1 boss maps); 74 slots unreachable by force-load (low byte `$00` or `$DC-$FF`). `[EST]`
- Switch-palace flags are an input to `expandMap` (#567): default uncleared gives `$6A-$6D`, cleared `$16A-$16D`; `SwitchPalaceAlternateBehavior` retired. `[EST]`
- Blue P-switch (#573) leaves Map16 ids alone and swaps coin/used-block chars via `CODE_05BB39` (`DATA_05B96B`, `DATA_05B97D`, operand `$26` read from the ROM); `CODE_00F545` id swaps are collision only; `src/rom/PSwitchRules.ts` is wrong and to be retired. Tables: SMWDisX bank_05 MEMO and #573. `[EST]`

## Applies to

Map view, capture gate, Map16 sheet. Sprites and hacks are deferred. Mesen is the current capture source; the owner prefers bsnes for a cross-check, the snes9x libretro core is the other.

Open:

- Force-load uses each map's own main entrance (on `$0D0` Mario at x=4356), so facing and camera start are suspect where it differs from the real entry; check entrance tables before asserting a start (#272, new number). `[OPEN]`
- In layers_v3, 121 sprite inits ran before the anchor (62 records, 34 maps), so a "face Mario's start" policy needs a capture-policy decision when sprites resume. `[OPEN]`
- End credits and title-screen coverage, nightly failure channel. `[OPEN]`
