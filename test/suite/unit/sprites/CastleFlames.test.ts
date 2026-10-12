/**
 * #894: the flames of sprite $E6 come from running the ROM's own spawn and draw
 * routines, never from a table in the editor. The synthetic block (no ROM, so CI
 * runs it) hand-assembles both routines from SMWDisX (bank_02.asm:5576-5592 and
 * 16230-16280) into the synthetic cart with NON-vanilla data, so a hardcoded
 * vanilla X, tile or attribute goes red. The corpus block runs the real ROM.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { spanFingerprint } from '../../../../src/rom/SubmapFlagGate'
import {
  castleFlames,
  castleFlamesOf,
  type FlameRoutines,
} from '../../../../src/rom/sprites/interp/CastleFlames'
import { bytesAt } from '../../../../src/rom/sprites/interp/Guards'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { castleFlameSprites } from '../../../../theia/extension/src/node/map-sprites'
import { COLORS } from '../../support/mapInputs'
import { hasRom, romPath, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const LEVEL = 0x105
const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)

interface Data {
  xs: number[]
  tiles: number[]
  props: number[]
}
const DATA: Data = { xs: [0x20, 0x60, 0xa0, 0xe0], tiles: [0xc0, 0xc2, 0xc0, 0xc2], props: [0x0b, 0x0b, 0x4b, 0x4b] } // prettier-ignore

/** CODE_02AA6C as the disassembly reads (33 bytes); `xs` is DATA_02AA68. */
const spawn = [
  ...[0xa9, 0x07, 0x8d, 0xcb, 0x14], // LDA #7 / STA SpriteStatus+3
  ...[0xa2, 0x03], // LDX #3
  ...[0xa9, 0x05, 0x9d, 0x92, 0x18], // LDA #5 / STA ClusterSpriteNumber,X
  ...[0xbd, 0x68, 0xaa, 0x9d, 0x16, 0x1e], // LDA DATA_02AA68,X / STA ClusterSpriteXPosLow,X
  ...[0xa9, 0xf0, 0x9d, 0x02, 0x1e], // LDA #$F0 / STA ClusterSpriteYPosLow,X
  ...[0x8a, 0x0a, 0x0a, 0x9d, 0x4a, 0x0f], // TXA / ASL / ASL / STA ClusterSpriteMisc0F4A,X
  ...[0xca, 0x10, 0xe7, 0x60], // DEX / BPL - / RTS
]
/** CODE_02FA16 as the disassembly reads (110 bytes). */
const draw = [
  ...[0xa5, 0x9d, 0xd0, 0x11], // LDA SpriteLock / BNE +
  ...[0x22, 0xf9, 0xac, 0x01, 0x29, 0x07, 0xa8], // JSL GetRand / AND #7 / TAY
  ...[0xa5, 0x13, 0x39, 0x02, 0xfa, 0xd0, 0x03, 0xfe, 0x4a, 0x0f], // TrueFrame AND table / INC Misc
  ...[0xbc, 0x0a, 0xfa], // + LDY DATA_02FA0A,X
  ...[0xbd, 0x16, 0x1e, 0x38, 0xe5, 0x1e, 0x99, 0x00, 0x03], // X - Layer2XPos -> OAM X
  ...[0xbd, 0x02, 0x1e, 0x38, 0xe5, 0x20, 0x99, 0x01, 0x03], // Y - Layer2YPos -> OAM Y
  ...[0x5a, 0xda, 0xbd, 0x4a, 0x0f, 0x29, 0x03, 0xaa], // PHY PHX / Misc & 3 -> X
  ...[0xbd, 0x0e, 0xfa, 0x99, 0x02, 0x03, 0xbd, 0x12, 0xfa, 0x99, 0x03, 0x03], // tile, attribute
  ...[0xfa, 0x98, 0x4a, 0x4a, 0xa8, 0xa9, 0x02, 0x99, 0x60, 0x04, 0x7a], // PLX / size = 2 / PLY
  ...[0xb9, 0x00, 0x03, 0xc9, 0xf0, 0x90, 0x1d], // X >= $F0: overflow copy
  ...[0xb9, 0x00, 0x03, 0x8d, 0xec, 0x03, 0xb9, 0x01, 0x03, 0x8d, 0xed, 0x03],
  ...[0xb9, 0x02, 0x03, 0x8d, 0xee, 0x03, 0xb9, 0x03, 0x03, 0x8d, 0xef, 0x03],
  ...[0xa9, 0x03, 0x8d, 0x7b, 0x04, 0x60],
]

function flameRom(d: Data = DATA, tweak: (bytes: Uint8Array) => void = () => {}) {
  const bytes = new Uint8Array(buildSyntheticRom().buffer)
  const put = (snes: number, b: number[]) => {
    expect(bytes.subarray(off(snes), off(snes) + b.length).every(v => v === 0)).toBe(true)
    bytes.set(b, off(snes))
  }
  put(0x02aa6c, spawn)
  put(0x02aa68, d.xs)
  put(0x02fa16, draw)
  put(0x02fa02, [0x03, 0x07, 0x07, 0x07, 0x0f, 0x07, 0x07, 0x0f, 0xf0, 0xf4, 0xf8, 0xfc, ...d.tiles, ...d.props]) // prettier-ignore
  put(0x02aac9, [0xc9, 0xe6, 0xf0, 0x9f])
  put(0x02f82f, [0x16, 0xfa])
  tweak(bytes)
  return RomFile.fromBytes('flames.sfc', bytes)
}

/** The fingerprints of this cart's own routines (the vanilla ones are for the vanilla bytes). */
const routinesOf = (rom: RomFile): FlameRoutines => {
  const sha = (at: number, n: number) => spanFingerprint(Uint8Array.from(bytesAt(rom, at, n)!))!
  return { spawn: sha(0x02aa6c, 33), draw: sha(0x02fa16, 110) }
}

const run = (rom: RomFile) => castleFlames(rom, levelSeed(rom, LEVEL), routinesOf(rom))
const key = (rom: RomFile) => {
  const r = run(rom)
  if (!r.ok) throw new Error(r.reason)
  return r.parts.map(p => [p.oam, p.ox, p.oy, p.char, p.attr, p.size])
}

describe('castle flames from the routines (synthetic cart)', () => {
  it('the hand-assembled routines are the lengths the guard hashes', () => {
    expect([spawn.length, draw.length]).toEqual([33, 110])
  })

  it("positions, tile and attribute are what the cart's own spawn and draw wrote (OAM 124-127, 16 x 16, Layer 2 at zero)", () => {
    // X = DATA_02AA68[slot] (slot 0 first), Y = $F0, tile = table[Misc & 3] with Misc = slot * 4 -> index 0.
    // Draw order is slot 0..3, OAM Y index $F0,$F4,$F8,$FC -> entries 124..127; attribute bit 0 is the name table.
    expect(key(flameRom())).toEqual([
      [124, 0x20, 0xf0, 0xc0 | (1 << 8), 0x0b, 16],
      [125, 0x60, 0xf0, 0xc0 | (1 << 8), 0x0b, 16],
      [126, 0xa0, 0xf0, 0xc0 | (1 << 8), 0x0b, 16],
      [127, 0xe0, 0xf0, 0xc0 | (1 << 8), 0x0b, 16],
    ])
  })

  it.each([
    ['a wrong spawn X', { ...DATA, xs: [0x20, 0x61, 0xa0, 0xe0] }, 1, 1, 0x61],
    ['a wrong tile', { ...DATA, tiles: [0xc4, 0xc2, 0xc0, 0xc2] }, 0, 3, 0xc4 | (1 << 8)],
    ['a wrong attribute', { ...DATA, props: [0x4b, 0x4b, 0x4b, 0x4b] }, 1, 4, 0x4b],
  ])(
    'planted defect: %s in the cart changes the result (nothing is hardcoded)',
    (_, d, row, col, want) => {
      const got = key(flameRom(d))
      expect(got[row]![col]).toBe(want)
      expect(got).not.toEqual(key(flameRom()))
    },
  )

  it.each([
    ['spawn', 0x02aa6c + 3, 'the flame spawn routine'],
    ['draw', 0x02fa16 + 40, 'the flame draw routine'],
  ])('a byte changed inside the %s routine refuses the run, naming it', (_, at, what) => {
    const dirty = flameRom(DATA, b => void (b[off(at)]! ^= 1))
    const r = castleFlames(dirty, levelSeed(dirty, LEVEL), routinesOf(flameRom()))
    expect(r).toEqual({
      ok: false,
      reason: `${what} is not the vanilla shape; the flames are not drawn`,
    })
  })

  it('a level the loader refused has no flames, and says why', () => {
    const rom = flameRom()
    const seed = levelSeed(rom, LEVEL)
    const r = castleFlames(
      rom,
      { ...seed, loaded: undefined, loadRefusal: 'because' },
      routinesOf(rom),
    )
    expect(r).toEqual({ ok: false, reason: 'because' })
  })
})

describe.skipIf(!hasRom(VANILLA))('castle flames, vanilla ROM', () => {
  it('map $01F: four 16 x 16 flames at X $10 $50 $90 $D0, Y $F0, tile $E2, attribute $09 (CGRAM row 12, priority 0)', () => {
    const r = castleFlamesOf(RomFile.load(romPath(VANILLA)), 0x01f)
    if (!r.ok) throw new Error(r.reason)
    const got = r.parts.map(p => [p.ox, p.oy, p.char, p.attr, p.size, p.palette, p.priority])
    expect(got.sort((a, b) => a[0]! - b[0]!)).toEqual(
      [0x10, 0x50, 0x90, 0xd0].map(x => [x, 0xf0, 0x1e2, 0x09, 16, 12, 0]),
    )
  })
})

describe('castle flames on the map (synthetic cart)', () => {
  const rom = flameRom()
  const seed = levelSeed(rom, LEVEL)
  const stream = (id: number, raw0 = 0): LevelSprite[] =>
    [{ index: 0, x: 4, y: 4, spriteId: id, screen: 0, extraBit: false, raw: [raw0, 0, 0], streamOffset: 1 }] // prettier-ignore
  // Every OBJ char of SP4 solid, so any flame char is "loaded".
  const solid = Array.from({ length: 128 }, () => new Uint8Array(64).fill(3))
  const model = { vram: { sp4: solid }, colors: COLORS, isVertical: false, screenCount: 2 }
  const draw = (sprites: LevelSprite[], dy: number | undefined) =>
    castleFlameSprites(rom, seed, sprites, model, dy, undefined, routinesOf(rom))
  const boxes = (r: ReturnType<typeof draw>) => r.sprites.map(s => `${s.box.x0},${s.box.y0}`).sort()

  it('copies every 256 px across the map, dy below the Layer 2 position, from the routine positions', () => {
    // Map 512 x 432, dy 16: copies at Y -240 and 16 reach it (flame Y $F0 = rows 0..15 and 256..271).
    const want = [0x20, 0x60, 0xa0, 0xe0].flatMap(x => [0, 256].flatMap(k => [0, 256].map(y => `${x + k},${y}`))) // prettier-ignore
    const got = draw(stream(0xe6), 16)
    expect(boxes(got)).toEqual(want.sort())
    expect(got.sprites.every(s => s.fixedTo === 'layer2' && s.status === 'drawn' && s.id === 0xe6 && s.index < 0)).toBe(true) // prettier-ignore
  })

  it('moving Layer 2 moves the flames with it (dy 16 -> 48)', () => {
    expect(boxes(draw(stream(0xe6), 48))).toContain('32,32')
    expect(boxes(draw(stream(0xe6), 48))).not.toContain('32,0')
  })

  it('a stream without a plain $E6 has none; one with the extra-bits flag set is not run', () => {
    expect(draw(stream(0x10), 16)).toEqual({ sprites: [] })
    expect(draw(stream(0xe6, 0x08), 16)).toEqual({ sprites: [] })
  })

  it('no known background position draws none and says why', () => {
    expect(draw(stream(0xe6), undefined)).toEqual({ sprites: [], note: 'The castle flames are not drawn: the background position is unknown.' }) // prettier-ignore
  })
})
