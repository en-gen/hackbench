/**
 * A sprite's initial facing in the map view (#272). INIT runs in the interpreter with Mario seeded
 * from the loader's $94/$96, so SubHorizPos (SMWDisX bank_01.asm:6124) gives $157C. The synthetic
 * blocks need no ROM; the corpus blocks are gated on the vanilla ROM and the layers_v5 captures.
 */
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { readMarioStartPos } from '../../../../src/rom/MarioStartPos'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { interpDrawer } from '../../../../theia/extension/src/node/map-sprites'
import { loadCaptures, type Loaded } from '../../support/captures'
import { hasCaptures, hasRom, VANILLA } from '../../support/corpus'
import {
  facingAfterInit,
  facingMismatches,
  loaderImage,
  loaderMario,
  sharedRom,
} from '../../support/initFacing'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

/** CallSpriteInit's table of 201 words, right after its 11 bytes of code. */
const INIT_TABLE = 0x018170 + 11
const SLOW = 120_000 // a whole-corpus sweep, not a unit: the default 5 s is under its cost

/** Synthetic ROM with SubHorizPos at a free address, id 40 (INIT faces Mario) and id 41 (INIT stores a constant). */
function facingRom() {
  const rom = buildSyntheticRom()
  // Hand-assembled slice of the vanilla routine (SMWDisX bank_01.asm:6124-6134), built here with no ROM read:
  // Y = 1 when Mario (PlayerXPosNow $D1/$D2) is left of the sprite ($E4,X / $14E0,X), as the disassembly has it.
  rom.writeAt(0x01ad30, [0xa0, 0x00, 0xa5, 0xd1, 0x38, 0xf5, 0xe4, 0x85, 0x0f, 0xa5, 0xd2, 0xfd, 0xe0, 0x14, 0x10, 0x01, 0xc8, 0x60]) // prettier-ignore
  rom.writeAt(0x019600, [0x20, 0x30, 0xad, 0x98, 0x9d, 0x7c, 0x15, 0x60]) // FaceMario: JSR SubHorizPos / TYA / STA $157C,X / RTS
  rom.writeAt(0x019620, [0xa9, 0x01, 0x9d, 0x7c, 0x15, 0x60]) // LDA #1 / STA $157C,X / RTS
  rom.writeAt(INIT_TABLE + 40 * 2, [0x00, 0x96])
  rom.writeAt(INIT_TABLE + 41 * 2, [0x20, 0x96])
  return rom
}

describe('INIT facing through SubHorizPos (synthetic)', () => {
  const rom = facingRom()
  const at = (id: number, sprite: number, mario: number) => facingAfterInit(rom, id, { mario: { x: mario, y: 0x80 }, sprite: { x: sprite, y: 0x80 }, slot: 3 }) // prettier-ignore
  it.each([
    // sprite X, Mario X, facing: Mario left is 1; a tie and Mario right are 0; the high byte carries
    ['200', '1ff', 1],
    ['200', '200', 0],
    ['200', '201', 0],
    ['1ff', '200', 0],
    ['1ff', '1fe', 1],
    ['200', '0ff', 1],
    ['0ff', '300', 0],
  ])('sprite X 0x%s, Mario X 0x%s gives $157C %i', (sprite, mario, want) => {
    expect(at(40, parseInt(sprite, 16), parseInt(mario, 16))).toBe(want)
  })
  it('leaves a constant-facing INIT unchanged on both sides', () => {
    expect([at(41, 0x200, 0x1f0), at(41, 0x200, 0x210)]).toEqual([1, 1])
  })
})

describe('interpDrawer takes Mario from the loader image, its single source (#272)', () => {
  const blank = buildSyntheticRom()
  const sprite = { index: 0, x: 1, y: 1, spriteId: 0x8c, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as LevelSprite // prettier-ignore
  const loaded = new Uint8Array(0x2000)
  loaded.set([0x34, 0x12, 0x67, 0x05], 0x94) // $94 = $1234, $96 = $0567: not the table start, not the 0x80 default
  it('seeds the run with the image X/Y, which the entrance tables and the seed default would not give', () => {
    let seen: { x: number; y: number } | undefined
    const run = (_r: unknown, _i: number, s: { mario: { x: number; y: number } }) => {
      seen = s.mario
      return { id: 1, passes: [], dependsOn: [], steps: [] }
    }
    interpDrawer(blank, 0x104, { isVertical: false, screenCount: 2 }, run as never, () => withSeed({ loaded }))(sprite) // prettier-ignore
    expect(seen).toMatchObject({ x: 0x1234, y: 0x0567 })
    expect(readMarioStartPos(blank, 0x104)).not.toMatchObject({ x: 0x1234, y: 0x0567 })
  })
})

describe.skipIf(!hasRom(VANILLA))(
  'the map view seed is the entrance-table start on every vanilla map (#272)',
  () => {
    // The seed is the loader image's $94/$96 (interpDrawer); readMarioStartPos is the table
    // derivation the same code falls back to. Both include the entrance-type nudge (bank_00.asm:4987-5060).
    it(
      'loader $94/$96 equals readMarioStartPos for all 512 maps',
      () => {
        const bad: string[] = []
        let loaded = 0
        for (let map = 0; map < 0x200; map++) {
          const seed = loaderMario(map)
          if (!seed) continue
          loaded++
          const want = readMarioStartPos(sharedRom(), map)
          if (!want || want.x !== seed.x || want.y !== seed.y) bad.push(map.toString(16))
        }
        expect(bad).toEqual([])
        expect(loaded).toBe(0x200)
      },
      SLOW,
    )
  },
)

/** map:slot:id of the capture records with no INIT caught (initFacing null, no marioAtInit): nothing to compare. A repeated key is two records. */
const NO_INIT = `
    006:9:$07 008:9:$05 00d:2:$06 00d:7:$05 00d:7:$06 00d:8:$04 00d:9:$05 010:3:$05 01c:9:$04
    021:4:$39 021:4:$39 102:4:$05 105:3:$05 106:8:$05 106:9:$04 106:9:$05 10a:9:$05 115:7:$07
    11a:6:$06 11a:6:$06 11a:7:$05 11a:8:$04 11b:8:$07 11d:2:$39 11f:3:$06 11f:4:$05 11f:7:$05
    123:2:$05 12d:4:$04 12d:4:$07 12d:5:$07 12d:6:$04 12d:6:$05 12d:6:$05 12d:7:$06 12d:7:$07
    135:2:$04 135:3:$05
`
  .trim()
  .split(/\s+/)

/** map:slot:id of the records whose Mario at INIT stood on the OTHER side of the sprite from the marioStart (62 records, 34 maps): the capture's facing came from a different Mario. */
const OTHER_SIDE = `
    004:6:$b9 007:6:$27 007:7:$27 01a:9:$30 01b:8:$ac 01b:9:$ad 021:5:$52 093:6:$29 094:5:$b6
    094:6:$29 0be:9:$c3 0c4:8:$7b 0cb:9:$7b 0d0:7:$6f 0d3:5:$b6 0d3:6:$29 0d6:9:$b4 0d8:9:$3e
    0db:9:$24 101:6:$24 101:7:$b9 104:4:$b9 104:5:$8c 104:6:$8a 104:7:$8a 104:8:$8a 104:9:$8a
    110:7:$b1 11d:0:$28 12a:6:$6c 193:5:$b6 193:6:$29 194:6:$29 1bf:7:$15 1bf:8:$15 1bf:9:$2e
    1c1:6:$c2 1c1:7:$c2 1c4:2:$3e 1c4:3:$3e 1c4:4:$78 1c4:5:$3e 1c4:6:$78 1c4:7:$78 1cc:9:$93
    1cd:6:$bc 1cd:7:$bc 1cd:8:$bc 1ce:7:$32 1cf:7:$26 1cf:8:$26 1cf:9:$26 1d1:6:$bb 1d1:7:$a5
    1d1:8:$a5 1d1:9:$a5 1d4:6:$33 1d4:7:$33 1d9:1:$90 1da:8:$7b 1db:7:$37 1db:9:$37
`
  .trim()
  .split(/\s+/)

/** Compared records where our INIT facing differs from the capture's, as map:slot:id:capture>ours. Not fixed here (#272 is tests only); a fix or a new mismatch must change this list. */
// The 4 $1e entries: INIT-only sample (inferred, untested: the capture lacks the cloud's slot); the cloud's MAIN sets the rider; map view correct per #1007.
const KNOWN_MISMATCHES = `
    11e:0:$04:0>1 11e:3:$04:0>1 11e:3:$0f:0>1 11e:4:$04:0>1 11e:6:$00:0>1 11e:6:$04:0>1
    11e:7:$0f:0>1 11e:8:$0f:0>1 11f:6:$1e:1>0 126:7:$0f:0>1 132:5:$1e:1>0 1c4:4:$1e:1>0
    1c5:4:$1e:1>0
`
  .trim()
  .split(/\s+/)

describe('the facing comparison reports a flipped capture (planted defect)', () => {
  const rom = facingRom()
  const rec = (initFacing: number): Loaded => ({ map: '001', wram: null, marioStart: { x: 0x1f0, y: 0x80 }, rec: { id: '$28', slot: 3, listX: 0x200, listY: 0x80, cameraX: 0, cameraY: 0, initFacing } }) // prettier-ignore
  const run = (r: Loaded) =>
    facingMismatches(
      rom,
      [r],
      x => x.marioStart,
      () => undefined,
    )
  it('is silent for the true facing (Mario left of the sprite: 1) and names the record when flipped', () => {
    expect(run(rec(1))).toEqual([])
    expect(run(rec(0))).toEqual([{ key: '001:3:$28', capture: 0, ours: 1 }])
  })
  it('skips a record with no INIT (initFacing null) instead of comparing it', () => {
    expect(run({ ...rec(0), rec: { ...rec(0).rec, initFacing: null } })).toEqual([])
  })
})

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'INIT facing vs level-load captures (#272)',
  () => {
    const all: Loaded[] = hasCaptures() && hasRom(VANILLA) ? loadCaptures() : []
    const num = all.filter(r => typeof r.rec.initFacing === 'number')
    // SubHorizPos's side: 1 when Mario is left of the sprite.
    const side = (x: number, r: Loaded) => (x < r.rec.listX ? 1 : 0)
    const other = (r: Loaded) => !!r.marioStart && !!r.rec.marioAtInit && side(r.rec.marioAtInit.x, r) !== side(r.marioStart.x, r) // prettier-ignore
    const key = (r: Loaded) => `${r.map}:${r.rec.slot}:${r.rec.id}`.toLowerCase()
    const compared = num.filter(r => !other(r))
    // Mario is the map view's seed (loader $94/$96), with the capture's slot and camera. The slot is the
    // hardware's: Lakitu's rider ($1E) reads another sprite's $157C, so its facing depends on the slot.
    const mismatches = (rs: Loaded[]) => facingMismatches(sharedRom(), rs, r => loaderMario(parseInt(r.map, 16)), m => loaderImage(parseInt(m, 16))) // prettier-ignore

    it('lists the records with no INIT, and the other-side records, by exact list', () => {
      expect(all.filter(r => typeof r.rec.initFacing !== 'number').map(key).sort()).toEqual([...NO_INIT].sort()) // prettier-ignore
      expect(NO_INIT.length).toBe(38)
      expect(num.filter(other).map(key).sort()).toEqual([...OTHER_SIDE].sort())
      expect(OTHER_SIDE.length).toBe(62)
      expect(new Set(OTHER_SIDE.map(k => k.split(':')[0])).size).toBe(34)
    })

    it(
      'matches the capture on every compared record except the named known mismatches',
      () => {
        expect(compared.length).toBe(2162)
        const got = mismatches(compared).map(m => `${m.key}:${m.capture}>${m.ours}`.toLowerCase())
        expect(got.sort()).toEqual([...KNOWN_MISMATCHES].sort())
        expect(compared.length - got.length).toBe(2149)
      },
      SLOW,
    )

    it('goes red when a capture record is flipped (corpus plant)', () => {
      const r = compared.find(x => !KNOWN_MISMATCHES.some(k => k.startsWith(key(x) + ':')))!
      const flipped = { ...r, rec: { ...r.rec, initFacing: 1 - r.rec.initFacing! } }
      expect(mismatches([flipped]).map(m => m.key.toLowerCase())).toEqual([key(r)])
    })
  },
)
