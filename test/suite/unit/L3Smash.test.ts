/**
 * Layer 3's load position under a Layer 3 Smash sprite (#807). Synthetic sprite lists and code
 * bytes built here; the corpus block checks the two vanilla maps against the captured frame 0.
 */
import { createHash } from 'crypto'
import { describe, it, expect } from 'vitest'
import {
  SMASH_SPRITE_ID,
  l3SmashPos,
  readLevelSprites,
  readL3SmashLoadPos,
  readSmashCodeGate,
  L3_SMASH_SITES,
  SMASH_REFUSED,
  SPRITES_UNREADABLE,
} from '../../../src/rom/L3Smash'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelHeader, type LevelSprite } from '../../../src/rom/LevelParser'
import { buildL3Verdict } from '../../../src/rom/model/L3Model'
import { VANILLA, hasRom, romPath } from '../support/corpus'

/** A sprite at pixel (x, y); the parser keeps 16 px units. */
const spr = (spriteId: number, x: number, y: number): LevelSprite => ({ spriteId, x: x / 16, y: y / 16, screen: x >> 8, extraBit: false, raw: [], index: 0, streamOffset: 0 }) // prettier-ignore

describe('l3SmashPos (synthetic sprite lists)', () => {
  it('the sprite id is the literal $89 (Layer 3 smash, bank_01.asm:1035)', () => {
    expect(SMASH_SPRITE_ID).toBe(0x89)
  })

  it('X is the sprite X inside $00-$FF and $100 beyond it; Y is $A0 minus the sprite Y', () => {
    const at = (x: number, y: number) => l3SmashPos([spr(0x89, x, y)], 16)
    expect(at(112, 0)).toEqual({ ok: true, pos: { x: 112, y: 160 } })
    expect(at(288, 0)).toEqual({ ok: true, pos: { x: 256, y: 160 } })
    expect(at(240, 0x30)).toEqual({ ok: true, pos: { x: 240, y: 0x70 } })
    expect(at(256, 0)).toMatchObject({ pos: { x: 256 } })
    expect(at(16, 0xa0)).toEqual({ ok: true, pos: { x: 16, y: 0 } })
  })

  it('a sprite with y past $A0 (lower on screen) refuses (negative Y is not modelled), never an empty success', () => {
    expect(l3SmashPos([spr(0x89, 16, 0x110)], 16)).toMatchObject({ ok: false })
    expect(l3SmashPos([spr(0x89, 16, 0xb0)], 16)).toMatchObject({ ok: false })
  })

  it('no smasher, or one past the start-up load window ($190), leaves layer 3 where CODE_00A007 put it', () => {
    expect(l3SmashPos([spr(0x33, 112, 0)], 16)).toEqual({ ok: true, pos: null })
    expect(l3SmashPos([spr(0x89, 0x190, 0)], 16)).toMatchObject({ pos: { x: 0x100 } })
    expect(l3SmashPos([spr(0x89, 0x1a0, 0)], 16)).toEqual({ ok: true, pos: null })
  })

  it('refuses, with a reason, two loaded smashers and a start where camera X is not known to be 0', () => {
    expect(l3SmashPos([spr(0x89, 16, 0), spr(0x89, 32, 0)], 16)).toMatchObject({ ok: false })
    expect(l3SmashPos([spr(0x89, 16, 0)], 0x80)).toMatchObject({ ok: false })
    expect(l3SmashPos([spr(0x89, 16, 0)], 0x7f)).toMatchObject({ ok: true })
  })
})

const MAIN = 0x02d3ea
const STUB = 0x01883d
const INIT = 0x01843d
const SITE = 0x00ff61
const MAIN_TABLE = 0x0185cc + 0x89 * 2
const INIT_TABLE = 0x01817d + 0x89 * 2
/** Three code regions of distinct bytes (stand-ins for the position routine, the sprite loader and the sweep). */
const REGIONS = [SITE, 0x02a7f6, 0x02aca1].map((addr, i) => ({ addr, bytes: Array.from({ length: 40 }, (_, k) => (k * 7 + i * 31 + 3) & 0xff) })) // prettier-ignore
const sites = REGIONS.map(r => ({ addr: r.addr, length: 40, sha256: createHash('sha256').update(Buffer.from(r.bytes)).digest('hex') })) // prettier-ignore

/** A cart with the sprite $89 chain and the three regions, built from literals. */
function smashRom(): RomFile {
  const rom = new RomFile('smash.sfc', Buffer.alloc(0x80000, 0))
  rom.writeAt(0x00ffd5, [0x20])
  rom.writeAt(MAIN_TABLE, [STUB & 0xff, (STUB >> 8) & 0xff])
  rom.writeAt(INIT_TABLE, [INIT & 0xff, (INIT >> 8) & 0xff])
  rom.writeAt(INIT, [0x60])
  rom.writeAt(STUB, [0x8b, 0xa9, 0x02, 0x48, 0xab, 0x22, MAIN & 0xff, (MAIN >> 8) & 0xff, 0x02])
  for (const r of REGIONS) rom.writeAt(r.addr, r.bytes)
  rom.writeAt(MAIN, [0x22, SITE & 0xff, SITE >> 8, 0x00]) // JSL CODE_00FF61, over the region's first bytes' neighbours
  return rom
}
describe('L3_SMASH_SITES (no ROM)', () => {
  it('pins the three fingerprinted regions exactly', () => {
    expect(L3_SMASH_SITES.map(s => [s.addr, s.length])).toEqual([
      [0x00ff61, 50],
      [0x02a7f6, 0x1e8],
      [0x02aca1, 64],
    ])
  })

  it('readL3SmashLoadPos gates on L3_SMASH_SITES by default (a stub-only cart is refused)', () => {
    const rom = smashRom()
    rom.writeAt(0x05d750, [0x10])
    rom.writeAt(0x05f600 + 0x1f, [0])
    const r = readL3SmashLoadPos(rom, 0x1f, { sprites: () => [spr(0x89, 288, 0)] })
    expect(r).toEqual({ ok: false, reason: SMASH_REFUSED })
  })
})

describe('readSmashCodeGate (synthetic code)', () => {
  it('passes the chain it was built from and refuses each planted change', () => {
    expect(readSmashCodeGate(smashRom(), sites)).toBe(true)
    const plants: [string, number][] = [
      ['the main pointer entry', MAIN_TABLE],
      ['the init pointer entry', INIT_TABLE],
      ['the init body (not a bare RTS)', INIT],
      ['the stub PHB', STUB],
      ['the stub JSL', STUB + 5],
      ['the stub JSL bank', STUB + 8],
      ['the main routine opening JSL', MAIN],
      ['the position routine', SITE + 20],
      ['the sprite loader (a JML in it)', 0x02a7f6 + 30],
      ['the start-up sweep', 0x02aca1 + 10],
    ]
    for (const [what, at] of plants) {
      const rom = smashRom()
      rom.writeAt(at, [rom.readByte(at)! ^ 0x55])
      expect(readSmashCodeGate(rom, sites), what).toBe(false)
    }
  })
})

describe('readL3SmashLoadPos (synthetic cart)', () => {
  const LEVEL = 0x1f
  /** Mario's start X on `screen`: X index 0 = xLo in the tables, F600 low five bits = the screen. */
  const withStart = (rom: RomFile, screen: number, xLo = 0x10) => {
    rom.writeAt(0x05d750, [xLo])
    rom.writeAt(0x05f600 + LEVEL, [screen])
    return rom
  }
  const one = { sprites: () => [spr(0x89, 288, 0)], sites }

  it('gives the smasher position on a stock-shaped cart', () => {
    expect(readL3SmashLoadPos(withStart(smashRom(), 0), LEVEL, one)).toEqual({ ok: true, pos: { x: 256, y: 160 } }) // prettier-ignore
  })

  it('refuses when the position routine, the stub or the sweep is hooked (the gate is on the path)', () => {
    for (const at of [SITE + 20, STUB + 8, 0x02aca1 + 10]) {
      const rom = withStart(smashRom(), 0)
      rom.writeAt(at, [rom.readByte(at)! ^ 0xff])
      expect(readL3SmashLoadPos(rom, LEVEL, one), at.toString(16)).toMatchObject({ ok: false })
    }
  })

  it('refuses for a start on screen 2 (X $210), and at $80 but not $7F on screen 0', () => {
    expect(readL3SmashLoadPos(withStart(smashRom(), 2), LEVEL, one)).toMatchObject({ ok: false })
    expect(readL3SmashLoadPos(withStart(smashRom(), 0, 0x7f), LEVEL, one)).toMatchObject({
      ok: true,
    })
    expect(readL3SmashLoadPos(withStart(smashRom(), 0, 0x80), LEVEL, one)).toMatchObject({
      ok: false,
    })
  })

  it('refuses when Mario start or the sprite stream cannot be read, and a level without a smasher needs no gate', () => {
    const cut = new RomFile('cut.sfc', Buffer.alloc(0x20000, 0))
    expect(readL3SmashLoadPos(cut, LEVEL, one)).toMatchObject({ ok: false })
    expect(readL3SmashLoadPos(withStart(smashRom(), 0), LEVEL, { sites, sprites: () => null })).toEqual({ ok: false, reason: SPRITES_UNREADABLE }) // prettier-ignore
    const bare = withStart(new RomFile('z.sfc', Buffer.alloc(0x80000, 0)), 0)
    expect(readL3SmashLoadPos(bare, LEVEL, { sprites: () => [spr(0x33, 16, 0)] })).toEqual({ ok: true, pos: null }) // prettier-ignore
  })
})

describe('readLevelSprites (synthetic pointer site)', () => {
  /** CODE_05D8B7's shape (LevelTableGate.test.ts): index, mid, lead-in, fixed bank 9; level 3 stream at $09:8000. */
  const romWith = (stream: number[]) => {
    const rom = new RomFile('spr.sfc', Buffer.alloc(0x400000, 0))
    rom.writeAt(0x00ffd5, [0x20])
    const at = 0x05d000
    rom.writeAt(at - 9, [0xa5, 0x0e, 0x0a, 0xa8])
    rom.writeAt(at - 5, [0xa9, 0x00, 0x00, 0xe2, 0x20])
    rom.writeAt(at, [0xb9, 0x00, 0xec, 0x85, 0xce, 0xb9, 0x01, 0xec, 0x85, 0xcf])
    rom.writeAt(at + 10, [0xa9, 0x09, 0x85, 0xd0])
    rom.writeAt(0x05ec00 + 3 * 2, [0x00, 0x80])
    rom.writeAt(0x098000, stream)
    return rom
  }

  it('reads the level stream through its pointer and bank, and refuses one with no terminator in the read', () => {
    const ok = readLevelSprites(romWith([0, 0x00, 0x00, 0x89, 0xff]), 3)
    expect(ok?.map(s => s.spriteId)).toEqual([0x89])
    const endless = [0, ...Array.from({ length: 0x1ff }, (_, i) => [0x00, 0x00, 0x33][i % 3]!)]
    expect(readLevelSprites(romWith(endless), 3)).toBeNull()
    // $FF bytes sit off the 3-byte record grid in an unterminated stream: stepping by 1 would stop at one
    const offGrid = [0, ...Array.from({ length: 0x1ff }, (_, i) => [0x00, 0xff, 0x33][i % 3]!)]
    expect(readLevelSprites(romWith(offGrid), 3)).toBeNull()
    expect(readLevelSprites(new RomFile('none.sfc', Buffer.alloc(0x400000, 0)), 3)).toBeNull()
  })
})

describe.skipIf(!hasRom(VANILLA))(
  'vanilla maps with a smash sprite vs captured frame 0 (corpus)',
  () => {
    const rom = () => RomFile.load(romPath(VANILLA))

    it('$01F and $1D4 load layer 3 at the captured (256,160) and (112,160); $1FC (no capture) follows the same derivation', () => {
      const r = rom()
      const smw = new SmwRom(r)
      const verdictOf = (id: number) => {
        const header = parseLevelHeader(smw.getLevelRawData(id)!)
        return buildL3Verdict(r, id, { header, isVertical: false, colors: [] } as never, { ok: true, mode: 1 }) // prettier-ignore
      }
      expect(readL3SmashLoadPos(r, 0x1f)).toEqual({ ok: true, pos: { x: 256, y: 160 } })
      expect(readL3SmashLoadPos(r, 0x1d4)).toEqual({ ok: true, pos: { x: 112, y: 160 } })
      expect(readL3SmashLoadPos(r, 0x1fc)).toEqual({ ok: true, pos: { x: 256, y: 160 } })
      expect(verdictOf(0x1f).l3).toMatchObject({ xPx: 256, yPx: 160 })
      expect(verdictOf(0x1d4).l3).toMatchObject({ xPx: 112, yPx: 160 })
    })

    it('a one-byte patch in the position routine refuses instead of drawing at the stock place', () => {
      const r = rom()
      r.writeAt(0x00ff61 + 10, [r.readByte(0x00ff61 + 10)! ^ 0xff])
      expect(readL3SmashLoadPos(r, 0x1f)).toMatchObject({ ok: false })
    })
  },
)
