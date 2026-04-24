/**
 * BlockBehaviorLoader.ts — the per-tile block-behavior table from vanilla SMW.
 *
 * `DATA_00F05C` (bank_00.asm:12744) is a 36-byte table indexed by
 * `Map16TileNumber - $11`. It classifies tiles with low bytes $11-$34 into
 * block-hit handler types (see `CODE_00F17F` at bank_00.asm:12846).
 *
 * The values aren't documented in the disassembly with labels — these are
 * derived empirically from vanilla SMW and dispatching in CODE_00F17F:
 *
 *   $00  empty         — no block-hit handler; tile has no interactive block
 *                        behavior (often used for passthrough / decorative).
 *   $01  turn block    — brown "!" block; solid, turns on P-switch.
 *   $02  coin          — collectible coin; sprites pass through (incl. the
 *                        "dragon coin" tiles $02C..$02F in page 0).
 *   $03  vine          — vine source; sprites pass through to reach.
 *   $04  invisible     — coin variant / invisible coin block.
 *   $05  brown block   — solid "used" block.
 *   $06  "!" block     — green "!" block.
 *   $07  P-switch      — P-switch reveal hidden under blue/silver block.
 *   $10  note block    — bouncy note block; solid wall horizontally.
 *   $11  shellless koopa? (rare; single occurrence at tile $32)
 *
 * For overlay / patrol-path purposes, the relevant distinction is "is this
 * tile a wall for sprite horizontal motion?". Coins ($02), empty ($00), and
 * vine sources ($03) are NOT walls; everything else in the table is.
 */

import type { RomFile } from './RomFile'

/** Lowest tile low-byte covered by the block-behavior table. */
export const BLOCK_BEHAVIOR_BASE = 0x11
/** Number of entries in `DATA_00F05C`. */
export const BLOCK_BEHAVIOR_LEN  = 0x24  // 36

/** Block-behavior type indices from `DATA_00F05C`. */
export const BH_EMPTY       = 0x00
export const BH_TURN_BLOCK  = 0x01
export const BH_COIN        = 0x02
export const BH_VINE        = 0x03
export const BH_INVIS_COIN  = 0x04
export const BH_BROWN_BLOCK = 0x05
export const BH_EXCL_BLOCK  = 0x06
export const BH_PSWITCH     = 0x07

/**
 * Read the block-behavior table from `DATA_00F05C`. Returns 36 bytes; index
 * 0 = behavior byte for tile low byte $11, index 35 = tile low byte $34.
 */
export function readBlockBehaviorTable(rom: RomFile): Uint8Array {
  // LoROM $00F05C → file offset via RomFile's accessor.
  const out = new Uint8Array(BLOCK_BEHAVIOR_LEN)
  for (let i = 0; i < BLOCK_BEHAVIOR_LEN; i++) {
    out[i] = rom.readByte(0x00F05C + i) ?? 0
  }
  return out
}

/**
 * Slope-tile table `DATA_00EAC1` (bank_00.asm:11946). 26-entry list of
 * Map16 low bytes that `CODE_00F04D` (bank_00.asm:12730) recognises as
 * slope tiles. A sprite touching a slope tile goes through the slope-angle
 * logic at `CODE_019211` (bank_01.asm:2544) — per-tile diagonal collision
 * via the tile's position in this table, not the uniform solid check.
 *
 * Vanilla contents: $71 $72 $76 $77 $7B $7C $81 $86 $8A $8B $8F $90
 *                   $94 $95 $99 $9A $9E $9F $A3 $A4 $A8 $A9 $AD $AE $B2 $B3
 */
export const SLOPE_TABLE_LEN = 26

/** Read DATA_00EAC1 from ROM — the slope-tile membership table. */
export function readSlopeTable(rom: RomFile): Uint8Array {
  const out = new Uint8Array(SLOPE_TABLE_LEN)
  for (let i = 0; i < SLOPE_TABLE_LEN; i++) {
    out[i] = rom.readByte(0x00EAC1 + i) ?? 0
  }
  return out
}

/**
 * Slope low-byte range served by the per-tileset `SlopesPtr` map. Mario's
 * slope collision dispatch (`CODE_00ED86`, bank_00.asm:12334) is entered
 * only when the tile's low byte is in `$6E..$D7` (the `CPY #$6E BCC` /
 * `CPY #$D8 BCS` guards at bank_00.asm:12327-12330). The two pointer
 * targets `DATA_00E55E` / `DATA_00E5C8` each contain exactly 106 bytes
 * covering that range — anything outside it has no defined slope data.
 */
export const SLOPE_LOW_BASE = 0x6E
export const SLOPE_LOW_END  = 0xD7

/**
 * `DATA_00E632` slope-height LUT (bank_00.asm:11604). 510 bytes, indexed
 * by `(slopeIdx << 4) | pixelX` at bank_00.asm:12350-12363. Each byte is
 * the surface Y-offset (0..15) within the 16x16 tile at that pixel
 * column. `CODE_00ED86` subtracts the returned value from Mario's Y
 * position in the block; a negative result sets `PlayerIsOnGround`.
 */
export const DATA_E632_LEN = 510

export function readSlopeHeightTable(rom: RomFile): Uint8Array {
  const out = new Uint8Array(DATA_E632_LEN)
  for (let i = 0; i < DATA_E632_LEN; i++) {
    out[i] = rom.readByte(0x00E632 + i) ?? 0
  }
  return out
}

/**
 * `DATA_00E55E` — default per-tile slope-index map. 106 bytes covering
 * low bytes `$6E..$D7`. `map[low - $6E]` gives the slope index fed into
 * `DATA_00E632`. This is the pointer target set for every non-overworld
 * tileset at `bank_05.asm:260-268` (`STA.B SlopesPtr+2` and
 * `STA.B SlopesPtr`).
 */
export const DATA_E55E_LEN = 106

export function readSlopeIndexMapDefault(rom: RomFile): Uint8Array {
  const out = new Uint8Array(DATA_E55E_LEN)
  for (let i = 0; i < DATA_E55E_LEN; i++) {
    out[i] = rom.readByte(0x00E55E + i) ?? 0
  }
  return out
}

/**
 * `DATA_00E5C8` — overworld/cave slope-index map. Same 106-byte shape as
 * `DATA_00E55E`, used when `ObjectTileset == 0 || ObjectTileset == 7`
 * per the `CODE_058281` branch at `bank_05.asm:317-327`
 * (`STA.B SlopesPtr` with the `DATA_00E5C8` address).
 */
export const DATA_E5C8_LEN = 106

export function readSlopeIndexMapOverworld(rom: RomFile): Uint8Array {
  const out = new Uint8Array(DATA_E5C8_LEN)
  for (let i = 0; i < DATA_E5C8_LEN; i++) {
    out[i] = rom.readByte(0x00E5C8 + i) ?? 0
  }
  return out
}

/**
 * Per-tileset properties table `DATA_00A625` (bank_00.asm:4909). 16
 * bytes indexed by `ObjectTileset` (0-$F). `CODE_00F160` AND's this
 * byte with `$03` to decide whether the tileset-dep fallthrough returns
 * "not solid" (bits set → RTL not-solid). Vanilla contents:
 *
 *   tileset:   0   1   2   3   4   5   6   7
 *   byte:     $00 $80 $40 $00 $01 $02 $40 $00
 *   tileset:   8   9   A   B   C   D   E   F
 *   byte:     $40 $00 $00 $00 $00 $02 $00 $00
 *
 * Bit 0/1 set in tilesets 4, 5, $D → fallthrough returns not-solid.
 * Other tilesets fall through further (continue SBC $59 / CMP $02 /
 * ADC $22 dispatch).
 */
export const DATA_A625_LEN = 16

export function readDataA625(rom: RomFile): Uint8Array {
  const out = new Uint8Array(DATA_A625_LEN)
  for (let i = 0; i < DATA_A625_LEN; i++) {
    out[i] = rom.readByte(0x00A625 + i) ?? 0
  }
  return out
}

/**
 * Per-tile collision-hit bit-mask `DATA_00F0A4` (bank_00.asm:12758).
 * 36 bytes indexed by `tile_low_byte - $11`. `CODE_00F17F` AND's this
 * with `DATA_00F0EC[direction]`; nonzero result means "tile has a
 * block-hit interaction from this direction" (generates coin, grows
 * vine, etc.). Zero means Mario passes through that face.
 */
export const DATA_F0A4_LEN = 36

export function readDataF0A4(rom: RomFile): Uint8Array {
  const out = new Uint8Array(DATA_F0A4_LEN)
  for (let i = 0; i < DATA_F0A4_LEN; i++) {
    out[i] = rom.readByte(0x00F0A4 + i) ?? 0
  }
  return out
}

/**
 * Per-direction collision-hit bit-mask `DATA_00F0EC` (bank_00.asm:12772).
 * 12 bytes indexed by direction (AND $03 → 0-3) or other dispatch
 * codes. First 4 entries are direction-indexed (one bit per direction):
 *
 *   dir 0 ($08 = bit 3)   — "Mario from above" / landing
 *   dir 1 ($01 = bit 0)   — side
 *   dir 2 ($02 = bit 1)   — side
 *   dir 3 ($04 = bit 2)   — "Mario from below" / head bump
 *
 * Entries 4-11 are used by other dispatch paths inside the
 * `CODE_00F1xx` block-action code (power-up spawn variants etc.). The
 * Mario-tile AND uses indices 0-3.
 */
export const DATA_F0EC_LEN = 12

export function readDataF0EC(rom: RomFile): Uint8Array {
  const out = new Uint8Array(DATA_F0EC_LEN)
  for (let i = 0; i < DATA_F0EC_LEN; i++) {
    out[i] = rom.readByte(0x00F0EC + i) ?? 0
  }
  return out
}

/**
 * True when the tile's acts-like low byte appears in `DATA_00EAC1`. Matches
 * the linear search in `CODE_00F04D` (bank_00.asm:12730-12741): LDX #$19,
 * CMP DATA_00EAC1,X, DEX / BPL.
 */
export function isSlopeTile(actsLike: number, table: Uint8Array): boolean {
  const low = actsLike & 0xFF
  for (let i = 0; i < table.length; i++) {
    if (table[i] === low) return true
  }
  return false
}

/**
 * Look up the block-behavior type for a tile's acts-like low byte. Returns
 * `null` when outside the table's range (low byte < $11 or > $34), meaning
 * the tile is not classified by the table — defer to the low-byte range
 * check in `isActsLikeHorizSolid`.
 */
export function blockBehaviorFor(
  actsLike: number,
  table: Uint8Array,
): number | null {
  const low = actsLike & 0xFF
  if (low < BLOCK_BEHAVIOR_BASE || low >= BLOCK_BEHAVIOR_BASE + BLOCK_BEHAVIOR_LEN) {
    return null
  }
  return table[low - BLOCK_BEHAVIOR_BASE]
}

/**
 * True when a tile with this block-behavior type blocks Mario / sprite
 * horizontal motion (i.e., is a wall / floor / ceiling at the classify
 * layer). The block-behavior table describes what HAPPENS when the
 * block is hit from below (`CODE_00F17F`, bank_00.asm:12846) —
 * generate a coin, grow a vine, reveal a P-switch, etc. It does NOT
 * determine whether the block itself is solid for standing / bumping
 * collision; that's the range check in `CODE_01928E` / `CODE_0192C9`.
 *
 * Consequently only `$00` (empty — no hit handler at all) should
 * exclude a tile from wall classification. `?`-blocks at low `$1F`
 * have behavior `$02` (coin-generator) and are absolutely solid for
 * Mario to stand on. Mario-path passthroughs for genuine pass-through
 * tiles (actual coin graphics, vines as climbables, etc.) are handled
 * by `isMarioStandable` below.
 */
export function isBlockBehaviorWall(behaviorType: number): boolean {
  return behaviorType !== BH_EMPTY
}

/**
 * True when a tile's acts-like low byte is a Mario pass-through that
 * the ROM ALWAYS dispatches to collect/save/hurt instead of stopping
 * Mario's movement. These exclusions match wide low-byte patterns
 * derived directly from Mario-dispatch ASM:
 *
 *   $2A-$2E  coin / dragon coin / Yoshi coin. `CODE_00F32B`
 *            (bank_00.asm:13094). Always collected + pass through.
 *   $66-$69  checkpoint decoration. `CODE_00F14C`
 *            (bank_00.asm:12811). `HurtMario` in tileset 1, tileset-dep
 *            pass-through elsewhere. Not a reliable surface.
 *
 * Climbables `$06-$1C` are NOT excluded — `CODE_00F2C9` sets
 * `InteractionPtsClimbable` for body-overlap grab logic (UP-press),
 * but the feet-level dispatch (`CODE_00EDF7`) still lands Mario on
 * `$11-$2D` regardless.
 *
 * Spike `$2F` and other tileset-specific hazards are NOT excluded
 * here — they're filtered via the `CODE_00F127` port's `hurt` outcome
 * (see `MarioTileDispatch.ts`). Caller in `TileFactory.classify`
 * layers both filters.
 */
export function isMarioStandable(actsLikeId: number): boolean {
  const low = actsLikeId & 0xFF
  if (low >= 0x2A && low <= 0x2E) return false  // coin / dragon coin
  if (low >= 0x66 && low <= 0x69) return false  // checkpoint decoration
  return true
}
