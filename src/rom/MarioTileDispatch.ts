/**
 * MarioTileDispatch.ts - faithful port of SMW's Mario-tile dispatch
 * chain starting at `CODE_00F127` (bank_00.asm:12789).
 *
 * The SMW routine is called with A = tile low byte, Y = direction
 * (0-3 after AND #$03). It dispatches into one of three outcomes:
 *
 *   - HurtMario: tile hurts Mario (spike / tileset-specific hazards).
 *     Mario does not come to rest on the tile - he bounces off.
 *   - Pass-through (RTL / `Return00F1F8`): tile has no effect; Mario
 *     passes through without stopping.
 *   - Block-action (via `CODE_00F17F` → `CODE_028752`): tile has a
 *     hit interaction (coin spawn, vine grow, note-block bounce,
 *     P-switch reveal, etc.). Mario's forward movement is arrested
 *     at the tile's face while the action fires.
 *
 * This port returns a discriminated result so callers can pick the
 * outcome relevant to the question they're asking:
 *
 *   - "Does Mario stop on this tile?" → `Hit` (stops) vs anything
 *     else (doesn't stop).
 *   - "Is this tile a Mario wall?" → same, but filtered by direction
 *     (side = dir 1 or 2).
 *
 * Every branch is a direct ASM port with line-level citations. Carry
 * flag propagation is replicated faithfully - see comments.
 */

import type { RomFile } from './RomFile'
import {
  DATA_A625_LEN,
  DATA_F0A4_LEN,
  DATA_F0EC_LEN,
  readDataA625,
  readDataF0A4,
  readDataF0EC,
} from './BlockBehaviorLoader'

/** Outcome of `CODE_00F127` dispatch for a given tile + tileset + direction. */
export type MarioDispatch =
  | { kind: 'hit' } // Tile has a block-hit action; Mario stops to trigger it.
  | { kind: 'hurt' } // Tile routes to `HurtMario`; Mario bounces off.
  | { kind: 'passThrough' } // Tile is not solid for Mario; he continues through.

/** Cached ROM-loaded tables for the dispatch. Read once per ROM. */
export interface MarioDispatchTables {
  readonly dataA625: Uint8Array // 16 bytes
  readonly dataF0A4: Uint8Array // 36 bytes
  readonly dataF0EC: Uint8Array // 12 bytes
}

export function readMarioDispatchTables(rom: RomFile): MarioDispatchTables {
  return {
    dataA625: readDataA625(rom),
    dataF0A4: readDataF0A4(rom),
    dataF0EC: readDataF0EC(rom),
  }
}

/**
 * Faithful port of `CODE_00F127` (bank_00.asm:12789-12845) + the
 * routines it falls through to (`CODE_00F140`, `CODE_00F144`,
 * `CODE_00F14C`, `CODE_00F15F`, `CODE_00F160`, `CODE_00F17F`).
 *
 * Parameters:
 *   lowByte     - `Map16TileNumber` low byte (A register at entry)
 *   tileset     - `ObjectTileset` (0-$F)
 *   direction   - which Mario face touches the tile (AND #$03 → 0-3).
 *                 Per `DATA_00F0EC` (bank_00.asm:12772) mapped to
 *                 `PlayerBlockedDir` bits (rammap.asm:632):
 *                   0 → $08 bit 3 = PlayerBlock_Top    → head bump  (ceiling)
 *                   1 → $01 bit 0 = PlayerBlock_Right  → side       (wall)
 *                   2 → $02 bit 1 = PlayerBlock_Left   → side       (wall)
 *                   3 → $04 bit 2 = PlayerBlock_Bottom → feet land  (floor)
 *   tables      - pre-loaded `DATA_00A625` / `F0A4` / `F0EC` byte arrays
 *
 * Returns the dispatch outcome Mario experiences at this tile.
 */
export function marioTileDispatch(
  lowByte: number,
  tileset: number,
  direction: number,
  tables: MarioDispatchTables,
): MarioDispatch {
  const low = lowByte & 0xff
  const ts = tileset & 0xff
  const dir = direction & 0x03

  // CODE_00F127 (bank_00.asm:12789):
  //   CMP #$2F / BEQ CODE_00F154  - spike / hurt range
  if (low === 0x2f) return { kind: 'hurt' }

  // CMP #$59 / BCC CODE_00F144
  if (low < 0x59) {
    return dispatchF144(low, ts, dir, tables)
  }

  // CMP #$5C / BCS CODE_00F140
  if (low >= 0x5c) {
    return dispatchF140(low, ts, dir, tables)
  }

  // Fallthrough: $59-$5B
  // XBA / LDA ObjectTileset / CMP #$05 BEQ CODE_00F154 / CMP #$0D BEQ CODE_00F154
  if (ts === 0x05 || ts === 0x0d) return { kind: 'hurt' }
  // XBA (restore) / fallthrough to CODE_00F140
  return dispatchF140(low, ts, dir, tables)
}

// CODE_00F140: CMP #$5D / BCC CODE_00F14C
function dispatchF140(
  low: number,
  tileset: number,
  direction: number,
  tables: MarioDispatchTables,
): MarioDispatch {
  if (low < 0x5d) return dispatchF14C(low, tileset, direction, tables)
  return dispatchF144(low, tileset, direction, tables)
}

// CODE_00F144: CMP #$66 BCC F160 / CMP #$6A BCS F160 / fallthrough CODE_00F14C
function dispatchF144(
  low: number,
  tileset: number,
  direction: number,
  tables: MarioDispatchTables,
): MarioDispatch {
  if (low < 0x66 || low >= 0x6a) {
    return dispatchF160(low, tileset, direction, tables)
  }
  // $66-$69: fallthrough to CODE_00F14C
  return dispatchF14C(low, tileset, direction, tables)
}

// CODE_00F14C: tileset == 1 → HurtMario; else CODE_00F15F → CODE_00F160
function dispatchF14C(
  low: number,
  tileset: number,
  direction: number,
  tables: MarioDispatchTables,
): MarioDispatch {
  if (tileset === 0x01) return { kind: 'hurt' }
  return dispatchF160(low, tileset, direction, tables)
}

// CODE_00F160 (bank_00.asm:12827):
//   SEC / SBC #$11 / CMP #$1D / BCC CODE_00F17F
//   else tileset-dep fallthrough
function dispatchF160(
  low: number,
  tileset: number,
  direction: number,
  tables: MarioDispatchTables,
): MarioDispatch {
  // SEC + SBC #$11 - C=1, so SBC = A - $11 - 0
  const a1 = (low - 0x11) & 0xff
  // CMP #$1D - sets C=1 if a1 >= $1D, else C=0 (borrow)
  if (a1 < 0x1d) {
    // BCC CODE_00F17F - reached for low $11-$2D
    return dispatchF17F(a1, direction, tables)
  }

  // Tileset-dep fallthrough (line 12832-12844):
  //   XBA / PHX / LDX ObjectTileset / LDA DATA_00A625,X / PLX /
  //   AND #$03 / BEQ + / RTL
  const a625 = tileset < tables.dataA625.length ? tables.dataA625[tileset] : 0
  if ((a625 & 0x03) !== 0) {
    // RTL → not solid
    return { kind: 'passThrough' }
  }

  // + XBA / SBC #$59 / CMP #$02 / BCS Return00F1F8 / ADC #$22 → F17F
  // Carry entering SBC: from CMP #$1D above, C=1 (since a1 >= $1D).
  // SBC with C=1: a2 = a1 - $59 - 0 = a1 - $59 (may underflow; the 6502
  // would set C=0, but CMP #$02 below overwrites C before any
  // carry-dependent op, so we don't track it explicitly).
  const a2 = (a1 - 0x59) & 0xff
  // CMP #$02: C=1 if a2 >= $02
  if (a2 >= 0x02) {
    // BCS Return00F1F8 → not solid
    return { kind: 'passThrough' }
  }

  // ADC #$22 - C state from CMP #$02 BCS fails (a2 < $02, C=0 after CMP).
  // CMP #$02 sets C based on a2 vs $02, not inheriting from the prior SBC.
  const a3 = (a2 + 0x22 + 0) & 0xff
  return dispatchF17F(a3, direction, tables)
}

// CODE_00F17F (bank_00.asm:12846):
//   PHX / PHA / TYX / LDA DATA_00F0EC,X / PLX / AND DATA_00F0A4,X / BEQ CODE_00F1F6
//   (BEQ skip = pass-through; else block-action fires = hit)
function dispatchF17F(
  tileIndex: number,
  direction: number,
  tables: MarioDispatchTables,
): MarioDispatch {
  if (tileIndex >= tables.dataF0A4.length) {
    // Out of table range - shouldn't happen for valid dispatch inputs.
    return { kind: 'passThrough' }
  }
  const dir = direction & 0x03
  const ecValue = dir < tables.dataF0EC.length ? tables.dataF0EC[dir] : 0
  const a4Value = tables.dataF0A4[tileIndex]
  if ((ecValue & a4Value) === 0) {
    return { kind: 'passThrough' }
  }
  return { kind: 'hit' }
}

/**
 * Convenience: does Mario come to rest on this tile (any direction)?
 *
 * True iff ANY direction yields a `hit` dispatch (tile has a block
 * action from that direction). False for hurt / pass-through - those
 * don't settle Mario on the tile.
 *
 * This is the "Mario-surface" predicate: a tile that stops Mario from
 * at least one direction he can approach from.
 */
export function marioStopsOnTile(
  lowByte: number,
  tileset: number,
  tables: MarioDispatchTables,
): boolean {
  for (let dir = 0; dir < 4; dir++) {
    const d = marioTileDispatch(lowByte, tileset, dir, tables)
    if (d.kind === 'hit') return true
  }
  return false
}

/** Length sanity re-exports for tests. */
export { DATA_A625_LEN, DATA_F0A4_LEN, DATA_F0EC_LEN }

// --------------------------------------------------------------------
// Mario FEET-LANDING dispatch - separate from the block-action F127
// --------------------------------------------------------------------

/**
 * Mario's vertical/feet-landing dispatch from `CODE_00EDF7`
 * (bank_00.asm:12401). Called when Mario is moving downward and his
 * feet touch a tile - decides whether the tile stops his fall.
 *
 * Dispatch by `Map16TileNumber` low byte (Y register):
 *
 *   < $6E:  CODE_00EDF7 path. `LDA PlayerYSpeed+1 / BMI Return` - if
 *           Mario is moving UP, return (no landing). Otherwise:
 *           - If `ObjectTileset` is $03 or $0E AND low byte is
 *             $59-$5B: branch `CODE_00EE1D` (Mario stays in air,
 *             tile is a hole).
 *           - Else: CODE_00EE11 path. If Mario's pixel position
 *             within the block (`PlayerYPosInBlock & $0F`) is in the
 *             upper half (< $08), Mario LANDS (`CODE_00EE3A`).
 *             Otherwise return (in air, tile not reached yet).
 *
 *   $6E-$D7: slope landing via `CODE_00ED86` (bank_00.asm:12334).
 *            Uses per-tile slope-height data at `DATA_00E632` to
 *            compute `PlayerBlockMoveY` and set `PlayerIsOnGround`
 *            when the pixel-X position within the tile is below the
 *            slope's height at that X.
 *
 *   $D8-$FA: also routed through the slope-angle dispatch (same
 *            `CODE_00ED86` path).
 *
 *   $FB+:    special (`JMP CODE_00F629`).
 *
 * This means most tiles with low byte in the `$00-$6D` range are
 * Mario-feet-solid - a FAR broader set than `CODE_00F127`'s block
 * action dispatch. For the "Show surfaces" overlay, this is the
 * dispatch that actually governs whether Mario can stand on a tile.
 *
 * The port below covers the `$00-$6D` branch of CODE_00EDF7. The
 * slope-angle path (`CODE_00ED86`) requires porting the
 * `DATA_00E632` per-tile slope-height table, which is tracked
 * separately for Phase 3 slope work. For Phase 1 purposes, slopes
 * are handled via the `slopeTable` membership check elsewhere in
 * classify.
 */
export type MarioLanding =
  | { kind: 'land' } // Mario lands on this tile (from above)
  | { kind: 'hole' } // Tile is a hole - Mario falls through (tileset 3/$E, low $59-$5B)
  | { kind: 'slope' } // Slope range - see slopeTable membership + Phase 3 angle data
  | { kind: 'special' } // Upper $FB+ range - JMP CODE_00F629, not ported here

export function marioFeetLanding(lowByte: number, tileset: number): MarioLanding {
  const low = lowByte & 0xff
  const ts = tileset & 0xff

  // $6E-$D7: slope angle dispatch (CODE_00ED86)
  if (low >= 0x6e && low <= 0xd7) return { kind: 'slope' }
  // $D8-$FA: also routed to slope-angle
  if (low >= 0xd8 && low <= 0xfa) return { kind: 'slope' }
  // $FB+: JMP CODE_00F629
  if (low >= 0xfb) return { kind: 'special' }

  // < $6E: CODE_00EDF7 path
  // Tileset $03 / $0E specific: $59-$5B are holes
  if ((ts === 0x03 || ts === 0x0e) && low >= 0x59 && low <= 0x5b) {
    return { kind: 'hole' }
  }

  // Otherwise Mario lands (pixel-position gating happens at runtime
  // and doesn't affect classification of the tile's solidity).
  return { kind: 'land' }
}

// --------------------------------------------------------------------
// Mario SOLIDITY predicate - CODE_00F545 port
// --------------------------------------------------------------------

/**
 * Runtime P-switch state consumed by `marioTileSolidity`. These map to
 * `BluePSwitchTimer` / `SilverPSwitchTimer` in RAM; "active" means the
 * corresponding timer is non-zero.
 */
export interface PSwitchState {
  readonly bluePSwitchActive: boolean
  readonly silverPSwitchActive: boolean
}

/** Default: no P-switch pressed (both timers = 0). */
export const PSWITCH_INACTIVE: PSwitchState = {
  bluePSwitchActive: false,
  silverPSwitchActive: false,
}

/**
 * Port of `CODE_00F545` (bank_00.asm:13410) - the Mario tile solidity
 * predicate. The ROM calls this from `CODE_00F44D` (bank_00.asm:13342)
 * which reads a Map16 tile's low byte from bank $7E and high byte from
 * bank $7F, then JSLs F545 with A = high byte. F545 returns A = 0 for
 * non-solid tiles and A != 0 for solid tiles. The caller at F44D does
 * `CMP #$00` + RTS so the return Z flag gates the dispatch: in
 * `CODE_00EB77` (bank_00.asm:12073-12074) `BEQ CODE_00EBDD` skips the
 * `TSB PlayerBlockedDir` wall-flag path for non-solid tiles.
 *
 * This is MARIO'S side-collision predicate (and - since F44D is also
 * called from the landing dispatch - his feet-landing predicate). It is
 * DIFFERENT from the sprite range check (`CODE_01928E`/`0192C9`) which
 * tests low byte `$11-$6D` directly.
 *
 * Dispatch (high byte == 0):
 *   low $29: solid iff Blue P-switch active (remap $29 → $24).
 *   low $2B: solid iff Blue P-switch active (remap $2B → $32).
 *   low $EC-$FB: solid via Switch-palace path (remap → $32, sets
 *     `SwitchPalacePressed`).
 *   everything else: NON-SOLID.
 *
 * Dispatch (high byte != 0):
 *   low $32 AND Blue P-switch active: NON-solid (remap → $2B).
 *   low $2F AND Silver P-switch active: NON-solid (remap → $2B).
 *   everything else: SOLID (A retains the original high byte, non-zero).
 *
 * Consequences for vanilla SMW:
 *   - All page-1 tiles ($1xx) except $132/$12F-with-switch are solid.
 *     That's ground ($100), item blocks ($11A, $11E), turn blocks,
 *     decorative-but-walkable terrain.
 *   - All page-0 tiles ($0xx) with low byte outside the special cases
 *     are NON-solid - this is how checkpoint-post bodies ($030, $032,
 *     $033, $035), the midway tape ($038), goal tape ($039, $03C),
 *     decorative fill ($03F), lava/decoration corners ($0A3, $0A6),
 *     spike-top column ($02F), and dragon-coin graphics ($02A-$02E)
 *     all pass through Mario horizontally and vertically.
 *   - Block-action handlers still fire for non-solid tiles via the
 *     separate `CODE_00F28C` / `CODE_00F2C9` / `CODE_00F127` chains,
 *     so coins collect, midway tape saves + powers up, etc. - F545
 *     only gates the PHYSICAL WALL flag.
 */
export function marioTileSolidity(
  lowByte: number,
  highByte: number,
  state: PSwitchState = PSWITCH_INACTIVE,
): boolean {
  const low = lowByte & 0xff
  const high = highByte & 0xff

  // TAY / BNE CODE_00F577 - high-byte != 0 branch
  if (high !== 0) {
    // CODE_00F577 (bank_00.asm:13442): two P-switch remap cases, else solid
    if (low === 0x32) {
      // Blue P-switch active: remap to $2B, A = 0 → non-solid
      // (bank_00.asm:13446-13448 BNE CODE_00F58D falls into A=0)
      return !state.bluePSwitchActive
    }
    if (low === 0x2f) {
      // Silver P-switch active: remap to $2B, A = 0 → non-solid
      // (bank_00.asm:13453-13454 BEQ Return00F594 preserves A, else A=0)
      return !state.silverPSwitchActive
    }
    // Default: RTL with A = high (non-zero → solid)
    return true
  }

  // High byte == 0 branch (bank_00.asm:13413+)
  // CPY #$29 / BNE PSwitchNotInvQBlk
  if (low === 0x29) {
    // Invisible POW ?-block. Blue P-switch active remaps to $24 (solid);
    // inactive returns A = 0 (non-solid, unchanged from entry).
    return state.bluePSwitchActive
  }

  // PSwitchNotInvQBlk: CPY #$2B / BEQ PSwitchCoinBrown
  if (low === 0x2b) {
    // Coin. Blue P-switch active remaps to $32 (solid); inactive A=0.
    return state.bluePSwitchActive
  }

  // TYA / SEC / SBC #$EC / CMP #$10 / BCS CODE_00F592
  // Low bytes $EC-$FB fall into the INC A → STA SwitchPalacePressed →
  // CODE_00F571 (LDA #$32) path: A = $32, solid.
  const delta = (low - 0xec) & 0xff
  if (delta < 0x10) {
    // $EC-$FB: switch-palace range, solid.
    return true
  }

  // Everything else: F592 path → A = 0 → non-solid.
  return false
}
