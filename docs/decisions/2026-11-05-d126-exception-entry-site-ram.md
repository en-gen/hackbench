Ruled 2026-11-05 (Brian)

# A named exception to D126 for the overworld entry path's RAM addresses

## Question

#1061 PR 2 replaced the overworld entry path's literals with per-instruction opcode checks, which compare opcodes and branch targets but not the RAM addresses the literals compared. A hack that keeps the opcodes and repoints a store passed where the old check refused it (13 operand bytes, 3,315 single-byte alternatives, 7 addresses; the adversarial reviewer's count, one machine). Closing the gap means the source names those addresses, which D126 (no hardcoded ROM bytes, needed operands read from the ROM) does not allow without a ruling. May this block name them? (Decisions D178 option B, then D179; recorded as D185.)

## Options considered

1. (D178 A) Accept the gap, name it in the PR, file it for 0.85. Withdrawn: a confidently wrong slot cuts against "read correctly or refuse with a reason".
2. (D178 B) Add named RAM-address checks. The synthetic cart must then carry invented operands, not vanilla's.
3. (D178 C) Run the site on the core. Not sized.
4. (D179 A) Allow B as a named exception to D126 for this block only, on four conditions (below).

## Ruling

Ruled 2026-11-05 (Brian): "D178 B" and "D179 A". The exception, "for this block only", on four conditions:

1. The threshold, bias, high byte and branch displacements stay out of the source; they are still read from the ROM. Only opcodes and RAM addresses are named.
2. The built synthetic ROM shows 0 vanilla byte windows, with invented operands. The proof is the scan of the assembled bytes, not a probe of the source.
3. Where a ROM is present, a test checks the RAM table against the ROM (read from the ROM, gated with `describe.skipIf`).
4. The exception is written down (this file) and is no precedent for other blocks.

## Why

The gap was real and silent: the opcode and the branch landing read as stock while a store went elsewhere. The alternatives either left it (A) or ran the ROM (C). Seven named addresses, each cited to SMWDisX, are the smallest statement that refuses it. Evidence for the safety of the choice, one machine: see `test/suite/unit/SubmapFlagGate.ram.test.ts`.

## Applies to

Only the overworld entry path in `src/rom/SubmapFlagGate.ts`: the guard in CODE_05D83E (the `OverworldOverride` test), the table load (`OWLayer1Translevel`, `TranslevelNo`) and the CODE_05D8A2 block (`LoadingLevelNumber`, `_E`, `OWPlayerSubmap`, `_F`), kept in `ENTRY_RAM` with one constant per address. It is no precedent for any other block: each other block keeps D126 as it stands, and a block that wants the same exception needs its own ruling.

Known limit: with no ROM, `ENTRY_RAM` is checked only against a second hand-written copy of itself in `SubmapFlagGate.ops.test.ts`; the corpus test is what reads the ROM's own operands.
