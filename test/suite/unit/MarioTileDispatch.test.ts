/**
 * MarioTileDispatch — faithful port of `CODE_00F127` (bank_00.asm:12789)
 * + fallthrough routines (F140, F144, F14C, F15F, F160, F17F).
 *
 * Tests verify the outcome matrix against known vanilla ASM behavior
 * for representative low bytes + tilesets + directions.
 */

import { describe, expect, it } from 'vitest'
import {
  marioFeetLanding,
  marioTileDispatch,
  marioTileSolidity,
  PSWITCH_INACTIVE,
  type MarioDispatchTables,
} from '../../../src/rom/MarioTileDispatch'

/** Vanilla SMW table values, verified against the disassembly. */
const TABLES: MarioDispatchTables = {
  // DATA_00A625 (bank_00.asm:4909) — per-tileset $03 check gate.
  dataA625: new Uint8Array([
    0x00, 0x80, 0x40, 0x00, 0x01, 0x02, 0x40, 0x00,
    0x40, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00,
  ]),
  // DATA_00F0A4 (bank_00.asm:12758) — per-tile-low-byte bit mask.
  dataF0A4: new Uint8Array([
    0x0C, 0x08, 0x0C, 0x08, 0x0C, 0x0F, 0x08, 0x08,
    0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
    0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
    0x08, 0x03, 0x03, 0x08, 0x08, 0x08, 0x08, 0x08,
    0x08, 0x04, 0x08, 0x08,
  ]),
  // DATA_00F0EC (bank_00.asm:12772) — per-direction bit mask.
  // Indices 0-3 are direction-indexed: bits 3, 0, 1, 2 respectively.
  dataF0EC: new Uint8Array([
    0x08, 0x01, 0x02, 0x04, 0xED, 0xF6, 0x00, 0x7D,
    0xBE, 0x00, 0x6F, 0xB7,
  ]),
}

describe('marioTileDispatch — CODE_00F127 port', () => {
  it('spike $2F → hurt unconditionally (any direction / tileset)', () => {
    // CMP #$2F / BEQ CODE_00F154 → HurtMario
    expect(marioTileDispatch(0x2F, 0, 0, TABLES).kind).toBe('hurt')
    expect(marioTileDispatch(0x2F, 1, 0, TABLES).kind).toBe('hurt')
    expect(marioTileDispatch(0x2F, 5, 2, TABLES).kind).toBe('hurt')
    expect(marioTileDispatch(0x2F, 0x0D, 3, TABLES).kind).toBe('hurt')
  })

  it('$59-$5B → hurt in tileset 5 / $D; else fall through to tileset-dep', () => {
    // Tileset 5 / $D trigger `HurtMario` at line 12798-12801.
    expect(marioTileDispatch(0x59, 5, 0, TABLES).kind).toBe('hurt')
    expect(marioTileDispatch(0x5A, 0x0D, 0, TABLES).kind).toBe('hurt')
    expect(marioTileDispatch(0x5B, 5, 0, TABLES).kind).toBe('hurt')
    // Other tilesets fall through to F140 → F14C → tileset 1 hurt or F160.
    expect(marioTileDispatch(0x59, 0, 0, TABLES).kind).not.toBe('hurt')
  })

  it('$66-$69 → hurt in tileset 1; pass-through elsewhere (CODE_00F14C)', () => {
    expect(marioTileDispatch(0x66, 1, 0, TABLES).kind).toBe('hurt')
    expect(marioTileDispatch(0x69, 1, 0, TABLES).kind).toBe('hurt')
    // Other tilesets: F15F → F160 → tileset-dep fallthrough.
    expect(marioTileDispatch(0x66, 0, 0, TABLES).kind).not.toBe('hurt')
    expect(marioTileDispatch(0x69, 0, 0, TABLES).kind).not.toBe('hurt')
  })

  it('$11-$2D with direction 0 (from above) → hit (block action fires)', () => {
    // F160 SBC $11 → $00-$1C, BCC F17F → F17F with tile index 0-$1C.
    // F0EC[0] = $08, F0A4[0] = $0C → $08 & $0C = $08 nonzero → hit.
    expect(marioTileDispatch(0x11, 0, 0, TABLES).kind).toBe('hit')  // turn block
    expect(marioTileDispatch(0x1F, 0, 0, TABLES).kind).toBe('hit')  // ? block
    expect(marioTileDispatch(0x2D, 0, 0, TABLES).kind).toBe('hit')  // dragon coin
  })

  it('$11-$2D with direction 1 / 2 (side) → pass-through (no block action on side)', () => {
    // F0EC[1] = $01, F0A4[0] = $0C → $01 & $0C = 0 → pass-through.
    // Mario is STILL blocked by the tile from the side at the physics
    // layer, but F17F does not fire an action. This shows F127 is a
    // block-action dispatcher, not a wall-solidity dispatcher.
    expect(marioTileDispatch(0x11, 0, 1, TABLES).kind).toBe('passThrough')
    expect(marioTileDispatch(0x11, 0, 2, TABLES).kind).toBe('passThrough')
    expect(marioTileDispatch(0x1F, 0, 1, TABLES).kind).toBe('passThrough')
  })

  it('main ground $00 in tileset 0 → pass-through (tileset-dep fallthrough)', () => {
    // $00 goes F144 → F160 → SBC $11 = $EF → BCC fails → tileset-dep.
    // DATA_00A625[0] = $00, AND $03 = 0 → BEQ taken → continue.
    // SBC $59 → $96, CMP $02 BCS → Return00F1F8.
    // Note: Mario walks on $100 (main ground) in vanilla. This shows
    // F127 does not cover the feet-landing solidity dispatch.
    expect(marioTileDispatch(0x00, 0, 0, TABLES).kind).toBe('passThrough')
  })

  it('tileset-dep RTL path: tilesets 4, 5, $D return pass-through for mid-range tiles', () => {
    // DATA_00A625[4] = $01, AND $03 = 1 → RTL (not solid) at F160's
    // tileset-dep branch.
    expect(marioTileDispatch(0x3F, 4, 0, TABLES).kind).toBe('passThrough')
    expect(marioTileDispatch(0x3F, 5, 0, TABLES).kind).toBe('passThrough')
    expect(marioTileDispatch(0x3F, 0x0D, 0, TABLES).kind).toBe('passThrough')
  })

  it('$6A-$6B reach F17F via ADC $22 path (low $6C-$6D return pass-through)', () => {
    // After F160 fallthrough: SBC $59 yields $00/$01 for $6A/$6B, $02/$03
    // for $6C/$6D. CMP $02 BCS fails only for $00/$01 → ADC $22 → F17F
    // with tile index $22/$23. F0A4[$22] = $08, F0A4[$23] = $08.
    // F0EC[0] = $08 → AND $08 = nonzero → hit.
    expect(marioTileDispatch(0x6A, 0, 0, TABLES).kind).toBe('hit')
    expect(marioTileDispatch(0x6B, 0, 0, TABLES).kind).toBe('hit')
    // $6C and beyond: CMP $02 BCS → pass-through.
    expect(marioTileDispatch(0x6C, 0, 0, TABLES).kind).toBe('passThrough')
    expect(marioTileDispatch(0x6D, 0, 0, TABLES).kind).toBe('passThrough')
  })
})

describe('marioFeetLanding — CODE_00EDF7 port', () => {
  it('low $00-$6D in most tilesets: Mario lands', () => {
    // CODE_00EDF7 → CODE_00EE11 path marks these as Mario-feet-solid.
    expect(marioFeetLanding(0x00, 0).kind).toBe('land')
    expect(marioFeetLanding(0x11, 0).kind).toBe('land')
    expect(marioFeetLanding(0x1F, 0).kind).toBe('land')
    expect(marioFeetLanding(0x2F, 0).kind).toBe('land')  // spike — Mario LANDS; hurt fires separately
    expect(marioFeetLanding(0x38, 0).kind).toBe('land')  // midway — Mario LANDS; save fires separately
    expect(marioFeetLanding(0x3F, 0).kind).toBe('land')
    expect(marioFeetLanding(0x66, 0).kind).toBe('land')
    expect(marioFeetLanding(0x6D, 0).kind).toBe('land')
  })

  it('$59-$5B in tileset $03 or $0E: hole (Mario falls through)', () => {
    expect(marioFeetLanding(0x59, 0x03).kind).toBe('hole')
    expect(marioFeetLanding(0x5A, 0x0E).kind).toBe('hole')
    expect(marioFeetLanding(0x5B, 0x03).kind).toBe('hole')
    // Other tilesets: land normally
    expect(marioFeetLanding(0x59, 0).kind).toBe('land')
  })

  it('slope range $6E-$D7: slope dispatch (angle data in Phase 3)', () => {
    expect(marioFeetLanding(0x6E, 0).kind).toBe('slope')
    expect(marioFeetLanding(0x71, 0).kind).toBe('slope')  // vanilla slope tile ID
    expect(marioFeetLanding(0xB3, 0).kind).toBe('slope')  // last vanilla slope
    expect(marioFeetLanding(0xD7, 0).kind).toBe('slope')
  })

  it('$D8-$FA: routed to slope-angle dispatch', () => {
    expect(marioFeetLanding(0xD8, 0).kind).toBe('slope')
    expect(marioFeetLanding(0xFA, 0).kind).toBe('slope')
  })

  it('$FB+: special (JMP CODE_00F629)', () => {
    expect(marioFeetLanding(0xFB, 0).kind).toBe('special')
    expect(marioFeetLanding(0xFF, 0).kind).toBe('special')
  })
})

describe('marioTileSolidity — CODE_00F545 port', () => {
  const ACTIVE = { bluePSwitchActive: true,  silverPSwitchActive: false }
  const SILVER = { bluePSwitchActive: false, silverPSwitchActive: true  }

  it('page-1 tiles ($1xx) are solid by default', () => {
    // $100 ground, $11A item block, $11E turn block, $1FF — all solid
    expect(marioTileSolidity(0x00, 0x01)).toBe(true)
    expect(marioTileSolidity(0x1A, 0x01)).toBe(true)
    expect(marioTileSolidity(0x1E, 0x01)).toBe(true)
    expect(marioTileSolidity(0xFF, 0x01)).toBe(true)
  })

  it('page-1 $132: non-solid iff Blue P-switch active (bank_00.asm:13446-13448)', () => {
    expect(marioTileSolidity(0x32, 0x01, PSWITCH_INACTIVE)).toBe(true)
    expect(marioTileSolidity(0x32, 0x01, ACTIVE)).toBe(false)
  })

  it('page-1 $12F: non-solid iff Silver P-switch active (bank_00.asm:13451-13454)', () => {
    expect(marioTileSolidity(0x2F, 0x01, PSWITCH_INACTIVE)).toBe(true)
    expect(marioTileSolidity(0x2F, 0x01, SILVER)).toBe(false)
    // Blue alone does not remap $12F
    expect(marioTileSolidity(0x2F, 0x01, ACTIVE)).toBe(true)
  })

  it('page-0 checkpoint-post bodies ($030/$032/$033/$035): non-solid', () => {
    expect(marioTileSolidity(0x30, 0x00)).toBe(false)
    expect(marioTileSolidity(0x32, 0x00)).toBe(false)
    expect(marioTileSolidity(0x33, 0x00)).toBe(false)
    expect(marioTileSolidity(0x35, 0x00)).toBe(false)
  })

  it('page-0 midway tape $038 and goal tape $039/$03C: non-solid', () => {
    expect(marioTileSolidity(0x38, 0x00)).toBe(false)
    expect(marioTileSolidity(0x39, 0x00)).toBe(false)
    expect(marioTileSolidity(0x3C, 0x00)).toBe(false)
  })

  it('page-0 lava/decoration ($03F, $0A3, $0A6): non-solid', () => {
    expect(marioTileSolidity(0x3F, 0x00)).toBe(false)
    expect(marioTileSolidity(0xA3, 0x00)).toBe(false)
    expect(marioTileSolidity(0xA6, 0x00)).toBe(false)
  })

  it('page-0 $029 invisible ?-block: solid iff Blue P-switch active (bank_00.asm:13414-13419)', () => {
    expect(marioTileSolidity(0x29, 0x00, PSWITCH_INACTIVE)).toBe(false)
    expect(marioTileSolidity(0x29, 0x00, ACTIVE)).toBe(true)
  })

  it('page-0 $02B coin: solid iff Blue P-switch active (bank_00.asm:13434-13440)', () => {
    expect(marioTileSolidity(0x2B, 0x00, PSWITCH_INACTIVE)).toBe(false)
    expect(marioTileSolidity(0x2B, 0x00, ACTIVE)).toBe(true)
  })

  it('page-0 $EC-$FB switch-palace range: solid (bank_00.asm:13427-13432)', () => {
    expect(marioTileSolidity(0xEC, 0x00)).toBe(true)
    expect(marioTileSolidity(0xF0, 0x00)).toBe(true)
    expect(marioTileSolidity(0xFB, 0x00)).toBe(true)
    // $FC onwards falls back to non-solid
    expect(marioTileSolidity(0xFC, 0x00)).toBe(false)
  })
})
