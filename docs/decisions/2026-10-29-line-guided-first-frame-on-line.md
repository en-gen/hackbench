Ruled 2026-10-29 (D156; the owner's call B), with the never-appears test proposed `[PROP]` (hotel, #792)

# Line-guided sprites at rest: drawn where the game first has them on their line

## Question

Brian's owner test of #987 found line-guided sprites ($62, $64-$68) drawn beside their track: R16 drew each where INIT leaves it, which is the probe corner or a spot off the line. Where does the map draw them at rest?

## Options considered

A. Keep R16: draw the INIT spot, the game's very first frame.
B. Draw the first frame where the sprite is on its line. **A loader that is not the stock one fails closed:** the sprite is drawn on its line as before and marked unverified ("HackBench could not check whether this sprite appears in play"). A sprite that never appears stays on its stored tile and says so.
C. Draw the line spot for every sprite, including those the game never shows.

For B, how "never appears" is decided:

a. A fixed assumption about the scroll (for example, "loaded at the right edge, moved 320 px left").
b. The game's own loader window: run the ROM's code from each spawn the loader allows and judge by the side of the scroll the sprite starts on. `[PROP]`
c. The exact set measured on one route.

## Ruling

Option B, verbatim from Brian (2026-10-29): "Yes, D156 is B: draw the first frame where the sprite is on its line; sprites that never appear stay at their stored tile with "never appears in play". Tell Hotel to build it in #987."

The never-appears test is (b), a `[PROP]` the BA approved on 2026-10-29 as following R16's "this has to be interpreted, not hardcoded". Alternatives (a) and (c) were not taken: (a) writes a scroll assumption into the code, and (c) writes a list measured on one route.

1. **On its line** is what the line step writes, not a tile lookup: `SpriteTableC2,X` ($00C2) is 1 (the lock, CODE_01D933, bank_01.asm:12116-12118) and the lock timer `SpriteMisc1540,X` ($1540, set to 2 by InitLineBrwnPlat, bank_01.asm:11809-11810) has run out. Until then the lock leaves the sprite on the probe corner (CODE_01D8A4, bank_01.asm:12045-12061); the first walk step then writes a line-table point (CODE_01D7B0). `LineAppearance.ts` `onLinePass` is the one function.
2. **Which frame is drawn.** The draw comes before the line step in every line-guided main (bank_01.asm:12204, 12215, 12358), so each frame is drawn where the frame before ended: pass p's end position is drawn on pass p+1. The picture at rest is pass `onLinePass + 1`.
3. **Never appears in play.** The loader spawns a sprite when `(camera + offset) & $F0` is its column, offset by scroll direction (LoadSprFromLevel, bank_02.asm:5217-5281, the offset tables to the column compare; DATA_02A7F6/DATA_02A7F9: +$120 scrolling right, -$30 scrolling left, read from the ROM and held to one SHA-256 of those 96 bytes, none stated elsewhere, D126), or at map load for the opening window (CODE_02ACA1, bank_02.asm:5880-5914: ScrollDir 1, camera -$60, 32 columns), for the entrance the map's loader image was made from. The midway and secondary entrances load other cameras, and the loader helper takes no entrance, so those windows are not checked: a sprite only a midway or secondary entrance's opening window would show can be called never-appears. That is a known limit, not a claim; the follow-up is #1199. A sprite whose INIT moved it is run from each of those cameras. It never appears when, in every spawn, it starts entirely behind the scroll (scrolling right: wholly left of the screen; scrolling left: wholly right) or the run draws nothing for it. At map load (no scroll) it appears when any of it is on the screen. Along the scroll axis only: a horizontal map's camera Y plays no part. A sprite that never appears stays on its stored tile, has no stored-tile outline and no shift note, and the Properties note says "never appears in play", plus any unverified reason it still has (a patched INIT). A sprite the run never puts on its line within the passes is drawn where it first drew and marked unverified ("it never reached its line"); the shift note says "on its line" only for one that got there, and calls a long fall a fall, not a first step.
4. **Caveat.** The test is "starts behind the scroll", not "can never be seen". A still camera is not conservative: a sprite behind it drifts into view at its own speed (the 10 sprites below show on screen from pass 14 to 50 if the camera stops), so the test is the side it starts on, not a run of frames. If the player stops scrolling, such a sprite can drift into view.

## Why

- The game draws these sprites one frame after INIT at the INIT spot, and by the third frame they are on their line, so the first frame that shows the saw on its track is the line spot. The first frame is also off the screen in every capture below.
- A fixed scroll or a measured list would be written in the code, against R16.

## Evidence

Mesen 2 on the vanilla US ROM, one machine, one run per map, 2026-10-28, headless harness (`headless_capture.lua` with a per-frame position log; positions are end-of-frame):

| Sprite | Stored | INIT frame | Lock (C2 = 1) | First on line | Drawn on that line from |
|---|---|---|---|---|---|
| $00F idx 32 ($65) | 3984,304 | 3999,304 (f1146) | 3995,308 (f1147) | 3984,319 (f1148) | f1149 |
| $01A idx 4 ($67) | 720,352 | 735,352 (f1108) | 739,356 (f1109) | 751,367 (f1110) | f1111 |
| $12C idx 24 ($62) | 3280,304 | 3280,304 | 3284,308 | 3295,304 | next frame |
| $12C idx 29 ($68) | 3664,288 | 3679,288 (f1103) | falls (C2 = 2) | 3680,367 (f1124) | f1125 |

- Vanilla, 108 placements on 7 maps: 98 are drawn on their line; 10 never appear: the 7 even-column $65 on map $0f and the 3 even-column $67 on map $1a. In the core all 10 first draw at screen x -56 or -32 and none ever draws on screen (7 of 7 and 3 of 3, which a second reader of the capture also found). Rule (b) gets exactly those 10 from the loader window, with no other sprite flagged.
- Map $12c idx 3 ($68 at y=112) was invisible in one capture only because the probe held camera Y at 192; the rule judges along the scroll axis, so it does not mark a sprite for a vertical camera reason on a horizontal map.
- One sprite, $12c idx 29, falls 21 frames before it locks; no frame count is written in the code.
- Evidence scope: one machine, vanilla US; positions are the harness's, whose camera scrolled 8 px per frame. The never-appears judgment does not use that speed.

## Applies to

`src/rom/sprites/interp/LineAppearance.ts`, `src/rom/sprites/interp/SpriteRunner.ts`, `theia/extension/src/node/map-sprites.ts`, `theia/extension/src/browser/sprite-props.ts`, `docs/sprites/sprite-62-line-platform.md`. Refines call 6 of [2026-10-20-line-guided-gate-calls.md](2026-10-20-line-guided-gate-calls.md) (R16 / D85 B stands: interpreted from the ROM, not hardcoded).

## Test notes

Corpus tests pin the covered sprites (`LineAppearance.test.ts`); the rule's functions have synthetic cases (a lock at pass N, a fall, no lock; behind and ahead of each scroll direction; no spawn) that run without a ROM. Vertical maps use the same code with the Y axis and 224 px. The only vanilla line-guided sprite on a vertical map is a $64 rope ($12A idx 7), which INIT does not move, so no vanilla case runs that path; a synthetic vertical cart covers it. `LineAppearanceRunner.test.ts` runs the runner on a synthetic cart with its own loader digest, ROM absent: mutants of the line pick, both spawn directions, the camera bounds, the screen size, the opening window and the fail-closed note die there.
