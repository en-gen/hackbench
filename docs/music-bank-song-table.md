# Music bank song table scan

`readBankSongPointers` (`src/rom/SpcBuilder.ts`) reads a music bank's song
pointer table: 2-byte ARAM addresses that point into the song data region of
the bank (`bank_0E.asm:3834-3868` for the level bank). The table is not
length-prefixed and the pointers are not sorted, so the scan has to derive
where the table ends from the pointers themselves.

## Why a bounds-only scan over-reads

A song's own data can itself open with word-sized sub-pointers that are
in-range, non-zero, and therefore indistinguishable from a further table
entry to a scan that only checks "still in range, non-zero".

Confirmed against the disassembly: the vanilla level bank's real table is
exactly 29 entries (`bank_0E.asm:3840-3868`). A bounds-only scan keeps going
for 2 more "entries" that are actually the first two words of
`MusicB2S0B`'s own sub-table (`bank_0E.asm:3871-3874`), which itself ends in
a `dw $0000` that reads as a second, coincidental table terminator.

## The real bound

No song's data can start before the last slot the table could still occupy.
The scan tracks `minSongStart`, the smallest pointer value accepted so far;
once the next slot's own ARAM address would reach or pass it, the table is
over. This is what stops the level bank scan exactly at 29: slot 29 sits at
the same ARAM address as `MusicB2S0B`'s data, which is the earliest of the 29
real pointers.

`ptr <= aramDest` guards the one thing `minSongStart` cannot: the very first
slot, before any entry has been accepted to bound it. On the three
AddmusicK-patched ROMs in `test/roms/`, this is what fires at slot 0, but only
because the derived bank address happens to land on `$55` filler - it has no
power once an address lands on real, non-filler data. That is what the path
trace below is for.

## Locating the upload routine (issue #417)

`getLevelMusicBankAddr` reads three `LDA #imm` operands at a fixed ROM
address (`readUploadAddress`). That address alone proves nothing: a hack can
replace the routine's body while the fixed address still "resolves" to
whatever bytes now sit there, and on 2 of the 3 patched carts in
`test/roms/` the first byte read is `$20`, not a JSR as an earlier version of
this fix claimed - it is the `#$20` operand of `SEP #$20` at `$008147`
(`E2 20`), one byte before where `readUploadAddress` starts reading. Reading
a byte without confirming which instruction it belongs to is exactly the
mid-instruction misread this fix exists to prevent.

`getLevelMusicBankAddrIfReadable` instead traces the actual call path used at
runtime, gating on the opcode at each hop, so neither a relocated-but-intact
routine nor a routine reached by a different path than believed produces a
false answer:

1. The single `JSR UploadLevelMusic` in the level-load flow
   (`bank_00.asm:2650`, SNES `$009702`) is the anchor: a music hack replaces
   the upload routines' bodies, not the level-load call site that invokes
   them.
2. `UploadLevelMusic` opens `LDA.W BonusGameActivate` / `BNE` on the "loading
   a new level" path (`bank_00.asm:166-167`); the BNE's one-byte displacement
   is read to locate the upload routine, rather than assuming it sits at a
   fixed offset.
3. The routine's full 15-byte `LDA.B #imm` / `STA.W` pattern is gated,
   including that each `STA.W` still targets the shared direct-page staging
   address (`$00`/`$01`/`$02`) the three operands are later composed from
   (`bank_00.asm:175-180`) - opcode-only gating passes a hack that repoints
   the destinations while leaving the opcodes untouched.

## Known limitation: a single bad pointer truncates silently

`minSongStart` only ever shrinks, and nothing re-checks a slot once accepted.
A table with no explicit length has no way to externally confirm "the table
really ends here" versus "one entry happened to be corrupted and looks like
the end" - the two are indistinguishable from the pointers alone. A read
that stops early this way still returns `status: 'ok'` with a plausible,
smaller-than-real count; it is not flagged as a possible truncation.

Two bounded, unrelated failure modes are guarded against instead:
`ABSOLUTE_ENTRY_CAP` (512) stops a garbage or adversarial header from
enumerating an unbounded number of rows, and the read is clamped to what the
ROM file actually contains rather than requesting past its end. Neither
claims to detect a single corrupted pointer inside an otherwise-real table;
closing that would need a cross-check against something other than the table
itself, which is not available here.

## Verified counts (issue #417)

| bank | citation | true count | pre-fix scan |
|---|---|---|---|
| overworld (Bank 1) | `bank_0E.asm:2359-2367` | 9 | 13 |
| level (Bank 2) | `bank_0E.asm:3840-3868` | 29 | 31 |
| credits (Bank 3) | `bank_03.asm:10292-10303` | 12 | 30 |

## Proven able to fail

`test/suite/unit/SpcBuilderBankSongs.test.ts` isolates each table-scan
safeguard behind a synthetic fixture engineered to trigger it specifically
(the corpus's three broken carts all happen to trip the self-reference check
at slot 0, which never exercises the table-overlap check on its own), plus a
synthetic 64- and 100-song bank proving the read-buffer size is no longer a
correctness cap.

`test/suite/unit/SpcBuilderPathGate.test.ts` covers the call-path trace and
opcode gate entirely synthetically (no `test/roms/*.sfc` required): a fully
valid path, a routine relocated but otherwise intact, a break at each of the
three hops, and the exact AddmusicK `SEP`/`RTS` shape measured on the corpus.
This is the only coverage of these safeguards that runs in CI, since a ROM
cannot be committed for the corpus-based tests to use there.
