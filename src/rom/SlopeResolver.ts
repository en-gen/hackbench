/**
 * SlopeResolver.ts — faithful port of SMW's slope-angle dispatch at
 * `CODE_00ED86` (bank_00.asm:12334-12381) as a pure lookup: given a
 * tile's acts-like low byte plus the level's object tileset, produce
 * the 16-byte per-pixel-X surface-height profile for that tile.
 *
 * At runtime the ROM does:
 *
 *   Y     = low - $6E              ; index into per-tileset map
 *   idx   = [SlopesPtr],Y          ; slope-index byte (0..31)
 *   base  = idx * 16               ; slope-index << 4
 *   X     = base | pixelX          ; 0..15 column within the tile
 *   ySurf = DATA_00E632,X          ; surface Y for that column
 *
 * `SlopesPtr` (rammap.asm:700) is loaded by `CODE_0581FB`
 * (bank_05.asm:253) at level init: `DATA_00E55E` is the default target
 * (bank_05.asm:260-268), replaced by `DATA_00E5C8` when the foreground
 * tileset is 0 or 7 (bank_05.asm:317-327 — the `CODE_058281` branch).
 *
 * This resolver reproduces the dispatch as a static lookup so the map
 * editor can render the slope surface without emulating the CPU. For
 * visualisation we do NOT replicate the `CPY #$D2 BCS` gate at
 * bank_00.asm:12340-12342 (tileset 3/$E skips `$D2+` at runtime) —
 * overlay-only deviation, since the slope graphic is still present in
 * the ROM's tile data and designers benefit from seeing it.
 *
 * The `$D8-$FA` range that `marioFeetLanding` also classifies as slope
 * lives outside the 106-entry `SlopesPtr` map and falls back to
 * `null` here. If that range ever needs angle data, a separate port is
 * required.
 *
 * `resolveSlope` consults only the acts-like LOW byte, matching the
 * ROM's `LDA [SlopesPtr],Y` (Y is `low - $6E`) at bank_00.asm:12348.
 * High-byte solidity (the F545 gate at bank_00.asm:12393, which makes
 * page-0 slope-range tiles non-functional decoration) is enforced by
 * the call site in `TileFactory.classify` so this resolver remains a
 * pure lookup.
 */

import {
  DATA_E55E_LEN,
  DATA_E5C8_LEN,
  DATA_E632_LEN,
  readSlopeHeightTable,
  readSlopeIndexMapDefault,
  readSlopeIndexMapOverworld,
  SLOPE_LOW_BASE,
  SLOPE_LOW_END,
} from './BlockBehaviorLoader'
import type { RomFile } from './RomFile'

/**
 * Per-tile slope surface profile. `heights[x]` is the ROM's surface
 * Y-offset (0..15) at pixel column x within the tile, matching what
 * `DATA_00E632,X` returns during Mario's slope-collision dispatch.
 *
 * A smaller value is a higher point on the slope (surface closer to the
 * tile's top edge); larger values are lower. The tile is "empty" (no
 * collision) at Y positions strictly below the surface value, "solid"
 * at Y positions at or above it — this matches `CODE_00ED86`'s
 * `SBC DATA_00E632,X / BPL` logic at bank_00.asm:12361-12364.
 */
export interface SlopeInfo {
  /** Index into `DATA_00E632` for this tile's slope type (0..31). */
  readonly slopeIndex: number
  /** 16 bytes; `heights[x]` is the surface Y (0..15) at pixel column x. */
  readonly heights: Uint8Array
}

/** Byte tables backing the resolver. Read once per ROM. */
export interface SlopeTables {
  /** `DATA_00E632`, 510 bytes. */
  readonly heightTable: Uint8Array
  /** `DATA_00E55E`, 106 bytes; used when tileset != 0 && != 7. */
  readonly indexMapDefault: Uint8Array
  /** `DATA_00E5C8`, 106 bytes; used when tileset == 0 || == 7. */
  readonly indexMapOverworld: Uint8Array
}

export function readSlopeTables(rom: RomFile): SlopeTables {
  return {
    heightTable:       readSlopeHeightTable(rom),
    indexMapDefault:   readSlopeIndexMapDefault(rom),
    indexMapOverworld: readSlopeIndexMapOverworld(rom),
  }
}

/**
 * Resolve a tile's slope surface profile, or `null` when the tile is
 * not a slope.
 *
 * `actsLikeLow` is the acts-like low byte (the same 8-bit value the
 * ROM stores in `Map16TileNumber` before dispatching); high byte is
 * ignored to mirror `CODE_00ED86`'s Y-register input.
 *
 * Per the ASM guards at bank_00.asm:12327-12330, low bytes outside
 * `$6E..$D7` are NOT slopes — this returns `null` for them. The
 * overworld branch selects between the two pointer targets exactly as
 * `CODE_0581FB` does at level init.
 */
export function resolveSlope(
  actsLikeLow: number,
  tileset: number,
  tables: SlopeTables,
): SlopeInfo | null {
  const low = actsLikeLow & 0xFF
  if (low < SLOPE_LOW_BASE || low > SLOPE_LOW_END) return null

  // bank_05.asm:317-327 — tileset 0 or 7 swaps SlopesPtr to DATA_00E5C8.
  const map = (tileset === 0 || tileset === 7)
    ? tables.indexMapOverworld
    : tables.indexMapDefault

  const mapIdx = low - SLOPE_LOW_BASE
  if (mapIdx >= map.length) return null  // defensive; shouldn't hit in-range
  const slopeIndex = map[mapIdx]

  // bank_00.asm:12350-12357 — 4x ASL = slopeIndex * 16; ORA pixelX gives
  // the 16-entry slice covering all pixel columns in the tile.
  const base = slopeIndex * 16
  if (base + 16 > tables.heightTable.length) return null
  const heights = tables.heightTable.subarray(base, base + 16)

  return { slopeIndex, heights }
}

/** Length re-exports for tests. */
export { DATA_E55E_LEN, DATA_E5C8_LEN, DATA_E632_LEN }
