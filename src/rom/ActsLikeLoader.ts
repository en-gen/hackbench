import type { RomFile } from './RomFile'

/**
 * Map16 "acts-like" table: maps a tile id to the tile id whose behavior
 * the game dispatches. In vanilla SMW the block-hit handler at CODE_00F127
 * reads `Map16TileNumber` (low byte of the Map16 tile) directly — there is
 * no indirection, so acts-like is the identity. Vanilla tiles $19, $1A,
 * $2A, $2B etc. dispatch to DATA_00F05C/DATA_00F080 purely by low byte.
 *
 * Lunar Magic extends this by patching an "acts like" override table into
 * the ROM: any tile can be configured to behave as any other. Reading the
 * real LM hijack table is a TODO — for now this returns empty, which is
 * correct for vanilla ROMs and degrades gracefully on LM hacks (custom
 * tiles fall back to identity dispatch).
 */
export function readActsLikeTable(_rom: RomFile): Map<number, number> {
  return new Map<number, number>()
}
