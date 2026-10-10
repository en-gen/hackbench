/**
 * Layer 3's load position under a Layer 3 Smash sprite (#807). Synthetic sprite lists and code
 * bytes built here; the corpus block checks the two vanilla maps against the captured frame 0.
 */
import { createHash } from 'crypto'
import { describe, it, expect } from 'vitest'
import {
  SMASH_SPRITE_ID,
  l3SmashPos,
  readL3SmashLoadPos,
  readSmashCodeGate,
} from '../../../src/rom/L3Smash'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelHeader, type LevelSprite } from '../../../src/rom/LevelParser'
import { buildL3Verdict } from '../../../src/rom/model/L3Model'
import { VANILLA, hasRom, romPath } from '../support/corpus'

/** A sprite at pixel (x, y); the parser keeps 16 px units. */
const spr = (spriteId: number, x: number, y: number): LevelSprite => ({ spriteId, x: x / 16, y: y / 16, screen: x >> 8, extraBit: false, raw: [], index: 0, streamOffset: 0 }) // prettier-ignore
const SMASH = SMASH_SPRITE_ID

describe('l3SmashPos (synthetic sprite lists)', () => {
  it('X is the sprite X inside $00-$FF and $100 beyond it; Y is $A0 minus the sprite Y', () => {
    const at = (x: number, y: number) => l3SmashPos([spr(SMASH, x, y)], 16)
    expect(at(112, 0)).toEqual({ ok: true, pos: { x: 112, y: 160 } })
    expect(at(288, 0)).toEqual({ ok: true, pos: { x: 256, y: 160 } })
    expect(at(255, 0x30)).toEqual({ ok: true, pos: { x: 255, y: 0x70 } })
    expect(at(256, 0)).toMatchObject({ pos: { x: 256 } })
  })

  it('no smasher, or one past the start-up load window ($190), leaves layer 3 where CODE_00A007 put it', () => {
    expect(l3SmashPos([spr(0x33, 112, 0)], 16)).toEqual({ ok: true, pos: null })
    expect(l3SmashPos([spr(SMASH, 0x190, 0)], 16)).toMatchObject({ pos: { x: 0x100 } })
    expect(l3SmashPos([spr(SMASH, 0x191, 0)], 16)).toEqual({ ok: true, pos: null })
  })

  it('refuses, with a reason, two loaded smashers and a start where camera X is not known to be 0', () => {
    expect(l3SmashPos([spr(SMASH, 16, 0), spr(SMASH, 32, 0)], 16)).toMatchObject({ ok: false })
    expect(l3SmashPos([spr(SMASH, 16, 0)], 0x80)).toMatchObject({ ok: false })
    expect(l3SmashPos([spr(SMASH, 16, 0)], 0x7f)).toMatchObject({ ok: true })
  })
})

describe('readSmashCodeGate (synthetic code)', () => {
  const MAIN = 0x02d3ea
  const STUB = 0x01883d
  const SITE = 0x00ff61
  const body = Array.from({ length: 50 }, (_, i) => (i * 7 + 3) & 0xff)
  const romOf = () => {
    const rom = new RomFile('smash.sfc', Buffer.alloc(0x80000, 0))
    rom.writeAt(0x00ffd5, [0x20])
    rom.writeAt(0x0185cc + SMASH * 2, [STUB & 0xff, (STUB >> 8) & 0xff])
    rom.writeAt(STUB, [0x8b, 0xa9, 0x02, 0x48, 0xab, 0x22, MAIN & 0xff, (MAIN >> 8) & 0xff, 0x02])
    rom.writeAt(MAIN, [0x22, SITE & 0xff, SITE >> 8, 0x00])
    rom.writeAt(SITE, body)
    return rom
  }
  const site = { addr: SITE, length: 50, sha256: createHash('sha256').update(Buffer.from(body)).digest('hex') } // prettier-ignore

  it('passes the chain it was built from and refuses each planted change', () => {
    expect(readSmashCodeGate(romOf(), site)).toBe(true)
    for (const [what, at] of [
      ['the pointer table entry', 0x0185cc + SMASH * 2],
      ['the stub JSL', STUB + 5],
      ['the main routine opening JSL', MAIN],
      ['the position routine', SITE + 20],
    ] as const) {
      const rom = romOf()
      rom.writeAt(at, [rom.readByte(at)! ^ 0x55])
      expect(readSmashCodeGate(rom, site), what).toBe(false)
    }
  })
})

describe('readL3SmashLoadPos refuses on a ROM that has no sprite pointer site', () => {
  it('says why, rather than answering', () => {
    const rom = new RomFile('none.sfc', Buffer.alloc(0x80000, 0))
    expect(readL3SmashLoadPos(rom, 0x1f)).toMatchObject({ ok: false })
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
