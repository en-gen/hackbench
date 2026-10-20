Proposed 2026-10-20 (hotel, #792)

# Line-guided sprites: how the gate names routines, and six smaller calls

## Question

Seven calls the line-guided work (#792, #1121, #1128) took that the owner has not ruled on as calls.

1. How does the line-guided gate decide that a call target is the stock routine?
2. Are the old Travel and Replay tests (#1029, #1075) rewritten?
3. Is the rope's length (sprite $64) done in this round?
4. Does the MarioGFXDMA reader require the NMI vector to point at the stock handler (the call #1119 took late)?
5. Does the gate's WRAM poke sweep cover every slot, or only slot 3?
6. Which sprites does the first-frame rule at rest apply to?
7. Does the gate hash MarioSprInteractRt?

## Options considered

1. (a) Compare call targets to vanilla addresses written in the code. (b) Read each target from the operand the run reaches and name the routine there by a SHA-256 of the routine's code (the whole routine, at least 24 unknown bytes in one digest, D126), keeping the run's order check. (c) Read the targets and trust them without naming the routine.
2. (a) Rewrite the tests against the redesigned Travel. (b) Drop them.
3. (a) Do the rope now. (b) Leave it to a second round.
4. (a) Check the NMI vector. (b) No vector check: hash the handler wherever it sits.
5. (a) Poke every cell every slot reads. (b) Poke the cells slot 3 reads; the twelve slot runs still run clean.
6. (a) Every line-guided sprite the gate admits, drawn where its INIT leaves it, by what the run does. (b) A list of ids, or the even column only, which needs the id or the parity written in the code.
7. (a) Hash it. (b) Check it by role: any callee in the interact slot that is not a draw or the line step.

## Ruling

1. Option b, ruled in the work order of 2026-10-20 (wording not recorded; paraphrase `[INF]`). Built in `LineGuided.ts`: seven routines named by one SHA-256 each over the whole routine's code (41 to 164 bytes, none masked), vanilla US cart, one machine `[EST]`. The FastROM bit of each long operand's bank byte is folded before hashing, as `mirror` does (BA ruling, D126): that is a normalized byte, allowed but not counted toward the 24 unknown bytes each digest must reach. A planted edit 30 bytes into each routine is caught `[EST]`. A call to anything else is "unverified" and the sprite keeps the generic rule. Spans hold the code and any table inside them (the line step's holds the pointer table after its call); the $67 draw's branch tail (4 bytes) is outside its span.

| Digest | SNES address | Span | Normalized | Stated elsewhere | Unknown |
|---|---|---|---|---|---|
| prelude | $018063 | 41 | 0 | 0 | 41 |
| platform draw ($62) | $01B2DF | 164 | 0 | 13 | 151 |
| rope draw ($64) | $01DC54 | 125 | 0 | 0 | 125 |
| $67 draw | $01DC0B | 48 | 0 | 0 | 48 |
| $68 draw | $01DBD4 | 53 | 0 | 5 | 48 |
| chainsaw draw | $03C263 | 118 | 1 | 0 | 117 |
| line step | $01D74D | 99 | 1 | 5 | 93 |
| InitLineGuidedSpr | $01D6ED | 42 | 0 | 7 | 35 |

Stated elsewhere is the count of bytes inside any 5-byte window that also appears as hex in a tracked file (code, comments, docs, tests): an upper bound `[EST]`.
2. Option b, ruled in the same order: D148 dropped map-editor simulation, so the old tests have no target (wording not recorded; paraphrase `[INF]`). Nothing is written for them.
3. Option b, ruled in the same order (paraphrase `[INF]`). The rule is in the ROM: 9 tiles when the slot is 6 or higher and the sprite memory setting is not zero, else 5 (SMWDisX bank_01.asm:12583-12589); the loader picks the slot (bank_02.asm:5376-5405) `[EST]`. The map view seeds slot 0 and setting 0 today `[EST]`, and the setting's plumbing is #1156 and #1157.
4. Option a, taken by #1119's commit "pin MarioGFXDMA from its entry and the NMI vector" and recorded here `[PROP]`. `STOCK_NMI` requires the vector at $00:FFEA to point at a handler whose 368 bytes from $00:816A hash to the stock value; a ROM that redirects the vector is refused (`MarioGraphics.ts`).
5. Option b, a night-shift call `[PROP]`. Per-slot tables hold one cell per slot, so the union over twelve slots exceeded the 16-cell cap on four of the six ids with no hook present. A hook that reads a cell only in another slot is not poke-swept `[INF]`; it still runs clean in all twelve slot runs.
6. Option a, a night-shift call `[PROP]`. The owner's words (R16 / D85 B, verbatim): "B / if that's how the game operates, that's what we should simulate. we could add a note about this in sprite properties, but this has to be interpreted, not hardcoded". No id list and no column parity is written in the code: an admitted line-guided sprite is drawn at rest where the run leaves it, so $65-$68 move 320 px left (even column) or 15 px right (odd) and a sprite whose INIT does not move it stays on its map tile. On the vanilla ROM all 90 $65-$68 placements move that way, on their row, and none of the 6 $62 or 12 $64 do (7 maps, one machine, 2026-10-20) `[EST]`. The work order said even-column only; the odd column moves too. Owner review pending on this reading.
7. Option b, BA ruling (D126), recorded here `[PROP]`. The interact slot accepts any callee that is not a known draw or the line step, with the order checked as before; the routine is not hashed. A synthetic interact callee with different bytes is accepted, and a draw or the step placed in the slot is refused `[EST]`.

## Why

1. The vanilla addresses were the last constants in the gate (#1121). A fingerprint ties the check to what the routine is, so a moved copy passes and an edited one does not.
2. The old tests asserted a travel model the map view no longer shows.
3. The setting is map data the app does not yet carry; guessing it would show a wrong rope.
4. The alternative hashes a handler the game may never run. The vector is the link from the game to the hashed bytes.
5. It keeps the sweep at 256 runs per cell for the cells that matter, and is cheap to reverse.
6. The game draws these sprites there on their first frame; the map should show what the game shows, and say so in words.
7. MarioSprInteractRt is the shared interaction routine, 591 bytes of general code; hashing it would flag hacks that touch interaction for every sprite, not these. What matters here is that the slot is not a draw or the step.

## Applies to

`src/rom/sprites/interp/LineGuided.ts`, `src/rom/sprites/interp/SpriteRunner.ts`, `src/rom/MarioGraphics.ts`, `theia/extension/src/browser/sprite-props.ts`, `docs/sprites/sprite-62-line-platform.md`.
