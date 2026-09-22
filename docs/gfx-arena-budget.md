# The GFX arena, and how much editing fits in it

Evidence scope for everything below: 6 cartridges, one machine, measured
through `src/rom/GfxTable.ts` and `src/rom/GfxArena.ts` on 2026-09-22 with a
throwaway probe that was not committed. Re-derivable by re-running the same
functions against the same corpus.

## What the cartridge holds

The 50 GFX files are LC_LZ2 streams packed with no gaps. Editing a tile
changes how compressible it is, so its stream length changes, so every file
behind it moves. A save therefore relays the whole packed region and rewrites
the 150 pointer bytes.

| Cartridge | Regions | Bytes used | Capacity | Slack |
| --- | ---: | ---: | ---: | ---: |
| Super Mario World (USA) | 1 | 107,284 | 108,039 | 755 |
| Seven Vanilla Levels | 1 | 107,284 | 108,039 | 755 |
| Grand Poo World 1.2 | 4 | 115,981 | 115,981 | 0 |
| Grand Poo World 2 1.1 | 4 | 115,965 | 115,965 | 0 |
| Invictus 1.0 | n/a | n/a | n/a | refused |

A region is a maximal chain of streams that abut exactly. Vanilla has one of
50. Both Grand Poo Worlds keep 47 packed and place 3 files elsewhere, and
those three keep their own locations rather than being gathered in: moving
them would move data the hack deliberately placed.

Vanilla's 755 bytes of slack are the `$FF` run at file offsets
`$05FD0D..$05FFFF`, which SMWDisX `freespace.txt:138-140` lists as free
(`$0BFD0D..$0BFFFF`, `$2F3` bytes, U cart). Capacity stops at the LoROM bank
boundary on purpose: a longer run of `$FF` is not evidence that nothing else
owns it.

Invictus 1.0 has replaced the LC_LZ2 decompressor entry at `$00B8DE`, so its
GFX are not LC_LZ2 at all and every write is refused.

## What the encoder costs

Structure-preserving re-encode reproduces an unedited cartridge **byte for
byte**: the baseline re-encode of all 50 vanilla files comes to 107,284
bytes, which is exactly what the cart already holds. A correct from-scratch
greedy encoder came to 117,834 on the same input, 9.8% worse and 9,795 bytes
past the arena, which is why the encoder walks the original command stream
instead.

## The realistic edit budget

The spec left this open, because measuring it needed the real encoder.

On a vanilla-shaped cartridge, with 755 bytes of slack:

| Edit | Fits before overflow |
| --- | ---: |
| Scattered single pixels | 119, 210, 230 (three seeds) |
| Whole tiles redrawn as noise | 82 |
| Whole tiles redrawn as a 2-color checker | 206 |
| Whole tiles painted flat | unbounded; each one RECLAIMS bytes |

Painting one tile flat takes the total from 107,284 down to 107,269, a
15-byte saving: the spike guessed this and could not measure it, and it
holds. A 20-pixel doodle inside one tile costs 12 bytes. A scattered
single-pixel edit averages roughly 3 to 6 bytes.

So on a stock cartridge the v1 limit is real but not a roadblock: a hundred
or more pixel edits, or dozens of fully redrawn tiles, before the arena is
full.

**On both Grand Poo Worlds the slack is zero, and the FIRST single-pixel
edit overflows.** A 20-pixel doodle overflows. One noise tile overflows. The
only edit that fits is one that makes the file more compressible. For any
cartridge whose GFX region is already packed to its own end, the painter is
unusable until en-gen/hackbench#446 (ROM expansion) lands, and two of the
four editable carts in this corpus are in that state.

## What a save costs an exported patch

Separate question from the budget, and the intuition is wrong, so it is
measured here too (vanilla cartridge, one machine).

The encoder returns every untouched file byte for byte, so an edit that does
not change any stream's LENGTH touches only that stream. But the files are
packed with no gaps, so a stream that grows by three bytes shifts every file
behind it, and the exported patch is then the rest of the region:

| Edit | Runs | Bytes changed |
| --- | ---: | ---: |
| One pixel in GFX $00 (first file) | 4,598 | 102,185 |
| One pixel in GFX $31 (last file) | 47 | 1,208 |
| One tile painted flat in GFX $00 | 4,079 | 102,865 |

So "the patch stays proportional to the edit" is true of the CONTENT and not
of the position: an edit near the front of the arena exports as most of the
region whatever the encoder does. Fixing that would mean laying files out in
an order the cartridge does not currently use (pointers are per-file, so
nothing requires them to stay in index order), which is a layout change this
work deliberately did not make: the spec asks for a contiguous relay from the
arena start, and reordering trades a smaller patch for slack burned on
abandoned copies.
