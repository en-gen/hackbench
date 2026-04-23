import type { RomFile } from './RomFile'

/**
 * Map16 "acts-like" table: maps a tile id to the tile id whose behavior
 * the game dispatches. In vanilla SMW the block-hit handler at CODE_00F127
 * reads `Map16TileNumber` (low byte of the Map16 tile) directly and indexes
 * into DATA_00F05C, so there is no indirection — acts-like is the identity.
 *
 * Lunar Magic extends this by patching an "acts like" override table into
 * the ROM: any tile can be configured to behave as any other. This is how
 * a custom turn-block at $11A can generate a vine (it "acts like" $2B,
 * whose low byte $1A + $11 = $2B maps to DATA_00F05C[25] = $03 = vine).
 *
 * The exact hijack location varies by LM version and hasn't been
 * pinned down here yet — for now this returns a small sparse map that
 * covers the common vanilla-style page-1 aliases ($119, $11A) so vine
 * detection works against LM-edited ROMs that use them. Tiles absent
 * from the map default to identity (`actsLike === id`).
 *
 * TODO: locate LM's patched acts-like table in the ROM and read it
 * dynamically. Proper LM support means any custom acts-like mapping
 * (not just the built-in aliases) drives behavior selection.
 */
export function readActsLikeTable(_rom: RomFile): Map<number, number> {
  return new Map<number, number>([
    // Page-0 vine-source tiles in common tilesets. Visually these are
    // turn blocks / jump blocks; LM configures them to act like $02A/$02B
    // so hitting them reaches the vine generator (DATA_00F05C[25/26] = $03).
    [0x019, 0x02A],
    [0x01A, 0x02B],
    // Page-1 variants (yellow turn blocks in cave/castle tilesets).
    [0x119, 0x02A],
    [0x11A, 0x02B],
  ])
}
