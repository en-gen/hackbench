/**
 * Lakitu's ($1E) facing does not depend on the cloud's slot once the cloud has run (#1007). InitLakitu spawns the
 * cloud in the highest free slot and never writes $157C (SMWDisX bank_01.asm:687-729); the cloud's MAIN scans slots 9..0
 * for the rider (13992-14002), keeps it in $160E and stores SubHorizPos into the rider's $157C (CODE_01E98D,
 * 14216-14222). The sprite loop runs slots 11 down to 0 (ENTRY.spriteLoop), so a rider with a higher slot than its
 * cloud is faced already in its INIT frame and one with a lower slot a frame later. A rider in slot 10 or 11 is
 * outside the scan and stays at 0 (a synthetic case: a vanilla-loaded Lakitu never gets above sprite table slot 9;
 * the issue's "slots 0-11" is read as 0-9 for that reason).
 * The synthetic blocks need no ROM; the corpus blocks are gated on the vanilla ROM.
 */
import { describe, expect, it } from 'vitest'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import type { RomFile } from '../../../../src/rom/RomFile'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { readStream } from '../../../../theia/extension/src/node/map-sprites'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const FACING = 0x157c
const RIDER = 70
const CLOUD = 71
const SLOW = 120_000
const SLOTS = Array.from({ length: 12 }, (_, i) => i)

interface Sample {
  /** $157C of the rider after INIT (before any MAIN pass), and on MAIN pass 0. */
  afterInit: number
  pass0: number
  /** The slot the spawned cloud took, -1 if none. */
  cloud: number
  /** flipX of Lakitu's own parts (chars $1EC and $1EE) in the chosen pass; the cloud's ($60) and others' are left out.
   * The filter assumes Lakitu's frame 0: while $1558 is set it draws frame 2, tiles $A8/$EE (bank_01.asm:2254-2256,
   * 3809-3810); pass 0 is frame 0 on all 5 entries. */
  flips: boolean[]
}

/** Runs the rider in `slot`, Mario at `mario`, and samples its facing; `cloudNumber` is the cloud's sprite number. */
function sample(
  rom: RomFile,
  id: number,
  cloudNumber: number,
  slot: number,
  o: {
    sprite: number
    mario: number
    y?: number
    loaded?: Uint8Array
    camera?: { x: number; y: number }
  },
): Sample {
  const y = o.y ?? 0x80
  const s: Sample = { afterInit: -1, pass0: -1, cloud: -1, flips: [] }
  const m = runOnce(
    rom,
    id,
    withSeed({
      slot,
      sprite: { x: o.sprite, y },
      mario: { x: o.mario, y },
      loaded: o.loaded,
      camera: o.camera,
      mainPasses: 3,
    }),
    {
      probe: (p, w) => {
        if (p === -1) {
          s.afterInit = w[FACING + slot]!
          for (let i = 0; i < 12; i++)
            if (w[0x14c8 + i] === 8 && w[0x9e + i] === cloudNumber) s.cloud = i
        }
        if (p === 0) s.pass0 = w[FACING + slot]!
      },
    },
  )
  expect(m.refusal).toBeUndefined()
  const pass = m.chosen === undefined ? undefined : m.passes[m.chosen]
  s.flips = (pass?.parts ?? []).filter(q => q.char === 0x1ec || q.char === 0x1ee).map(q => q.flipX)
  return s
}

/** SubHorizPos's answer: 1 when Mario is left of the cloud (which starts where the rider is), bank_01.asm:6124-6134. */
const side = (sprite: number, mario: number) => (mario < sprite ? 1 : 0)

/** A synthetic rider (id 70) whose INIT spawns a cloud (id 71) in the highest free slot, as InitLakitu does, and a cloud MAIN with the real routine's shape. */
function lakituRom(o: { cloud?: 'full' | 'nowrite' | 'rts' } = {}): RomFile {
  const rom = buildSyntheticRom()
  const w = (o.cloud ?? 'full') === 'full'
  // An equivalent of SubHorizPos (bank_01.asm:6124-6134) written for this fixture, as a compare and not the
  // vanilla subtract: Y = 1 when Mario ($D1/$D2) is left of the sprite ($E4,X / $14E0,X), else 0.
  rom.writeAt(0x01ad30, [0xa0, 0x00, 0xa5, 0xd2, 0xdd, 0xe0, 0x14, 0xd0, 0x04, 0xa5, 0xd1, 0xd5, 0xe4, 0xb0, 0x01, 0xc8, 0x60]) // prettier-ignore
  // Rider INIT: start at slot 7 (FindFreeSprSlot starts at SpriteSlotMax, bank_02.asm:5182-5184, 5524-5530; vanilla's is 7-9) / find the highest slot with status 0 / spawn the cloud there at the rider's position.
  rom.writeAt(0x019a00, [
    0xa0, 0x07, 0xb9, 0xc8, 0x14, 0xf0, 0x04, 0x88, 0x10, 0xf8, 0x60, // scan, RTS if none
    0xa9, CLOUD, 0x99, 0x9e, 0x00, 0xa9, 0x08, 0x99, 0xc8, 0x14, // number, status 8
    0xb5, 0xe4, 0x99, 0xe4, 0x00, 0xbd, 0xe0, 0x14, 0x99, 0xe0, 0x14, 0x60, // X low/high
  ]) // prettier-ignore
  // Cloud MAIN: find status 8 + rider number in slots 9..0, keep it in $160E,X, SubHorizPos, STA $157C,Y (14216-14222).
  rom.writeAt(0x019a40, [
    0xa0, 0x09, 0xb9, 0xc8, 0x14, 0xc9, 0x08, 0xd0, 0x0a, 0xb9, 0x9e, 0x00, 0xc9, RIDER, 0xd0, 0x03, 0x98, 0x80, 0x04, 0x88, 0x10, 0xec, 0x60, // scan 9..0
    0x9d, 0x0e, 0x16, 0x20, 0x30, 0xad, 0x98, 0xbc, 0x0e, 0x16, // keep slot, SubHorizPos
    ...(w ? [0x99, 0x7c, 0x15] : [0xea, 0xea, 0xea]), // STA $157C,Y, or NOPs for the planted defect
    0x60,
  ]) // prettier-ignore
  if (o.cloud === 'rts') rom.writeAt(0x019a40, [0x60]) // the cloud's MAIN never writes: a bare RTS
  rom.writeAt(0x019a80, [0x60]) // the rider's MAIN does nothing
  const words = (a: number) => [a & 0xff, (a >> 8) & 0xff]
  rom.writeAt(0x018170 + 11 + RIDER * 2, words(0x9a00))
  rom.writeAt(0x018320 + 9 + RIDER * 2, words(0x9a80))
  rom.writeAt(0x018320 + 9 + CLOUD * 2, words(0x9a40))
  rom.writeAt(0x018170 + 11 + CLOUD * 2, words(0x9a80))
  return rom
}

describe('Lakitu facing through the cloud (synthetic)', () => {
  const rom = lakituRom()
  const run = (slot: number, sprite: number, mario: number) => sample(rom, RIDER, CLOUD, slot, { sprite, mario }) // prettier-ignore

  it.each([
    [0x200, 0x1f0],
    [0x200, 0x210],
  ])(
    'rider at X 0x%s, Mario at X 0x%s: pass-0 facing is the SubHorizPos side in slots 0-9 and 0 in 10-11',
    (sprite, mario) => {
      const got = SLOTS.map(slot => run(slot, sprite, mario).pass0)
      expect(got).toEqual(SLOTS.map(slot => (slot <= 9 ? side(sprite, mario) : 0)))
      expect(got.some(v => v === 1)).toBe(side(sprite, mario) === 1) // the side is exercised, not constant
    },
  )

  it('has the facing after INIT only when the cloud runs after the rider in the INIT frame (cloud slot below the rider)', () => {
    let ones = 0
    for (const slot of SLOTS) {
      const s = run(slot, 0x200, 0x1f0)
      expect(s.cloud).toBe(slot === 7 ? 6 : 7)
      expect(s.afterInit).toBe(slot <= 9 && s.cloud < slot ? 1 : 0)
      ones += s.afterInit
    }
    expect(ones).toBe(3) // slots 7, 8 and 9: the cloud below the rider is the only way to a 1 here
  })

  it.each(['nowrite', 'rts'] as const)(
    'goes red when the cloud MAIN does not write (planted defect: %s)',
    cloud => {
      const dead = lakituRom({ cloud })
      const got = SLOTS.map(
        slot => sample(dead, RIDER, CLOUD, slot, { sprite: 0x200, mario: 0x1f0 }).pass0,
      )
      expect(got).toEqual(SLOTS.map(() => 0))
      expect(got).not.toEqual(SLOTS.map(slot => (slot <= 9 ? 1 : 0)))
    },
  )
})

describe.skipIf(!hasRom(VANILLA))(
  'Lakitu facing on the vanilla maps that carry one (#1007)',
  () => {
    const MAPS = [0x11f, 0x132, 0x1c4, 0x1c5]
    /** Each map's real $1E entries, with the loader image and Mario's start, as the map view seeds them. */
    function lakitus(rom: RomFile, map: number) {
      const l = loadLevelState(rom, map)
      if (!l.ok) throw new Error(`loader refused map $${map.toString(16)}: ${l.reason}`)
      const w = l.wram
      const smw = new SmwRom(rom)
      const ptr = smw.getLevelSpritePointer(map)
      const data = ptr === null ? null : readStream(rom, ptr)
      if (!data) throw new Error(`no sprite stream for $${map.toString(16)}`)
      const list = parseLevelSprites(data, (w[0x5b]! & 1) === 1).filter(s => s.spriteId === 0x1e)
      const mario = { x: w[0x94]! | (w[0x95]! << 8), y: w[0x96]! | (w[0x97]! << 8) }
      return { w, mario, list }
    }
    const at = (rom: RomFile, map: number) => {
      const { w, mario, list } = lakitus(rom, map)
      return list.map(s => ({ s, w, mario, x: s.x * 16, y: s.y * 16 }))
    }

    it.each(MAPS.map(m => [m.toString(16), m] as const))(
      'map $%s: pass-0 $157C follows SubHorizPos in slots 0-9, stay 0 in 10-11',
      (_hex, map) => {
        const rom = freshRom()
        const entries = at(rom, map)
        expect(entries.length).toBeGreaterThan(0)
        for (const e of entries) {
          // A margin, not a derived bound: the cloud's X speed is capped at $20 subpixel units (DATA_01E989,
          // bank_01.asm:14210-14211), under 2 px a frame, so 0x20 px is out of reach of the few frames run here.
          expect(Math.abs(e.x - e.mario.x)).toBeGreaterThan(0x20)
          const camera = { x: Math.max(0, e.x - 128), y: Math.max(0, e.y - 112) }
          const wants = new Set<number>()
          // Mario where the loader put him, and mirrored to the other side of the rider.
          for (const marioX of [e.mario.x, 2 * e.x - e.mario.x]) {
            for (const slot of SLOTS) {
              const s = sample(rom, 0x1e, 0x87, slot, { sprite: e.x, y: e.y, mario: marioX, loaded: e.w, camera }) // prettier-ignore
              const want = slot <= 9 ? side(e.x, marioX) : 0
              const tag = `$${map.toString(16)} Mario ${marioX.toString(16)} slot ${slot}`
              expect(s.pass0, tag).toBe(want)
              // The post-INIT sample (what #272's captures hold) is the facing only if the cloud's slot is below the rider's.
              expect(s.afterInit, `${tag} after INIT`).toBe(slot <= 9 && s.cloud >= 0 && s.cloud < slot ? want : 0) // prettier-ignore
              // The drawn picture: facing 0 is drawn flipped (the cart's own SubSprGfx1 reads $157C, bank_01.asm:3957-3962;
              // the $1EC/$1EE filter holds for frame 0 only, see Sample.flips).
              expect(s.flips.length, `${tag} drawn`).toBeGreaterThan(0)
              expect(new Set(s.flips), `${tag} flipX`).toEqual(new Set([want === 0]))
              if (slot <= 9) wants.add(want)
            }
          }
          expect([...wants].sort()).toEqual([0, 1]) // both sides are exercised on every entry
        }
      },
      SLOW,
    )

    it('goes red when the cloud MAIN store ($01:E998, STA $157C,Y) is disabled (planted defect)', () => {
      const rom = freshRom()
      expect([...rom.readAt(0x01e998, 3)!]).toEqual([0x99, 0x7c, 0x15]) // the store this test disables
      rom.writeAt(0x01e998, [0xea, 0xea, 0xea])
      // Find a map entry with Mario left of the rider (side 1): without the store pass-0 facing stays 0.
      const e = MAPS.flatMap(m => at(rom, m)).find(x => side(x.x, x.mario.x) === 1)
      expect(e).toBeDefined()
      const s = sample(rom, 0x1e, 0x87, 0, {
        sprite: e!.x,
        y: e!.y,
        mario: e!.mario.x,
        loaded: e!.w,
      })
      expect(s.pass0).toBe(0)
    })
  },
)
