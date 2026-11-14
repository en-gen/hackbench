Proposed 2026-11-14 (Foxtrot, #1231 and #1176; the owner's rulings of 2026-11-04 and D154)

# Every sprite draws where its setup code puts it, with its stored tile outlined

## Question

At rest the map view ran a sprite's INIT for its picture and then re-based the drawing onto the tile the list stores it on (D134, D91), so INIT's moves never showed: a Piranha Plant stood on its pipe's left column, and a brown chained platform ($5F) hung 120 px left and 104 px up of its block. Does the drawing stand where the setup code leaves the sprite, and how does the map show the stored tile?

## Ruling

The owner, 2026-11-04, on sprite $4F sitting off-center on its pipe: "there is supposed to be an outline around the tile square indicating the sprite's tile placement, but it should \"snap\" to it's rendered position dictated by its subroutine", then "so, line-guided sprites should snap to their line, for example".

On a drag, 2026-11-04: "if I was dragging this piranha sprite around, I should see the grid square outline indicating it's physical position in the rom's data, but it should render where it will appear on the map in agame".

On exceptions, 2026-11-04: "if it follows the sprite's movement/placement subroutine, it will appear as it does in game so it shouldn't land someplace \"weird\"".

On the brown platform, 2026-11-04: "all instances of sprite $5F on map $103 are mis-placed the brown platform sprite should be anchored to the grey block near the bottom-right corner of the image".

The stored-tile marker is D154 (Decisions 115-117, "1B 2A 3A"): "B only when off its square; A dashed square; A square wins".

What the code does, as built:

1. At rest, every sprite draws where its INIT leaves it (`SpriteRunner.runOnce`, `atRest`). No id list and no per-sprite offset: the move is whatever INIT did. MAIN's own motion in the pass still stays out of the picture (the pass-origin rule of #1131).
2. The list entry stays the sprite's data (`anchor.rawX`, `rawY`). A sprite drawn off it carries `shifted` and `initAt`, and the DTO's `stored`; hover, selection and every edit keep working from `stored`.
3. D156's never-appears check (`startsBehind`) applies to every moved sprite: one the loader never shows in play stays on its stored tile, with the note "never appears in play". It needs positive evidence: each spawn the loader allows leaves the sprite's parts (or, if it drew nothing, its own position) behind the scroll edge, or erases it (the offscreen handler, `OffScrEraseSprite`, SMWDisX `bank_01.asm:5975-6043`). A spawn run that drew nothing while the sprite lived is no evidence (on a vertical map the loader spawns a sprite 288 px below or 48 px above the camera, outside GetDrawInfo's window (`GetDrawInfoBnk1`, `bank_01.asm:4748-4769`), so a culled static sprite draws nothing, SMWDisX `bank_02.asm:5217-5238`).
4. A sprite whose INIT lays out its own sprites at fixed map positions (`absolutePlacement`, D158) is unchanged.
5. Built to recommendation, pending D212 (calls 1 and 2): the map draws a thin dashed square on the stored cell only when the drawing does not cover that whole cell; no line to the drawing; selecting still shows the solid R16 highlight. Clicking a shown square selects its sprite and wins over another sprite's drawing on top of it. The tooltip says in plain words that the sprite is stored there and drawn elsewhere.

## What this replaces

- D134 ("draw at the placed spot"), and the deferred offset question it left open: the drawing shows the setup code's move, and the tile outline shows where the sprite is stored.
- D135 ("D162 A", 2026-11-05): small setup-code nudges (piranhas, Thwomp, keyhole, wall springboard, climbing door) draw too, which was the hold-back list. There is no list now.
- D136: its recommendation to keep the brown chained platform's swing on the stored tile. Rejected by the owner's $5F ruling above: InitBrwnChainPlat adds $78 to X and $68 to Y (SMWDisX `bank_01.asm:9705-9718`), and the swing is drawn around that spot.
- D91, the part that put every at-rest picture on the list position. D156 had already replaced it for line-guided ids; this ends it for the rest. D138 and D139 D still hold for what INIT is run FOR (look, status), and D158 for the bonus-game blocks.

## Pending D212

- Call 1 (#1176 AC6), built to recommendation A1, pending D212: the $00F Playwright check uses an odd-column chainsaw, whose square lands on its stored cell, and asserts the even-column ones show no square, since they never appear and stay on their tile (D156).
- Call 2 (#1176 AC5), built to recommendation B1, pending D212: the marker is derived from each reply's `stored`, so it follows a sprite whenever a reply moves its stored tile (unit test: `StoredSquare.test.ts`). No edit path moves a sprite today (the Properties panel is read only, #984), so the in-app check waits for it; dragging a placed sprite is #1116 and follows from the same data.

## Known limit

A moved sprite on a ROM whose sprite loader is not the stock one gets `spawnUnchecked` and the unverified line "could not check whether this sprite appears in play", which before #1231 only line-guided sprites could get. Hack maps are unavailable today (D51), so no map shows it yet.

## Why

- The owner's rule is that the picture is what the game's own code produces, so a rule with exceptions is the "weird" landing he rejected.
- A rule built on one interpreter run per sprite needs no table that a hack can invalidate (`.claude/rules/rom-interpretation.md`).

## Evidence scope

Synthetic cart tests (no ROM bytes): `test/suite/unit/sprites/InitMovesShown.test.ts`, `StoredSquare.test.ts`. Vanilla ROM, one machine: `test/suite/unit/MapSpritesInitMoves.corpus.test.ts` ($105's three $4F at the list entry plus (+8, -1); every $5F on $103 and $0D7 at the list entry plus (+120, +104); the stored position and the production marker cell of every sprite on the 512 maps equal its list entry; 410 of 3239 move, 371 get a square). Not checked by any test: that the $103 chain lines up with the grey block in the owner's screenshot (a look, for the in-app test).

## Applies to

`src/rom/sprites/interp/SpriteRunner.ts` (`atRest`), `theia/extension/src/node/map-sprites.ts`, `theia/extension/src/browser/map-view-model.ts` and `map-view-widget.tsx`, `docs/sprites/`.
