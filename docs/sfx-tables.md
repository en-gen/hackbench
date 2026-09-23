# Sound effect tables

Where sound effects live, how HackBench finds them without assuming an
address, and why a ROM with custom music reports none at all.

## They are not in a music bank

SFX ride in the SPC engine upload. `UploadSPCEngine` (`bank_00.asm:123`)
sends two blocks: the engine code, then `SoundEffects` (`bank_0E.asm:2025`).
`uploadBlocks` in `src/rom/SpcBuilder.ts` already copies both, so the
engine-and-samples image built for music playback already holds every stock
effect. No music bank is involved and none needs locating.

`buildEngineImage` returns that image plus the ARAM span of the engine's
first block, because the reader routines have to be scanned for inside the
engine's own code. Scanning all 64 KB would also search the sample data,
where a matching byte run means nothing.

## Two tables, one per port

| SNES port | APU port | reader                             | vanilla reader | vanilla table | entries |
| --------- | -------- | ---------------------------------- | -------------- | ------------- | ------- |
| `$1DF9`   | 0        | `APU_071F` (`bank_0E.asm:320-328`) | ARAM `$071F`   | `$5683`       | 42      |
| `$1DFC`   | 3        | `APU_084B` (`bank_0E.asm:479-488`) | ARAM `$084E`   | `$561B`       | 52      |

`$1DFA` (port 1) has **no table**. `APU_09E5` (`bank_0E.asm:695`) branches
to hand-written routines for ids 1-4 and `$FF`, so there is nothing to
enumerate. Those ids are real sounds, just not listable ones; two of them
are the Yoshi drums the music panel already uses as a port toggle.

## Reading a table without assuming its address

Never hardcode `$5683` or `$561B`. Each reader carries its own table in its
operands:

```
MOV A,dp        E4 nn     nn is $04+port, which is what names the port
ASL A           1C
MOV Y,A         FD
MOV A,!t-2+Y    F6 lo hi
MOV dp,A        C4 pp
MOV A,!t-1+Y    F6 lo hi
MOV dp+1,A      C4 pp
```

Three gates, and the middle one carries the weight:

1. The `dp` operand of the opening `MOV` must be `$04+port`. That is what
   distinguishes port 0's reader from port 3's. **This value is measured,
   not derived.** A first attempt reasoned `$0A` from where the music
   command lands and matched nothing at all; the stock readers use `$04`
   and `$07`. `SfxTables.rom.test.ts` pins it.
2. The two absolute operands must be **consecutive**. The routine reads a
   pointer's low byte from `table-2+Y` and its high byte from `table-1+Y`,
   so operands that are not one apart are not this routine however well the
   opcodes match. The table base is the first operand plus 2, because Y is
   the id doubled and id 1 must land on the first slot.
3. Exactly one match per port. Two means we cannot say which one runs.

The table can hold at most **127** entries, and that is read rather than
assumed. The reader does `ASL A` on the id, which is 8-bit on the SPC700,
so `Y = (id << 1) & 0xFF`: id `$80` wraps to `Y=0` and `$81` aliases onto
`$01`. Only `$01..$7F` are reachable. The opcode proving it, `$1C`, is
already part of the pattern above.

## Where a table ends, and why every port must be readable

**A table's length is established by the table above it.** That is not a
refinement; it is the only thing that works, and it is why one unreadable
port refuses all of them.

Measured on the stock ROMs:

| port | table   | ends    | own lowest pointer | own pointers bound it? |
| ---- | ------- | ------- | ------------------ | ---------------------- |
| 3    | `$561B` | `$5683` | `$56E3`            | **no**, slack of `$60` |
| 0    | `$5683` | `$56D7` | `$56D7`            | yes, exactly           |

Port 3 read without port 0 above it does not stop at 52. It runs straight
into port 0's table and reports **94** entries, the extra 42 being port 0's
pointers read as port 3 phrases.

The trap is that the over-read is SELF-CONSISTENT. `$561B + 94*2 = $56D7`,
which is exactly the lowest pointer seen, so it passes a "does the table
end where its data begins" check just as cleanly as the correct answer
does. No test on port 3's own bytes can tell the two apart. Only port 0's
table being at `$5683` distinguishes them.

So `readSfxTable` resolves EVERY port's reader before reading any table,
and refuses all of them if any is missing or ambiguous. The remaining
bounds are backstops rather than the mechanism:

- The block the table sits in. Both tables and every phrase share one block
  on a stock ROM (`$5570..$5FDB`), so this never separates the two; it only
  stops a wild read.
- The lowest pointer seen so far, the same rule `readBankSongPointers`
  uses.

An earlier version of this module bounded port 3 on its own pointers with
the other table as an optional fence, and reported 94 effects whenever port
0's reader was not found. Every one of them was clickable.

The engine does no bounds check of its own, so an id past the table plays
whatever follows it. The table bound is the only thing keeping garbage out
of the listing and out of the player.

## Empty phrases are correct

Port 0's `$22` and `$24` point at a phrase whose first byte is the end
marker, so they render silent. That is the ROM's behaviour, not a fault, so
they stay in the listing and are flagged rather than dropped.

## Playing one

`buildSfxSpc` assembles the engine-and-samples image and writes the id to
the port's INPUT register, `$F4+port`, with no BGM command, so the effect
plays over silence. `CopyToSNES` edge-detects the port
(`bank_0E.asm:111-129`), which is why the value simply sitting in the
snapshot is enough to trigger it.

Three values are read from the engine's own operands rather than assumed:
the DSP default register and value tables, the tempo and its destination,
and the `APU_Loop` entry point. Each must match exactly once; two
candidates means we cannot say which the engine runs, and starting at the
wrong one yields silence or noise with nothing to say which.

`buildSpc`, on the music path, still hardcodes `$12A1`, `$1295` and `$0549`
for the same three things. Retrofitting it is issue #461, deliberately not
done here.

## AddmusicK ROMs report unavailable

On all three AddmusicK ROMs in the corpus the upload routine at `$0080E8`
has been replaced, the whole driver is different, and the stock reader
pattern is absent. Both ports report unavailable with a reason.

This is the point of the feature, not a limitation of it. Listing the stock
42 and 52 for a ROM that has none of them would be confidently wrong and
would look right, and the player would produce nothing for every one.

Measured 2026-09-23, one machine:

| ROM                                  | port 0        | port 3        |
| ------------------------------------ | ------------- | ------------- |
| vanilla, magic, Seven_Vanilla_Levels | 42 at `$5683` | 52 at `$561B` |
| GPW2 1.1, GPW 1.2, Invictus 1.0      | unavailable   | unavailable   |

Supporting AddmusicK needs its own work: find where its uploader sources
the driver, then find its SFX tables inside that image.
