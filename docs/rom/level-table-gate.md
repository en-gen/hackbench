# LevelTableGate: sprite-bank and VerticalTable hooks

Corpus measurement and byte trace for the Lunar Magic hook shapes
`src/rom/LevelTableGate.ts` recognizes, alongside the vanilla bytes at
`CODE_05D8B7` (`bank_05.asm:7248-7258`) and `CODE_0584E3` (line 552).

## Sprite pointer read

The vanilla index (`$05D8E2`: `A5 0E 0A A8`, LDA _E/ASL A/TAY) and bank tail
(`$05D8F5`: `A9 07 85 D0`, LDA #$07/STA SpriteDataPtr+2) are byte-identical
on 2 of 6 corpus ROMs (vanilla, the Lunar Magic resave). The other four
(Grand Poo World 2, Grand Poo World 1.2, Invictus 1.0, Seven Vanilla
Levels) replace both with a JSL:

- `$05D8E2` becomes `22 50 F5 0E` (JSL $0EF550). The target is
  `A5 0E 1A 85 FE 3A 0A A8 6B` on three ROMs (LDA LevelNumber/INC/STA
  $FE/DEC/ASL/TAY/RTL -- Y ends at level*2, same as vanilla) and
  `A5 0E 8D 0B 01 1A 85 FE 3A 0A A8 6B` on Seven (one extra `STA $010B`
  before the INC, otherwise identical). Neither body branches.
- `$05D8F5` becomes `22 00 F3 0E` (JSL $0EF300) on all four, and the
  target is byte-identical on all four: `8B 4B AB A4 0E B9 00 F1 85 D0
  AB 6B` (PHB/PHK/PLB/LDY LevelNumber/LDA $F100,Y/STA SpriteDataPtr+2/
  PLB/RTL), a per-level bank byte from a 512-byte table at $0EF100
  (bank $0E, from the routine's own PHK). Measured non-$07 entries:
  GPW2 168/512, GPW 1.2 68/512, Invictus 199/512, Seven 52/512 -- the
  per-level table is load-bearing, not a formality.

Two of the four (GPW2, Invictus) additionally replace the setup at
`$05D8E6` (`A9 00 00 E2 20`, LDA #$0000/SEP #$20) with a 4-byte JML to
a detour: `$92C78D` (GPW2) and `$90BB5A` (Invictus), both eventually
returning via `JML $85D8EB` after replaying
`PHY/PHP ... PLP/PLY/LDA #$0000/SEP #$20`. Both detour bodies branch on
live RAM state inside the `...` (GPW2: `BNE` on `$141A`, twice;
Invictus: `BNE` on `$141A`, `BEQ` on a ROM-byte compare), which this
project declines to resolve statically (see CLAUDE.md: "a walk that
refuses conditional branches fails closed"). `LevelTableGate` refuses
the sprite read on these two ROMs, naming the RAM address the branch
reads, rather than asserting the detour preserves Y and SpriteDataPtr.
GPW 1.2 and Seven, whose `$D8E6` setup is untouched, are accepted.

## VerticalTable

`$058520` (`LDA.L VerticalTable,X` / `STA ScreenMode`) is byte-identical
on 5 of 6; Grand Poo World 2 replaces the 4-byte `LDA.L` with
`JML $92CB81`, leaving the trailing `STA ScreenMode` reached unchanged.
The detour body is 36 bytes, over this project's ~32-byte threshold for
a literal pattern, so neither the code nor this file reproduces it as
raw bytes; the structure, by mnemonic and offset, is:

| Offset | Instruction | Note |
|---|---|---|
| +0 | `LDA.L table,X` | table = $858417, the $85-mirror of $058417 |
| +4 | `BPL +$10` | taken when bit 7 (loaded byte) is clear |
| +6 | `LDA #$01` | not-taken path: sets a scratch flag ($7FB40B) to 1 |
| +8 | `STA $7FB40B` | |
| +12 | `LDA.L table,X` | reload, same operand as +0 |
| +16 | `AND #$7F` | strips bit 7 before storing |
| +18 | `JML return` | return = $858524, i.e. $058520 + 4 |
| +22 | `LDA #$00` | taken path (bit 7 already clear): flag set to 0 |
| +24 | `STA $7FB40B` | |
| +28 | `LDA.L table,X` | reload, same operand as +0 |
| +32 | `JML return` | same return as +18 |

Both paths preserve VerticalTable bits 0-1 (L1/L2 vertical) unchanged
into ScreenMode: the not-taken path only clears bit 7 (`AND #$7F`)
before storing, and the taken path is only reached when bit 7 is
already clear, so it stores the raw reloaded byte with no mask at all.
Both JML targets, at offset 18 and offset 32, land on the SAME address:
`$058520 + 4`, the original `STA ScreenMode` that follows the replaced
`LDA.L`, confirmed by direct comparison against the un-patched ROM's
bytes at that address, which are unchanged on GPW2.

`LevelTableGate.ts`'s `readVerticalTable` verifies this whole 36-byte
shape: the three table loads at offset 1, 13 and 29 must agree with
each other, and the two JML operands at offset 19 and 33 must both
equal the return address computed independently from where the JML
site itself was found (never trusted from the body). Being over the
~32-byte threshold this project's short-pattern rule allows literally,
the fixed-opcode skeleton (the bytes above with the five operand
ranges masked to zero) is pinned as a SHA-256 digest rather than the
raw bytes, so this file's byte listing is the only place those bytes
are ever written down, and no ROM-derived array over 32 bytes is
carried in source or test code.

## Exercised by

- `src/rom/LevelTableGate.ts` -- `readSpritePointerSite` (index, mid
  and tail segments, each gated independently) and `readVerticalTable`
  (vanilla or the GPW2 JML shape).
- `test/suite/unit/LevelTableGate.test.ts` -- synthetic coverage of
  every branch above; a masked-hash match needs no ROM, because
  masking makes the hash indifferent to the operand values a test
  fixture chooses.
- en-gen/hackbench#231.
