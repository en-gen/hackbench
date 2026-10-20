Proposed 2026-10-20 (hotel, #792)

# Line-guided sprites: how the gate names routines, and five smaller calls

## Question

Six calls the line-guided work (#792, #1121, #1128) took that the owner has not ruled on as calls.

1. How does the line-guided gate decide that a call target is the stock routine?
2. Are the old Travel and Replay tests (#1029, #1075) rewritten?
3. Is the rope's length (sprite $64) done in this round?
4. Does the MarioGFXDMA reader require the NMI vector to point at the stock handler (the call #1119 took late)?
5. Does the gate's WRAM poke sweep cover every slot, or only slot 3?
6. Does the first-frame rule for $65-$68 at rest apply to both column kinds?

## Options considered

1. (a) Compare call targets to vanilla addresses written in the code. (b) Read each target from the operand the run reaches and name the routine there by a SHA-256 of its first bytes, keeping the run's order check. (c) Read the targets and trust them without naming the routine.
2. (a) Rewrite the tests against the redesigned Travel. (b) Drop them.
3. (a) Do the rope now. (b) Leave it to a second round.
4. (a) Check the NMI vector. (b) No vector check: hash the handler wherever it sits.
5. (a) Poke every cell every slot reads. (b) Poke the cells slot 3 reads; the twelve slot runs still run clean.
6. (a) Both columns (the even one 320 px left, the odd one 15 px right), by what the run does. (b) The even column only, which needs the parity written in the code.

## Ruling

1. Option b, ruled in the work order of 2026-10-20 (wording not recorded; paraphrase `[INF]`). Built in `LineGuided.ts`: eight routines named by the SHA-256 of their first 24 bytes (8 for the chainsaw draw wrapper), vanilla US cart, one machine `[EST]`. A prefix catches a hook at the entry (a JSL or JML patch) and misses an edit past the prefix `[EST]`. A call to anything else is "unverified" and the sprite keeps the generic rule.
2. Option b, ruled in the same order: D148 dropped map-editor simulation, so the old tests have no target (wording not recorded; paraphrase `[INF]`). Nothing is written for them.
3. Option b, ruled in the same order (paraphrase `[INF]`). The rule is in the ROM: 9 tiles when the slot is 6 or higher and the sprite memory setting is not zero, else 5 (SMWDisX bank_01.asm:12583-12589); the loader picks the slot (bank_02.asm:5376-5405) `[EST]`. The map view seeds slot 0 and setting 0 today `[EST]`, and the setting's plumbing is #1156 and #1157.
4. Option a, taken by #1119's commit "pin MarioGFXDMA from its entry and the NMI vector" and recorded here `[PROP]`. `STOCK_NMI` requires the vector at $00:FFEA to point at a handler whose 368 bytes from $00:816A hash to the stock value; a ROM that redirects the vector is refused (`MarioGraphics.ts`).
5. Option b, a night-shift call `[PROP]`. Per-slot tables hold one cell per slot, so the union over twelve slots exceeded the 16-cell cap on four of the six ids with no hook present. A hook that reads a cell only in another slot is not poke-swept `[INF]`; it still runs clean in all twelve slot runs.
6. Option a, a night-shift call `[PROP]`. The owner's words (R16 / D85 B, verbatim): "B / if that's how the game operates, that's what we should simulate. we could add a note about this in sprite properties, but this has to be interpreted, not hardcoded". The work order said even-column only; the run also moves an odd-column $65-$68 by 15 px, and writing the parity into the code would be hardcoding. On map $00F and $01A (43 sprites, vanilla, one machine) the draw sits 320 px left or 15 px right of the list position and on its row `[EST]`. Owner review pending on this reading.

## Why

1. The vanilla addresses were the last constants in the gate (#1121). A fingerprint ties the check to what the routine is, so a moved copy passes and an edited one does not.
2. The old tests asserted a travel model the map view no longer shows.
3. The setting is level data the app does not yet carry; guessing it would show a wrong rope.
4. The alternative hashes a handler the game may never run. The vector is the link from the game to the hashed bytes.
5. It keeps the sweep at 256 runs per cell for the cells that matter, and is cheap to reverse.
6. The game draws these sprites there on their first frame; the map should show what the game shows, and say so in words.

## Applies to

`src/rom/sprites/interp/LineGuided.ts`, `src/rom/sprites/interp/SpriteRunner.ts`, `src/rom/MarioGraphics.ts`, `theia/extension/src/browser/sprite-props.ts`, `docs/sprites/sprite-62-line-platform.md`.
