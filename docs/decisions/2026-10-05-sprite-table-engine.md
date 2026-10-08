Ruled 2026-10-05 (Brian)

## Question

How are sprites drawn and placed, and where does the editor deviate from the ROM on purpose?

## Options considered

Hand-written per-sprite tables; a generic table engine plus annotations; interpreting the ROM's own code (65816 interpreter).

## Ruling

Owner rulings, dates per line, wording not recorded. `[INF]`

1. Drawing and placement must be interpreted from ROM code, because hacks carry custom sprites (2026-10-05). No hardcoded per-sprite values or delta tables from the disassembly (`$4F` InitPiranha's +8 X centering must come from running INIT). The table engine is a stopgap; the interpreter (spike `docs/ideas/sprite-gfx-interpreter.md`) is the target. A hand-written per-sprite table needs the owner's explicit OK. Source for the placement claim: `docs/sprites/sprite-engine-wiring.md` (InitPiranha, SMWDisX `bank_01.asm:880-889`; evidence scope there: static reads of the six corpus ROM files, no emulator).
2. Architecture (2026-09-18): a generic table-driven engine (faithful, no editorial choices, callable with no map) plus an annotation layer. The roughly 40 bespoke `*Appearance` classes are retired, not extended. Descriptors store addresses, never values; key on the resolved handler pointer, not the sprite id; degrade honestly on an unrecognised handler. No generic "custom renderer" escape hatch; grow the vocabulary, each kind justified by more than one sprite.
3. First-frame default (2026-09-24): animated sprites draw frame 0 of their own sequence unless a per-sprite override table says otherwise. Facing is whatever the sprite draws on its first real frame with Mario at the map start; no facing overrides. Validation is set membership. Sources: `docs/ideas/sprite-gfx-interpreter.md` section 5 (INIT calls `FaceMario`/`SubHorizPos`, SMWDisX `bank_01.asm:6124-6134`; "frame 0" is a policy, not a ROM value; evidence scope there: run, one machine, `vanilla.sfc`).
4. Palette resolves from the sprite in order: static `Sprite166EVals` attribute (CGRAM row `8 + ((attr >> 1) & 7)`), INIT override (`$2C` Yoshi Egg picks by X column), runtime CGRAM upload (`$1F` Magikoopa). Level palette is the fallback only. Hardcode table locations only. Sources: `docs/sprites/sprite-engine-divergence.md` "The palette model" (static `Sprite166EVals` at `$07:F3FE`, `InitYoshiEgg`, the `$1F` CGRAM DMA), `docs/sprites/smw-sprite-2c-yoshi-egg.md` and `docs/sprites/sprite-1f-magikoopa.md` section 4 (`bank_07.asm:792`, `977`); evidence scope there: static traces plus the six corpus ROM files, no emulator.
5. Annotation controls: global on/off is a `hackbench.*` setting; per-sprite ghost on/off lives in the ROM sidecar `<romfile>.hackbench.json` keyed by sprite id, diffing cleanly and never holding ROM-derived data. No automatic suppression.

## Why

Lines that name a `docs/sprites` or `docs/ideas` source carry its SMWDisX lines and evidence scope. The other ROM claims here (the deliberate-deviation examples) were migrated from session memory without citations; cite SMWDisX file:line before relying on them.

- Deliberate editor deviations, not to be "fixed" without asking: representative frame (`$4D` Monty Mole front-facing `$86`), staged composition (Pitchin Chuck baseball at +/-20 px), runtime-state defaults. `[EST]`
- Facing is not a deviation: it derives from Mario's start (`faceRight = marioStartPx.x >= spritePx` via `SubHorizPos` writing `SpriteMisc157C`; X-flip applies when bit 0 is clear, so a sprite that never writes it renders flipped). Source: `docs/sprites/sprite-engine-divergence.md` "Facing is a render-time input" (`SubHorizPos` SMWDisX `bank_01.asm:6124`, `FaceMario` `bank_01.asm:847`, flip applied when the latch is clear); evidence scope there: static traces plus the six corpus ROM files, no emulator.
- Comparing a renderer to the old classes uses four buckets: engine bug, existing bug, undetermined, deliberate editor choice. `[EST]`
- All three palette sources shipped wrong in one night and no value-level test caught it; only looking at the render did. `[EST]`
- Known gaps: extra OAM drawn outside the shared routine (`$1F` wand), one-shot state-timer animation. `[OPEN]`

## Applies to

Sprite rendering. Detail: `sprites/sprite-engine-divergence.md`, `ideas/sprite-properties-panel.md`.
