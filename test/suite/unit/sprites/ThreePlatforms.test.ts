/**
 * The three-platform command (the $E0 issue): the ROM's own spawner run on the core, each $A3 drawn by the sprite
 * runner after its INIT. Synthetic cart (syntheticPlatforms.ts): its spawner, tables and $A3 are our own bytes with the
 * game's I/O contract, so what is asserted is that the count, angles, position and link come from the cart's code and
 * data, and that every gate and refusal is told. The vanilla ROM is in ThreePlatforms.corpus.test.ts.
 */
import { describe, expect, it } from 'vitest'
import type { RomFile } from '../../../../src/rom/RomFile'
import { bytesAt } from '../../../../src/rom/sprites/interp/Guards'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import {
  LOAD_3_PLATFORMS,
  spawnerEntry,
  VANILLA_PLATFORM_ROUTINES,
  platformsGate,
  threePlatforms,
  type PlatformEntry,
} from '../../../../src/rom/sprites/interp/ThreePlatforms'
import { spanFingerprint } from '../../../../src/rom/SubmapFlagGate'
import { flip } from '../../support/syntheticRom'
import { eeriesSeed } from '../../support/syntheticEeries'
import {
  ANGLES,
  platformCart,
  SYNTHETIC_PLATFORM_ROUTINES as SYN,
} from '../../support/syntheticPlatforms'

/** Where the cart's spawner holds its count (CMP #3). */
const COUNT_AT = 80
const seed = eeriesSeed(100, { camera: { x: 800, y: 224 }, mario: { x: 100, y: 0 } })
/** The fixture's entry: X 944, list index 9, data byte $51 (Y $150 = 336). */
const entry: PlatformEntry = { x: 944, y: 336, index: 9, streamOffset: 0 }

/** The result of a drawing run, failing the test with the reason when it refused. */
function drawn(rom: RomFile, e: PlatformEntry = entry) {
  const r = threePlatforms(rom, seed, e, SYN)
  if (!r.ok) throw new Error(r.reason)
  return r
}

describe('the three platforms', () => {
  it('spawns three: one piece each, the cart angles after INIT, at the entry', () => {
    const r = drawn(platformCart())
    // The piece's tile is the angle with INIT's bit 7; it sits at the entry X plus angle & $70.
    expect(r.parts.map(p => p.char)).toEqual(ANGLES.map(a => a | 0x80))
    expect(r.parts.map(p => p.dx)).toEqual([0x10, 0x20, 0x30])
    expect(new Set(r.parts.map(p => p.dy))).toEqual(new Set([0]))
    expect(r.spawned).toBe(3)
    expect([r.unverified, r.notes]).toEqual([[], []])
  })

  it('takes Y from the data byte: $A1 is Y 416', () => {
    const rom = platformCart({ stream: [0xa1, 0xb3, 0xe0, 0xff] })
    const r = drawn(rom)
    expect(new Set(r.parts.map(p => p.dy))).toEqual(new Set([416 - 336]))
  })

  it('links only the first spawn to the list index', () => {
    const linked: number[] = []
    const run: typeof runOnce = (rom, id, s, o) =>
      runOnce(rom, id, s, {
        ...o,
        probe: (pass, w) => {
          if (pass !== -1) return
          const slot = Array.from({ length: 12 }, (_, i) => i).find(i => w[0x14c8 + i])!
          linked.push(w[0x161a + slot]!)
        },
      })
    threePlatforms(platformCart(), seed, entry, SYN, 1, run)
    expect(linked).toEqual([0, 0, 9])
  })

  it('draws what spawns and says nothing is hidden: room for two draws two', () => {
    const r = drawn(platformCart({ room: 2 }))
    expect(r.spawned).toBe(2)
    expect(r.parts).toHaveLength(2)
  })

  it('says so when a platform spawned and did not draw: one of three, singular, spawned still 3', () => {
    // The second spawn's angle is $22, $A2 after INIT; the cart's MAIN returns early for it.
    const r = drawn(platformCart({ skipDraw: 0x22 | 0x80 }))
    expect(r.spawned).toBe(3)
    expect(r.parts.map(p => p.char)).toEqual([0x11 | 0x80, 0x33 | 0x80])
    expect(r.notes).toHaveLength(1)
    expect(r.notes[0]).toMatch(/^1 platform did not draw: /)
  })

  it('reports none when no slot is free', () => {
    const r = threePlatforms(platformCart({ room: 0 }), seed, entry, SYN)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.none).toBe(true)
  })

  it('refuses with the reason when the spawner never returns', () => {
    const rom = platformCart()
    rom.writeAt(LOAD_3_PLATFORMS, [0x4c, 0x33, 0xaf]) // JMP to itself
    const r = threePlatforms(rom, seed, entry, SYN)
    expect(!r.ok && r.reason).toMatch(/step budget/)
  })

  it('a planted wrong count shows: a spawner that makes two draws two and is named', () => {
    const rom = platformCart()
    rom.writeAt(LOAD_3_PLATFORMS + COUNT_AT, [0x02]) // the count's immediate, 3 -> 2
    const r = drawn(rom)
    expect(r.parts).toHaveLength(2)
    expect(r.unverified).toEqual(['the platform spawner'])
  })
})

describe('spawn-frame positions, no travel (D137)', () => {
  // The cart's $A3 MAIN moves its angle by one before drawing unless SpriteLock is set, as the game's does. Drawn at
  // the spawn frame the pieces are the cart's spawn angles with INIT's bit 7, at the entry X plus angle & $70.
  const spawnFrame = (r: ReturnType<typeof drawn>) => {
    expect(r.parts.map(p => p.char)).toEqual(ANGLES.map(a => a | 0x80))
    expect(r.parts.map(p => p.dx)).toEqual([0x10, 0x20, 0x30])
  }

  it('draws each child at its spawn-frame offset though its MAIN would move it', () => {
    spawnFrame(drawn(platformCart({ travel: true })))
  })

  it('goes red on a planted travel frame: the same cart drawn with the sprites unlocked', () => {
    const unlocked: typeof runOnce = (rom, id, s, o) => runOnce(rom, id, { ...s, ram: { ...s.ram, 0x9d: 0 } }, o) // prettier-ignore
    const r = threePlatforms(platformCart({ travel: true }), seed, entry, SYN, 1, unlocked)
    if (!r.ok) throw new Error(r.reason)
    expect(() => spawnFrame(r)).toThrow()
    expect(r.parts.map(p => p.char)).toEqual(ANGLES.map(a => (a | 0x80) + 1))
  })
})

describe('the spawner the loader calls', () => {
  it('is the JSR operand at $02:A8A5: a repointed one runs the spawner it names, and says so', () => {
    const rom = platformCart()
    const code = bytesAt(rom, LOAD_3_PLATFORMS, 84)!
    code[COUNT_AT] = 0x02
    rom.writeAt(0x02b100, code)
    rom.writeAt(0x02a8a6, [0x00, 0xb1])
    const r = drawn(rom)
    expect(r.parts).toHaveLength(2) // the copy counts 2
    // The JSR operand is the call's target, not part of the route's shape: only the spawner it reaches is told.
    expect(r.unverified).toEqual(['the platform spawner'])
  })

  it('refuses in plain words, naming the route, when the loader no longer has a JSR there (no vanilla fallback)', () => {
    const rom = platformCart()
    rom.writeAt(0x02a8a5, [0x4c])
    const r = threePlatforms(rom, seed, entry, SYN)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/no longer calls a spawner for the three platforms/)
    expect(r.unverified).toEqual(['the loader route to the platform spawner'])
    expect(spawnerEntry(rom)).toBeNull()
  })
})

describe('the cart is its own code, not the vanilla routines', () => {
  // Hashes only: no ROM bytes are stored, so the claim is that neither synthetic routine fingerprints as the vanilla one.
  it('fingerprints differently from the vanilla spawner', () => {
    expect(SYN.spawner).not.toBe(VANILLA_PLATFORM_ROUTINES.spawner)
    const rom = platformCart()
    const cart = (at: number, n: number) => spanFingerprint(Uint8Array.from(bytesAt(rom, at, n)!))
    expect(cart(LOAD_3_PLATFORMS, 84)).toBe(SYN.spawner)
    expect(cart(LOAD_3_PLATFORMS, 84)).not.toBe(VANILLA_PLATFORM_ROUTINES.spawner)
  })

  it('is told apart from the vanilla gate: the vanilla spawner fingerprint names the cart spawner, the route is intact', () => {
    expect(platformsGate(platformCart())).toEqual(['the platform spawner'])
  })
})

describe('the gate', () => {
  it('is quiet for the cart it was fingerprinted on', () => {
    expect(platformsGate(platformCart(), SYN)).toEqual([])
  })

  it('names the spawner for a change to any of its 84 bytes', () => {
    for (let i = 0; i < 84; i++) {
      const rom = platformCart()
      flip(rom, LOAD_3_PLATFORMS + i)
      expect(platformsGate(rom, SYN), `byte ${i}`).toContain('the platform spawner')
    }
  })

  // The route is checked by structure (12 bytes are under the 24-unknown-byte fingerprint minimum): each value it
  // rests on is planted in turn. Not checked, by design: the BNE offset (+3) and the PHY / PHX pair (+4, +5).
  it.each([
    ['the compare opcode', 0],
    ['the compare immediate ($E0)', 1],
    ['the BNE opcode', 2],
    ['the DEY opcode', 6],
    ['the store of the data offset (STY)', 7],
    ['its direct page operand ($03)', 8],
    ['the JSR', 9],
  ])('names the loader route when %s changes', (_what, at) => {
    const route = platformCart()
    flip(route, 0x02a89c + at)
    expect(platformsGate(route, SYN)).toEqual(['the loader route to the platform spawner'])
  })

  it('names the loader route, and not the tables', () => {
    const route = platformCart()
    flip(route, 0x02a89c + 1)
    expect(platformsGate(route, SYN)).toEqual(['the loader route to the platform spawner'])
    const table = platformCart()
    flip(table, 0x02af2d)
    expect(platformsGate(table, SYN)).toEqual([])
  })
})
