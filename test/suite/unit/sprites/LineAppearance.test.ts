/**
 * D156: a line-guided sprite at rest is drawn where the game first draws it ON ITS LINE (the line step's lock,
 * SpriteTableC2 = 1, with its lock timer SpriteMisc1540 run out), and one that starts behind the scroll in every spawn
 * the loader allows is not moved ("never appears in play"). The rule's functions are synthetic; the covered sprites
 * are the vanilla ROM (Mesen 2 on vanilla US, one machine, one run per map, 2026-10-29).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import {
  interpDrawer,
  modelResult,
  readStream,
} from '../../../../theia/extension/src/node/map-sprites'
import { spriteProps } from '../../../../theia/extension/src/browser/sprite-props'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import {
  appears,
  loaderWindow,
  neverAppears,
  onLinePass,
} from '../../../../src/rom/sprites/interp/LineAppearance'
import { runOnce, type SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { hasRom, romPath, VANILLA } from '../../support/corpus'

const st = (lock: number, timer: number) => ({ lock, timer })

describe('onLinePass: the first pass the line step has locked and its timer has run out', () => {
  it('a sprite that locks on pass 0 but walks on pass 1 is on its line after pass 1', () => {
    expect(onLinePass([st(1, 1), st(1, 0), st(1, 0)])).toBe(1)
  })
  it('a sprite that falls (lock 2) and locks on pass N is on its line after pass N', () => {
    expect(onLinePass([st(2, 16), st(2, 15), st(2, 0), st(1, 0)])).toBe(3)
  })
  it('a sprite already locked with its timer out is on its line after pass 0', () => {
    expect(onLinePass([st(1, 0), st(1, 0)])).toBe(0)
  })
  it('a sprite that never locks has no line pass', () => {
    expect(onLinePass([st(0, 2), st(2, 1), st(2, 0)])).toBeUndefined()
    expect(onLinePass([])).toBeUndefined()
  })
})

describe('appears / neverAppears: by the side of the scroll the sprite starts on', () => {
  const left = { lo: -48, hi: -24 }
  const right = { lo: 270, hi: 300 }
  it('scrolling right, a sprite entirely left of the screen is behind the scroll; one right of it is ahead', () => {
    expect(appears({ dir: 1, extent: left }, 256)).toBe(false)
    expect(appears({ dir: 1, extent: right }, 256)).toBe(true)
  })
  it('scrolling left it is the other way round', () => {
    expect(appears({ dir: -1, extent: right }, 256)).toBe(false)
    expect(appears({ dir: -1, extent: left }, 256)).toBe(true)
  })
  it('a sprite the run drew nothing for (erased before it drew) does not appear there', () => {
    expect(appears({ dir: -1, extent: null }, 256)).toBe(false)
  })
  it('at map load (no scroll) it appears when any of it is on the screen', () => {
    expect(appears({ dir: 0, extent: { lo: 250, hi: 270 } }, 256)).toBe(true)
    expect(appears({ dir: 0, extent: left }, 256)).toBe(false)
  })
  it('never appears only when EVERY spawn says no, and needs at least one spawn', () => {
    expect(
      neverAppears(
        [
          { dir: 1, extent: left },
          { dir: -1, extent: null },
        ],
        256,
      ),
    ).toBe(true)
    expect(
      neverAppears(
        [
          { dir: 1, extent: left },
          { dir: 0, extent: { lo: 10, hi: 30 } },
        ],
        256,
      ),
    ).toBe(false)
    expect(neverAppears([], 256)).toBe(false)
  })
})

describe('loaderWindow: the loader offsets are read from the ROM, only when its routine is the stock one', () => {
  it('a cart whose loader is not the stock one gets no window', () => {
    expect(loaderWindow(RomFile.fromBytes('x.sfc', Buffer.alloc(0x100000)))).toBeNull()
  })
})

const CASES: {
  map: number
  at: number
  spot: [number, number] | 'never'
  tile: [number, number]
}[] = [
  { map: 0x00f, at: 32, spot: [3984, 319], tile: [3984, 304] },
  { map: 0x00f, at: 33, spot: [4080, 367], tile: [4080, 352] },
  { map: 0x00f, at: 37, spot: [4432, 383], tile: [4432, 368] },
  { map: 0x00f, at: 9, spot: 'never', tile: [1248, 288] },
  { map: 0x01a, at: 4, spot: [751, 367], tile: [720, 352] },
  { map: 0x01a, at: 5, spot: 'never', tile: [832, 352] },
  { map: 0x01a, at: 7, spot: 'never', tile: [1024, 352] },
  { map: 0x01a, at: 10, spot: 'never', tile: [1216, 352] },
  { map: 0x12c, at: 24, spot: [3295, 304], tile: [3280, 304] },
  { map: 0x12c, at: 29, spot: [3680, 367], tile: [3664, 288] },
  { map: 0x12c, at: 19, spot: [2944, 240], tile: [2944, 240] },
]

describe.skipIf(!hasRom(VANILLA))('the covered vanilla sprites at rest (D156)', () => {
  const rest = (map: number, at: number): SpriteModel => {
    const path = romPath(VANILLA)
    const bytes = new Uint8Array(readFileSync(path))
    const rom = new SmwRom(RomFile.fromBytes(path, Buffer.from(bytes)))
    const built = new L1ModelCache().get(bytes, path, map, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
    if (!built.ok) throw new Error(built.reason)
    const p = parseLevelSprites(
      readStream(rom.rom, rom.getLevelSpritePointer(map)!),
      built.inputs.isVertical,
    )[at]!
    let m: SpriteModel | undefined
    interpDrawer(
      rom.rom,
      map,
      built.inputs,
      (r, id, sd) => (m = runOnce(r, id, sd, { atRest: true })),
    )(p)
    return m!
  }
  it.each(CASES)(
    'map $map sprite list index $at',
    ({ map, at, spot, tile }) => {
      const m = rest(map, at)
      expect([m.anchor!.rawX, m.anchor!.rawY]).toEqual(tile)
      if (spot === 'never') {
        expect(m.neverAppears).toBe(true)
        expect([m.anchor!.x, m.anchor!.y]).toEqual(tile)
        expect(m.shifted).toBeUndefined()
      } else {
        expect(m.neverAppears).toBeUndefined()
        expect([m.anchor!.x, m.anchor!.y]).toEqual(spot)
      }
    },
    120_000,
  )

  it('the picture of a never-appears sprite has no stored tile and carries the plain words; Properties shows them', () => {
    const res = modelResult(rest(0x00f, 9))
    expect(res).toMatchObject({ ok: true, note: 'never appears in play' })
    expect(res).not.toHaveProperty('stored')
    expect(spriteProps({ status: 'drawn', id: 0x65, name: 'Chainsaw', x: 1248, y: 288, note: 'never appears in play', parts: [] } as never).notes).toContain('never appears in play') // prettier-ignore
  })

  it('the loader window is the stock one: scrolling right at +$120, left at -$30', () => {
    const path = romPath(VANILLA)
    expect(loaderWindow(RomFile.fromBytes(path, Buffer.from(readFileSync(path))))).toEqual({ right: 0x120, left: -0x30 }) // prettier-ignore
  })
})
