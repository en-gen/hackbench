# Graphics a sprite uploads through Mario's tile DMA

Evidence scope: vanilla USA ROM, SMWDisX, the `layers_v5` Mesen captures (164 archives), one machine, 2026-10-16.
Code: `src/rom/MarioGraphics.ts`; tests `test/suite/unit/MarioGraphics.*.test.ts`.

## The upload

`MarioGFXDMA` (bank_00.asm:4583-4605) copies `$40` bytes per slot from `$7E:<DynGfxTilePtr + 2n>` to OBJ VRAM: row 1
(`DynGfxTilePtr`, rammap.asm:1321) to word `$6000`, row 2 (`+$0A`) to word `$6100`, `PlayerGfxTileCount` bytes of
pointers per row (5 slots, 2 chars each). Slot `s` of row 1 lands on OBJ chars `2s, 2s+1`; row 2 on `$10+2s, $11+2s`. A
sprite that owns a slot writes the pointer in its graphics routine, so the chars it draws are not its SP1 file.

## The Podoboo ($33)

`CODE_01E198` (bank_01.asm:13180-13197), reached when `SpriteTableC2` is 0 (bank_01.asm:13119-13120): `DynGfxTilePtr+6`
(slot 3, row 1) `= $8500 + (8 << 5) = $8600`, `DynGfxTilePtr+$10` (slot 3, row 2) `= $8800`. Chars 6, 7 come from
`$7E:8600`, chars `$16`, `$17` from `$7E:8800`. The map view used to draw SP1's chars 6/7/`$16`/`$17`, which hardware
overwrites every frame.

## The buffer

`CODE_00B888` (bank_00.asm:6250-6290), once at boot: GFX33 (`08:BFC0`, `$2400` bytes, 3bpp) is decompressed to
`$7E:2000` and expanded in place, backwards, into 384 4bpp tiles ending at `$7E:ACFF` (so tile `t` is at `$7D00 + 32t`:
the Podoboo pieces are tiles 72, 73 and 88, 89); GFX32 (Mario, `$5D00` bytes) is then decompressed over `$7E:2000`.
GFX32 follows GFX33's last byte's bank at `$8000` (`ReadByte` carries the bank at `$FFFF`, bank_00.asm:6405-6413).
The expansion per 24-byte tile: the 8 plane-2 bytes as words with a zero high byte, then the 8 plane-0/1 words
(bank_00.asm:6267-6288).

## What proves the decode

- Mario's own poses: of 3864 capture slots whose WRAM pointer lies in GFX32, 3732 equal the buffer at that pointer.
- The Podoboo: no sample has the Podoboo's pointers in its WRAM (D90: none at a draw frame), but 240 VRAM samples in 8
  maps (`$01A $020 $0D6 $101 $111 $11C $1CD $1D4`) hold all four decoded chars at slots 3 of both rows (128 bytes).
- GFX33's expansion: 263 distinct nonzero expanded tiles occur verbatim in 6829 VRAM samples, 253 of them with
  plane 2 set.

The two upload loops (bank_00.asm:4580-4605) are pinned by a SHA-256 over 64 bytes at `$00:A34D` (`STOCK_DMA`), so a
hack that edits the VRAM destination or the row spacing there is refused. The four callers are checked as well, each an
opcode `$20` whose operand must equal the address of the routine found by hash: the boot call at `$00:9414`
(bank_00.asm:2300) and the three MarioGFXDMA calls in the NMI handler at `$00:821D`, `$00:823A` and `$00:82D7`
(bank_00.asm:274, 289, 365), MarioGFXDMA being `$4D` before the loops (SMW_U.sym `A300`). Evidence scope: the vanilla ROM
passes, one machine, and synthetic redirected callers are refused (`MarioGraphics.synthetic.test.ts`). Not proven: the
bytes of MarioGFXDMA before the loops (its palette DMA and the `$67F0` row) are not hashed, nor is that the NMI reaches
those three call sites in a hack that rearranges the handler.

## Hacks (D51, D57)

141 of the 146 hack-corpus ROMs replace the boot routine that builds the buffer (counted 2026-10-16 on the #980 branch
at 16231f50, one machine), so the buffer is not read and the Podoboo keeps today's art (the map's SP1 chars), with a
sprite note giving the reason. Vanilla first; the hack path is not interpreted yet. That SP1 + note path is proven only
by synthetic tests (`MapSprites.test.ts`, `MarioGraphics.synthetic.test.ts`): no hack Podoboo reaches the draw, because
the 698 Podoboos in the hack corpus are refused earlier, at the HandleSprite dispatch shape check.

## The grader (#980)

The sprite report's 10 wrong `$33` cards (maps `$101`, `$1CD`, `$1D4`) were the grader seeding the level image without
clearing the cluster-sprite numbers (`levelSeed` does, `LevelLoader.ts` `NO_CLUSTER_SPRITES`): the castle flames
(OAM 124-127) were counted as the Podoboo's pieces. The grader's rom-mode seeds now clear `$18B8` and `$1892-$18A5`
too (`spriteReportRun.ts`, `spriteGrade.captures.test.ts`). The change is not limited to `$33`: it clears the level's
cluster sprites for every record, so every sprite on a castle map stops carrying flame pieces. Chosen-pass totals over
the 1,957 records, 'rom' seed, one machine, one run each, before (grader without the clearing) and after (17dbd4d0):
exact 998 to 1018, shape 803 to 810, wrong 125 to 97, close 18 to 18, empty 13 to 14, missAtK 25 to 29 (ceiling 30).
The 28 records that changed grade: map `$101` 14 wrong to exact and `$54` slot 0 wrong to empty, `$1D4` 5 and `$1CD` 1
wrong to exact, map `$01F` `$67` 7 wrong to shape. The one empty: `$54`'s only recorded tile is OAM entry 124 (tile `$E4`,
palette row 12, the castle flame), not a tile of the sprite, and the model draws nothing for it, so empty is the
honest grade; before it graded wrong by matching flame pieces the cluster sprite wrote. The 3 left (`$1D4` list 7, 9, 11) record castle-flame entries as the Podoboo's, a hardware-side attribution of a frame where the Podoboo drew nothing.
