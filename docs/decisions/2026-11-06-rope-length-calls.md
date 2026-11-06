Proposed 2026-11-06 (tango, #1230)

# The rope's length: three calls taken in #1230 and #1294

## Question

D152 (Decision 103 E) ruled that the rope's length comes from the loader's own rule, with the screen door only where it depends on free slots. Building it took three calls no ruling covers.

1. Which sprites get the rope's slot-based length?
2. How does setting 1 draw an odd-column rope?
3. Does the screen door for the extra length get a hover line of its own?
4. Does the Properties preview draw the rope's door tiles in the door?

## Options considered

1. (a) The existing dispatch role gate: the sprite's line-guided arm must name the rope draw, and the line-guided gate must confirm the draw by fingerprint. (b) A list of sprite ids written in the code. (c) Every sprite that reads the sprite slot.
2. (a) Long and solid, with the assumption written down that fixed-range spawners can also take sprite slots 6 and 7. (b) Long with the extra length in the door, as for the shared settings. (c) Short.
3. (a) No hover line: the door is explained once, in the docs and the changelog. (b) A hover line saying the length can vary in play.
4. (a) No: the preview and its Parts list draw door tiles solid with no door marking, so the length matches the map. (b) Draw them in the door and mark them in the list.

## Ruling

wording not recorded. All four were taken as [PROP] by the implementer on Overwatch's word, 2026-11-06, and are not ruled.

1. Option a. `VANILLA_DISPATCH.byId` already names the rope for its sprite id and is hash-gated in the runner; no new id list. A draw the gate does not confirm runs in sprite slot 0 as before, with the gate's reason on the tooltip and a plain line in the panel.
2. Option a. On setting 1 only the rope (odd column or row) and one other sprite reach sprite slots 6 and 7 through the loader, so the odd rope is long and solid. The assumption is stated in `docs/sprites/sprite-62-line-platform.md`: fixed-range spawners (bank_03.asm:5185, 5321; bank_02.asm:14, 15586; bank_01.asm:8588) reach those slots too, and no occupancy is simulated. Evidence: one Mesen 2 capture on map $00F, one machine, 4 of 4 runs.
3. Option a. The door is the same one #1132 uses for hidden sprites; a second explanation per sprite would add a line to every rope hover.
4. Option a. `properties-widget.tsx` (63, 135) draws parts without the door flag; kept, the length shown matches the map's.

Known gap, not fixed here: a rope that is both `screenDoor` (#1132) and door-tagged gets two door ids, and hover lifts half of it. Unreachable on vanilla, where a rope draws at rest.

## Why

1. A list of ids is what the project rules out; the gate already ties the identity to the code.
2. The capture matches, and drawing the door on setting 1 would show doubt the data does not have.
3. The hover already says what the sprite is; the length rule is a property of the map's setting, documented once.
4. The preview is for the sprite's pictures and parts; the door is a map-view composite, and the length it shows is the same.

## Applies to

`src/rom/sprites/interp/RopeLength.ts`, `src/rom/sprites/interp/SlotPick.ts`, `theia/extension/src/node/map-sprites.ts`, `docs/sprites/sprite-62-line-platform.md`.
