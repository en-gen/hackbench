# Replacement GFX decompressors

`src/rom/GfxDecompressor.ts` reads which decompressor an entry runs. Stock is
CODE_00B8DE (`bank_00.asm:6294-6413`). PrepareGraphicsFile's `JSR` names the
entry for GFX files; the animation loads in CODE_00B888 reach it by `JSR`
(GFX33, `bank_00.asm:6260`) and by falling into it (GFX32, `:6290-6294`).
Lunar Magic's CODE_04D7F2 reaches it by `JML $00B8DE` to decompress its stored
translevel table (`LmTranslevelTable.ts`), so that source is keyed too.
Survey scope: the 101-hack store, 2026-09-27, one machine, for #603.

## Pointer XOR prelude

`JSL prelude / NOP` replaces `REP #$10 / LDY #$0000` at the entry. The
prelude is `XOR_PRELUDE`: it XORs GraphicsCompPtr's low word ($8A-$8B) with a
16-bit key, then does what the replaced bytes did. Every pointer reaching the
decompressor through that entry is therefore stored XORed: the GFX pointer
tables, and CODE_00B888's GFX33 and GFX32 immediates. The key is the `EOR`
operand and differs per hack; it is read, never assumed. 15 store hacks carry
it, 4 of them SA-1 ROMs this project does not read.

It is accepted only in front of a stock or fast LC_LZ2 body. The GFX writer
stores pointers XORed with the same key. An entry that is neither stock nor
this prelude fails closed.

## Fast LC_LZ2

`JSL routine / RTS` at entry+5, so the stock body is dead code. The routine
reads the stream through `[$8A]` with the stock bank-crossing rule, sets the
data bank to `$02` and writes `STA $0000,Y` from `Y = $00`, and runs direct
copies and back-references through an `MVN` it builds in direct page
`$D8-$E8`. It saves and restores that scratch, returns the output length in
`$8D`, and one build returns without writing when the pointer is `$0000xx`
or `$FFFFFF` (neither is ROM).

Recognized as SHA-256 of a fixed span from the JSL target, nothing masked:
byte-identical on 17 store hacks at $1BC bytes, and on 1 more at $1AB
bytes (the build without the null-pointer check).

### Commands above 4

Read from the $1BC build's bytes, offsets from its entry (hack 11616, $15DF8A).
The header is read at `+$E0` into $8D, and `AND #$E0` (`+$F2`) / `TRB $8D` (`+$F4`)
split it into command bits and length;
`+$F6` is `ASL / BCS +$B0`; `+$B0` is `BMI +$8D`, so bit 6 set (6 or 7) takes
the long-header path and 4 or 5 falls into the back-reference at `+$B2`. At
`+$8D`, `CMP #$1F / BEQ` exits, else the next byte is the length's low half
and the command bits are dispatched again at `+$F6`.

Stock ends on $FF (`bank_00.asm:6299`), reads any header of $E0 and up as a
long header (`:6305-6306`), and sends every command of bit 7 set to the
back-reference (`:6331`, `:6383`):

| Header           | Stock          | Fast                             |
| ---------------- | -------------- | -------------------------------- |
| short 5, $A0-$BF | back-reference | back-reference, same             |
| short 6, $C0-$DF | back-reference | long header; $DF ends the stream |
| short 7, $E0-$FE | long header    | long header, same                |
| inner 5, $F4-$F7 | back-reference | back-reference, same             |
| inner 6, $F8-$FB | back-reference | long header again                |
| inner 7, $FC-$FE | back-reference | long header again                |

The editor's encoder emits only 0 to 4, so a write is correct on either
routine. On the fast routine the reader refuses a stream using any command
above 4 (`commandRefusal`), 5 included: 5 decodes the same, but one
`parseStream` check is the whole rule.

## Back-reference byte order

Command 4's two operand bytes are an output index. Stock reads them with
`ReadByte / XBA / ReadByte`, so the first byte is the high one (big-endian);
the Japanese and E1 builds add a second `XBA` after the second read
(`bank_00.asm:6385-6389`, `ver_has_rev_gfx`), which makes it little-endian.
CODE_00B966 is reached by the `BMI` after the stock body's `PLA / BEQ`
(`bank_00.asm:6329-6331`), 56 bytes into the entry. `readBackRefOrder` follows
that branch (a signed offset) and matches the routine, 29 bytes or 30 with the
XBA. Its three absolute operands, both `JSR ReadByte` and the `JMP` to the loop
head, move with the build, so they are derived from the entry's own bytes:
ReadByte from the entry's `JSR` at entry+6, the loop head as entry+5. Layouts
checked at the routine level against `SMW_*.sym`: US ($B8DE, ReadByte $B983),
E0 ($B8F1, $B996, big-endian), J ($B87E, $B924, little-endian) and E1 ($B8F1,
$B997, little-endian). Any other routine, or a dispatch that is not
`PLA / BEQ / BMI`, refuses the ROM as a replaced decompressor. The check reads
no other part of the body.

The entry gate (#696) matches the `JSR` opcode at entry+5 and `CMP #$FF` at
entry+8..9, not the `JSR` operand, which differs per build (`24 B9` on J, `96 B9`
on E0, `97 B9` on E1, `83 B9` on US). The operand is accepted only when the
back-reference routine's own `JSR` names the same address and that address holds
ReadByte's 15 bytes (`bank_00.asm:6405-6413`: `LDA [$8A] / LDX $8A / INX /
BNE +5 / LDX #$8000 / INC $8C / STX $8A / RTS`, no absolute operand, so one
pattern serves every build). Without that last check an entry and routine that
agree on any address would pass. `readBackRefOrder` also checks the `JSR` opcode
itself.

Evidence scope: synthetic fixtures built from the SMWDisX `SMW_*.sym` operands;
no J or E ROM is in the corpus. A real J, E0 or E1 ROM is still refused earlier,
before `readDecompressor` runs: `resolveGfxPointerSites` reads the US-only caller
at `$00AA6B` (on E0 and E1 that address is in SetallFGBG80, `bank_00.asm:5396-5399`;
on J it is mid-UploadGFXFile). That is #774, not fixed here. The ExGFX
reader `loadExGfxFile` (dormant, #491/#528) takes its order from the same gate
and falls back to big-endian when the ROM has no readable decompressor. The fast routine is read big-endian as before; that
is carried over from the 18 hacks it was surveyed on, not derived from its
bytes. `encode` writes big-endian only, so a little-endian ROM is readable but
`checkWritableCompression` refuses to save its GFX.

Survey scope, one machine, 2026-10-07: the 6-ROM corpus (6 accepted before and
after), the 101-hack store (73 accepted, 28 refused before and after, same
ROMs), the 729-cart non-SMW set (1 accepted, same before and after).

## Not recognized

- LC_LZ3 behind the same `JSL / RTS` shape, 7 store hacks: zero fill,
  bit-reversed and backward copies, relative offsets. Deferred to #650.
- SA-1 ROMs (map mode `$23`), 10 store hacks, refused earlier.
