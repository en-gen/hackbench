Proposed 2026-11-13 (hotel, #806, #805)

# A vertical map with BG3 alone on the main screen keeps the camera-locked reason

Night shift. `[PROP]` until Brian rules.

## Question

#1372 (#805) draws a world-locked Layer 3 where the level mode leaves BG3 alone on the main screen (mode 0E, map $018), on horizontal maps. On a vertical map whose mode also leaves BG3 alone on the main screen, with a settings byte $81-$BF off tilesets 1 and 3, should the refusal say "Layer 3 not drawn yet: camera-locked layer 3" or "Layer 3 not drawn yet: vertical maps"?

## Options considered

1. (A) Keep "camera-locked layer 3", the reason this case gave before the #1372 merge. The merge then changes no vertical map's reason.
2. (B) Say "vertical maps", as every other vertical $81-$BF map off tilesets 1 and 3 does. Since #805 a lone BG3 is drawn on horizontal maps, so being vertical is arguably the real reason. The cost is one line in `buildL3Verdict` (`src/rom/model/L3Model.ts`, the vertical check in the world-locked block) plus the expected string of the test below.

## Ruling

wording not recorded. Option A was taken in the #1372 merge on the #806 branch (merge commit 7dcbf9f1); this file is `[PROP]` until Brian rules.

## Why

- Vanilla never reaches this case. Stock VerticalTable gives modes $0E and $0F as $00, not vertical (SMWDisX bank_05.asm:480-484), and they are the only stock modes whose main screen is BG3 alone ($04 in LevMainScrnTbl, bank_05.asm:485-489). Every stock vertical mode has BG1 on the main screen. `[EST]` read with smw-mcp, 2026-11-13.
- Only a hack that marks a lone-BG3 mode vertical can reach it, so the choice changes no vanilla map. `[INF]` from the two tables above.
- Option A keeps the merge a pure union: horizontal maps get #805's drawing, vertical maps keep #806's reasons unchanged. `[INF]`
- Both options refuse; neither draws a vertical lone-BG3 Layer 3, because #805 verified it on horizontal maps only and #806 traced only the screen-locked Y $C0 case. `[INF]`

## Pinned by

`test/suite/unit/MapScreenL3.test.ts`, the test "a vertical map with BG3 alone on the main screen keeps the camera-locked reason (#805 is horizontal only, #806)". With the special case removed it goes red (1 failed, 90 passed in that file, one machine, 2026-11-13).

## Applies to

`buildL3Verdict` in `src/rom/model/L3Model.ts`; the vertical refusal sentence in `docs/rom/level-rendering.md`. Refs #806, #805.
