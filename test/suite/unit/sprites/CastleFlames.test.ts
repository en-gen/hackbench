/**
 * #894: the flames of sprite $E6 come from running the ROM's own spawn and draw
 * routines, never from a table in the editor. The synthetic block (no ROM, so CI
 * runs it) hand-assembles both routines from SMWDisX (bank_02.asm:5582-5598 and
 * 16230-16280) into the synthetic cart with NON-vanilla data AND non-vanilla bytes
 * (the spawn's statements are reordered, so its SHA-256 is not the vanilla one: a
 * guard test below proves it), so a hardcoded vanilla X, tile or attribute goes red
 * and no ROM routine is committed. The corpus block runs the real ROM.
 *
 * Owner ruling D52 (option B): a changed routine or call-path part does not blank the
 * flames; the result is `unverified` and says what differs. Every check below has a
 * planted fixture that goes red when the check is deleted.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { spanFingerprint } from '../../../../src/rom/SubmapFlagGate'
import {
  castleFlames,
  castleFlamesOf,
  VANILLA_FLAME_ROUTINES,
  type FlameRoutines,
} from '../../../../src/rom/sprites/interp/CastleFlames'
import { bytesAt } from '../../../../src/rom/sprites/interp/Guards'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { castleFlameSprites } from '../../../../theia/extension/src/node/map-sprites'
import { COLORS } from '../../support/mapInputs'
import { hasRom, romPath, VANILLA } from '../../support/corpus'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const LEVEL = 0x105
const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)

interface Data {
  xs: number[]
  tiles: number[]
  props: number[]
}
const DATA: Data = { xs: [0x20, 0x60, 0xa0, 0xe0], tiles: [0xc0, 0xc2, 0xc0, 0xc2], props: [0x0b, 0x0b, 0x4b, 0x4b] } // prettier-ignore

/**
 * CODE_02AA6C's effect (SMWDisX bank_02.asm:5582-5598), written in a DIFFERENT statement order from the
 * game's (Y, then X, then the number, then Misc), 33 bytes like the original; `xs` is DATA_02AA68.
 */
const spawn = [
  ...[0xa9, 0x07, 0x8d, 0xcb, 0x14], // LDA #7 / STA SpriteStatus+3
  ...[0xa2, 0x03], // LDX #3
  ...[0xa9, 0xf0, 0x9d, 0x02, 0x1e], // LDA #$F0 / STA ClusterSpriteYPosLow,X
  ...[0xbd, 0x68, 0xaa, 0x9d, 0x16, 0x1e], // LDA DATA_02AA68,X / STA ClusterSpriteXPosLow,X
  ...[0xa9, 0x05, 0x9d, 0x92, 0x18], // LDA #5 / STA ClusterSpriteNumber,X
  ...[0x8a, 0x0a, 0x0a, 0x9d, 0x4a, 0x0f], // TXA / ASL / ASL / STA ClusterSpriteMisc0F4A,X
  ...[0xca, 0x10, 0xe7, 0x60], // DEX / BPL - / RTS
]
const SPAWN_TYPE_OPERAND = 19 // the `5` of LDA #5 above
/** CODE_02FA16's effect (bank_02.asm:16230-16279), Y stored before X and the attribute before the tile (the game's order is the other way), 110 bytes like the original. */
const draw = [
  ...[0xa5, 0x9d, 0xd0, 0x11], // LDA SpriteLock / BNE +
  ...[0x22, 0xf9, 0xac, 0x01, 0x29, 0x07, 0xa8], // JSL GetRand / AND #7 / TAY
  ...[0xa5, 0x13, 0x39, 0x02, 0xfa, 0xd0, 0x03, 0xfe, 0x4a, 0x0f], // TrueFrame AND table / INC Misc
  ...[0xbc, 0x0a, 0xfa], // + LDY DATA_02FA0A,X
  ...[0xbd, 0x02, 0x1e, 0x38, 0xe5, 0x20, 0x99, 0x01, 0x03], // Y - Layer2YPos -> OAM Y
  ...[0xbd, 0x16, 0x1e, 0x38, 0xe5, 0x1e, 0x99, 0x00, 0x03], // X - Layer2XPos -> OAM X
  ...[0x5a, 0xda, 0xbd, 0x4a, 0x0f, 0x29, 0x03, 0xaa], // PHY PHX / Misc & 3 -> X
  ...[0xbd, 0x12, 0xfa, 0x99, 0x03, 0x03, 0xbd, 0x0e, 0xfa, 0x99, 0x02, 0x03], // attribute, then tile
  ...[0xfa, 0x98, 0x4a, 0x4a, 0xa8, 0xa9, 0x02, 0x99, 0x60, 0x04, 0x7a], // PLX / size = 2 / PLY
  ...[0xb9, 0x00, 0x03, 0xc9, 0xf0, 0x90, 0x1d], // X >= $F0: overflow copy
  ...[0xb9, 0x00, 0x03, 0x8d, 0xec, 0x03, 0xb9, 0x01, 0x03, 0x8d, 0xed, 0x03],
  ...[0xb9, 0x02, 0x03, 0x8d, 0xee, 0x03, 0xb9, 0x03, 0x03, 0x8d, 0xef, 0x03],
  ...[0xa9, 0x03, 0x8d, 0x9b, 0x04, 0x60],
]

/** The call path to the draw, hand-written with the vanilla shape (see PATH in CastleFlames.ts); operands that do not matter are made up. */
// prettier-ignore
const PATH_BYTES: [number, number[]][] = [
  [0x02a8c0, [0xc9, 0xe1, 0x90, 0x0c, 0xda, 0x5a, 0x88, 0x84, 0x03, 0x20, 0xc0, 0xaa]], // loader route
  [0x02aac0, [0xa0, 0x01, 0x8c, 0x34, 0x12, 0xc9, 0xe4, 0xf0, 0x7f]], // spawn entry
  [0x02aac9, [0xc9, 0xe6, 0xf0, 0x9f]], // $E6 branch
  [0x02f808, [0x8b, 0x4b, 0xab, 0x20, 0x10, 0xf8, 0xab, 0x6b, 0xa2, 0x13, 0x8e, 0x77, 0x15, 0xbd, 0x92, 0x18, 0xf0, 0x03, 0x20, 0x21, 0xf8, 0xca, 0x10, 0xf2]], // cluster loop
  [0x02f821, [0x22, 0xfa, 0x86, 0x00]], // JSL ExecutePtr (the synthetic cart's, $00:86FA)
  [0x02f82f, [0x16, 0xfa]], // type 5 entry
]

function flameRom(
  d: Data = DATA,
  tweak: (bytes: Uint8Array) => void = () => {},
  cart: SyntheticOptions = {},
) {
  const bytes = new Uint8Array(buildSyntheticRom(cart).buffer)
  const put = (snes: number, b: number[]) => {
    expect(bytes.subarray(off(snes), off(snes) + b.length).every(v => v === 0)).toBe(true)
    bytes.set(b, off(snes))
  }
  put(0x02aa6c, spawn)
  put(0x02aa68, d.xs)
  put(0x02fa16, draw)
  put(0x02fa02, [0x03, 0x07, 0x07, 0x07, 0x0f, 0x07, 0x07, 0x0f, 0xf0, 0xf4, 0xf8, 0xfc, ...d.tiles, ...d.props]) // prettier-ignore
  for (const [at, b] of PATH_BYTES) put(at, b)
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

/** The `unverified` list of a run that must have drawn (a refusal throws). */
const unverifiedOf = (rom: RomFile, routines: FlameRoutines = routinesOf(rom)) => {
  const r = castleFlames(rom, levelSeed(rom, LEVEL), routines)
  if (!r.ok) throw new Error(r.reason)
  return r.unverified
}

describe('castle flames from the routines (synthetic cart)', () => {
  it('the hand-assembled routines are the lengths the guard hashes, and are not the vanilla bytes', () => {
    expect([spawn.length, draw.length]).toEqual([33, 110])
    // The cart carries no ROM routine: its own hashes differ from the vanilla ones.
    const mine = routinesOf(flameRom())
    expect(mine.spawn).not.toBe(VANILLA_FLAME_ROUTINES.spawn)
    expect(mine.draw).not.toBe(VANILLA_FLAME_ROUTINES.draw)
  })

  it("positions, tile and attribute are what the cart's own spawn and draw wrote (OAM 124-127, 16 x 16, Layer 2 at zero), verified", () => {
    // X = DATA_02AA68[slot] (slot 0 first), Y = $F0, tile = table[Misc & 3] with Misc = slot * 4 -> index 0.
    // Draw order is slot 0..3, OAM Y index $F0,$F4,$F8,$FC -> entries 124..127; attribute bit 0 is the name table.
    expect(key(flameRom())).toEqual([
      [124, 0x20, 0xf0, 0xc0 | (1 << 8), 0x0b, 16],
      [125, 0x60, 0xf0, 0xc0 | (1 << 8), 0x0b, 16],
      [126, 0xa0, 0xf0, 0xc0 | (1 << 8), 0x0b, 16],
      [127, 0xe0, 0xf0, 0xc0 | (1 << 8), 0x0b, 16],
    ])
    expect(unverifiedOf(flameRom())).toEqual([])
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

  it('a flame at X >= $F0 is also copied into OAM 123 (bank_02.asm:16266-16278), as the draw wrote it', () => {
    const rom = flameRom({ ...DATA, xs: [0xf8, 0x60, 0xa0, 0xe0] })
    const got = key(rom)
    expect(got.map(r => r[0])).toEqual([123, 124, 125, 126, 127])
    // Entry 123 is the copy: X $F8 with the size byte's bit 8 set (9-bit X $1F8), same tile and attribute.
    expect(got[0]).toEqual([123, 0x1f8, 0xf0, 0xc0 | (1 << 8), 0x0b, 16])
    expect(got[1]![1]).toBe(0xf8)
  })

  it.each([
    ['spawn', 0x02aa6c + 3, 'the flame spawn routine'],
    ['draw', 0x02fa16 + draw.length - 5, 'the flame draw routine'],
  ])(
    'a byte changed inside the %s routine runs it anyway, unverified, naming it (ruling B)',
    (_, at, what) => {
      // The changed byte is harmless to the run (a RAM operand), so the flames are the base cart's.
      const dirty = flameRom(DATA, b => void (b[off(at)]! ^= 1))
      const r = castleFlames(dirty, levelSeed(dirty, LEVEL), routinesOf(flameRom()))
      if (!r.ok) throw new Error(r.reason)
      expect(r.unverified).toEqual([what])
      expect(r.parts.map(p => [p.oam, p.ox, p.oy, p.char])).toEqual(
        key(flameRom()).map(k => k.slice(0, 4)),
      )
    },
  )

  // Each call-path check goes red on its own when deleted: the one changed byte is the ONLY thing reported.
  it.each([
    ['the loader route to the sprite spawn', 0x02a8c0 + 3],
    ['the $E6 spawn entry', 0x02aac0 + 6],
    ['the $E6 branch to the flame spawn', 0x02aac9 + 1],
    ['the cluster loop', 0x02f808 + 23],
    ['the cluster dispatch call', 0x02f821],
    ['the cluster dispatch call target', 0x02f822],
    ['the cluster dispatch entry for type 5', 0x02f82f],
  ])('a hacked call path (%s) still draws, unverified, naming it', (what, at) => {
    const dirty = flameRom(DATA, b => void (b[off(at)]! ^= 1))
    expect(unverifiedOf(dirty)).toEqual([what])
    // Run as it stands: the flames are the base cart's, not blanked, not a vanilla table.
    expect(key(dirty)).toEqual(key(flameRom()))
  })

  describe('GetRand', () => {
    // A changed GetRand that the run never executes must not stop the flames: the draw's JSL is
    // behind SpriteLock (1 here), and the check refuses only on a fetch at GetRand's entry.
    it('a broken GetRand that the run never reaches does not refuse', () => {
      const rom = flameRom(DATA, () => {}, { badGetRand: true })
      expect(key(rom)).toEqual(key(flameRom()))
      expect(unverifiedOf(rom)).toEqual([])
    })

    // The draw's BNE over the GetRand step becomes NOPs, so GetRand IS called (a changed routine, unverified).
    const callsGetRand = (b: Uint8Array) => void b.fill(0xea, off(0x02fa16 + 2), off(0x02fa16 + 4))

    it('a broken GetRand that the run does reach refuses, naming it', () => {
      const rom = flameRom(DATA, callsGetRand, { badGetRand: true })
      const r = castleFlames(rom, levelSeed(rom, LEVEL), routinesOf(flameRom()))
      expect(r).toEqual({ ok: false, reason: 'GetRand is not the two-step shape this runner knows' }) // prettier-ignore
    })

    it('the known GetRand that the run reaches is run: drawn, unverified for the changed draw', () => {
      const rom = flameRom(DATA, callsGetRand)
      expect(unverifiedOf(rom, routinesOf(flameRom()))).toEqual(['the flame draw routine'])
    })
  })

  it('a hard failure is still a refusal with its reason, not an unverified draw', () => {
    // The draw starts with BRK: the core's guard stops the run.
    const rom = flameRom(DATA, b => void (b[off(0x02fa16)] = 0x00))
    const r = castleFlames(rom, levelSeed(rom, LEVEL), routinesOf(rom))
    expect(r).toEqual({ ok: false, reason: 'BRK executed at $02FA16' })
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

/** The 7 maps whose sprite lists hold $E6, over all 512 map numbers (vanilla USA ROM, one run). */
const FLAME_MAPS = [0x01f, 0x101, 0x10d, 0x1cd, 0x1d0, 0x1d4, 0x1fc] as const

describe.skipIf(!hasRom(VANILLA))('castle flames, vanilla ROM', () => {
  // A literal list of maps, not a corpus listing: it cannot register zero cases.
  it.each(FLAME_MAPS)(
    'map $%s: four verified 16 x 16 flames at X $10 $50 $90 $D0, Y $F0, tile $E2, attribute $09 (CGRAM row 12, priority 0)',
    level => {
      const r = castleFlamesOf(RomFile.load(romPath(VANILLA)), level)
      if (!r.ok) throw new Error(r.reason)
      expect(r.unverified).toEqual([])
      const got = r.parts.map(p => [p.ox, p.oy, p.char, p.attr, p.size, p.palette, p.priority])
      expect(got.sort((a, b) => a[0]! - b[0]!)).toEqual(
        [0x10, 0x50, 0x90, 0xd0].map(x => [x, 0xf0, 0x1e2, 0x09, 16, 12, 0]),
      )
    },
  )
})

describe('castle flames on the map (synthetic cart)', () => {
  const rom = flameRom()
  const stream = (id: number, raw0 = 0): LevelSprite[] =>
    [{ index: 0, x: 4, y: 4, spriteId: id, screen: 0, extraBit: false, raw: [raw0, 0, 0], streamOffset: 1 }] // prettier-ignore
  // Every OBJ char of SP4 solid, so any flame char is "loaded".
  const solid = Array.from({ length: 128 }, () => new Uint8Array(64).fill(3))
  const model = { vram: { sp4: solid }, colors: COLORS, isVertical: false, screenCount: 2 }
  /** `routines` default to the cart's own, so only a deliberate difference is unverified. */
  const draw = (
    sprites: LevelSprite[],
    dy: number | undefined,
    on = rom,
    m: object = {},
    routines = routinesOf(on),
  ) => castleFlameSprites(on, levelSeed(on, LEVEL), sprites, { ...model, ...m }, dy, undefined, routines) // prettier-ignore
  const boxes = (r: ReturnType<typeof draw>) => r.sprites.map(s => `${s.box.x0},${s.box.y0}`).sort()

  it('copies every 256 px across the map, dy below the Layer 2 position, from the routine positions', () => {
    // Map 512 x 432, dy 16: copies at Y -240 and 16 reach it (flame Y $F0 = rows 0..15 and 256..271).
    const want = [0x20, 0x60, 0xa0, 0xe0].flatMap(x => [0, 256].flatMap(k => [0, 256].map(y => `${x + k},${y}`))) // prettier-ignore
    const got = draw(stream(0xe6), 16)
    expect(boxes(got)).toEqual(want.sort())
    expect(got.sprites.every(s => s.fixedTo === 'layer2' && s.status === 'drawn' && s.id === 0xe6 && s.index < 0)).toBe(true) // prettier-ignore
    expect(got.note).toBeUndefined()
    expect(got.sprites.every(s => !s.unverified)).toBe(true)
  })

  it('a flame at X $F8 reaches into the next 256 px: its copy before the map starts at X -8 (the copy range starts at -256)', () => {
    const edge = flameRom({ ...DATA, xs: [0xf8, 0x60, 0xa0, 0xe0] })
    const got = boxes(draw(stream(0xe6), 16, edge))
    // The flame is 16 wide at 248..264; the copy one period earlier covers map pixels 0..7.
    expect(got).toContain('-8,0')
    expect(got).toContain('248,0')
    // The OAM 123 overflow copy (9-bit X $1F8) is a part of its own, one period on.
    expect(got).toContain('504,0')
  })

  it('moving Layer 2 moves the flames with it (dy 16 -> 48)', () => {
    expect(boxes(draw(stream(0xe6), 48))).toContain('32,32')
    expect(boxes(draw(stream(0xe6), 48))).not.toContain('32,0')
  })

  it('a stream without a plain $E6 has none; one with the extra-bits flag set is not run', () => {
    expect(draw(stream(0x10), 16)).toEqual({ sprites: [] })
    expect(draw(stream(0xe6, 0x08), 16)).toEqual({ sprites: [] })
  })

  // The map-level note is the only place the user learns why flames are missing or unverified.
  it('no known background position draws none and says why', () => {
    expect(draw(stream(0xe6), undefined)).toEqual({ sprites: [], note: 'The castle flames are not drawn: the background position is unknown.' }) // prettier-ignore
  })

  it('chars that are not loaded draw none and say so', () => {
    const empty = { vram: { sp4: [] } }
    expect(draw(stream(0xe6), 16, rom, empty)).toEqual({ sprites: [], note: 'The castle flames are not drawn: their chars are not loaded.' }) // prettier-ignore
  })

  it('routines that drew nothing draw none and say so', () => {
    // The spawn writes cluster type 6, which the draw loop does not run.
    const none = flameRom(DATA, b => void (b[off(0x02aa6c + SPAWN_TYPE_OPERAND)] = 6))
    expect(draw(stream(0xe6), 16, none)).toEqual({ sprites: [], note: 'The castle flames are not drawn: the routines drew nothing.' }) // prettier-ignore
  })

  it('a refused run draws none and carries the reason in the note, never silently', () => {
    const brk = flameRom(DATA, b => void (b[off(0x02fa16)] = 0x00))
    expect(draw(stream(0xe6), 16, brk)).toEqual({ sprites: [], note: 'The castle flames are not drawn: BRK executed at $02FA16.' }) // prettier-ignore
  })

  it('a changed routine still draws the flames, flagged unverified, and the note names what differs (ruling B)', () => {
    const changed = flameRom(DATA, b => void (b[off(0x02aa6c + 3)]! ^= 1))
    const r = draw(stream(0xe6), 16, changed, {}, routinesOf(rom))
    expect(r.sprites.length).toBe(16)
    expect(r.note).toBe("The castle flames are unverified: the flame spawn routine is not the vanilla shape; drawn from this ROM's own routines.") // prettier-ignore
    expect(r.sprites.every(s => s.unverified?.includes('the flame spawn routine is not the vanilla shape'))).toBe(true) // prettier-ignore
  })

  it('a hacked call path is flagged the same way', () => {
    const hacked = flameRom(DATA, b => void (b[off(0x02f82f)]! ^= 1))
    const r = draw(stream(0xe6), 16, hacked)
    expect(r.sprites.length).toBe(16)
    expect(r.note).toContain('the cluster dispatch entry for type 5 is not the vanilla shape')
  })
})
