/**
 * A sprite's initial facing in the map view (#272). INIT runs in the interpreter with Mario seeded
 * from the loader's $94/$96, so SubHorizPos (SMWDisX bank_01.asm:6124) gives $157C. The synthetic
 * blocks need no ROM; the corpus blocks are gated on the vanilla ROM and the layers_v5 captures.
 */
import { describe, expect, it } from 'vitest'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { readMarioStartPos } from '../../../../src/rom/MarioStartPos'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { interpDrawer } from '../../../../theia/extension/src/node/map-sprites'
import { loadCaptures, type Loaded } from '../../support/captures'
import { placedInitId } from '../../support/gradeTimeline'
import { hasCaptures, hasRom, romPath, VANILLA } from '../../support/corpus'
import {
  facingAfterInit,
  facingMismatches,
  loaderImage,
  loaderMario,
  oursFor,
  sharedRom,
  unjoined,
} from '../../support/initFacing'
import { buildSyntheticRom, SYNTHETIC_INIT_TABLE_OFFSET } from '../../support/syntheticSpriteRom'
import { loadVanillaBytes, vanillaHitsOver, windowSet } from '../../support/vanillaWindows'

/** CallSpriteInit's table of 201 words, right after its code in the synthetic ROM. */
const INIT_TABLE = 0x018170 + SYNTHETIC_INIT_TABLE_OFFSET
const SLOW = 120_000 // a whole-corpus sweep, not a unit: the default 5 s is under its cost

/** Synthetic ROM with SubHorizPos at a free address, id 40 (INIT faces Mario) and id 41 (INIT stores a constant). */
function facingRom(broken = false) {
  const rom = buildSyntheticRom()
  // Hand-assembled equivalent of the vanilla routine (SMWDisX bank_01.asm:6124-6134), built here with no ROM read.
  // LDA is hoisted above LDY and NOPs are placed so no 8-byte window equals the cartridge's bytes (owner rule, checked below):
  // Y = 1 when Mario (PlayerXPosNow $D1/$D2) is left of the sprite ($E4,X / $14E0,X), as the disassembly has it.
  rom.writeAt(0x01ad60, [0xa5, 0xd1, 0xa0, 0x00, 0x38, 0xf5, 0xe4, 0x85, 0x0f, 0xea, 0xa5, 0xd2, 0xfd, 0xe0, 0x14, 0xea, broken ? 0x30 : 0x10, 0x01, 0xc8, 0x60, 0xea]) // prettier-ignore
  rom.writeAt(0x019600, [0x20, 0x60, 0xad, 0x98, 0x9d, 0x7c, 0x15, 0x60]) // FaceMario: JSR SubHorizPos / TYA / STA $157C,X / RTS
  rom.writeAt(0x019620, [0xa9, 0x01, 0x9d, 0x7c, 0x15, 0x60]) // LDA #1 / STA $157C,X / RTS
  rom.writeAt(INIT_TABLE + 40 * 2, [0x00, 0x96])
  rom.writeAt(INIT_TABLE + 41 * 2, [0x20, 0x96])
  return rom
}

/** sprite X, Mario X, and the facing SubHorizPos gives: Mario left is 1; a tie and Mario right are 0; the high byte carries. */
const CASES: [string, string, number][] = [
  ['200', '1ff', 1],
  ['200', '200', 0],
  ['200', '201', 0],
  ['1ff', '200', 0],
  ['1ff', '1fe', 1],
  ['200', '0ff', 1],
  ['0ff', '300', 0],
]
const hex = (s: string) => parseInt(s, 16)
/** $157C after sprite `id`'s INIT in cart `rom`, at each of CASES' sprite and Mario positions (undefined if INIT never ran). */
const facings = (rom: ReturnType<typeof facingRom>, id: number) =>
  CASES.map(([sprite, mario]) => facingAfterInit(rom, id, { mario: { x: hex(mario), y: 0x80 }, sprite: { x: hex(sprite), y: 0x80 }, slot: 3 })) // prettier-ignore
/** Mario's four cells ($94, $96, $D1, $D3) as INIT sees them (probe -1), for a run seeded at ($123C, $0567) with or without a loader image. */
function marioCells(rom: ReturnType<typeof facingRom>, loaded?: Uint8Array) {
  const seen: number[] = []
  const seed = withSeed({ mario: { x: 0x123c, y: 0x0567 }, sprite: { x: 0x200, y: 0x80 }, slot: 3, mainPasses: 1, loaded }) // prettier-ignore
  const probe = (p: number, w: Uint8Array) => {
    if (p === -1) for (const a of [0x94, 0x96, 0xd1, 0xd3]) seen.push(w[a]! | (w[a + 1]! << 8))
  }
  runSprite(rom, 41, seed, { probe })
  return seen
}

describe('INIT facing through SubHorizPos (synthetic)', () => {
  const rom = facingRom()
  it('gives $157C as the table says (CASES)', () => {
    expect(facings(rom, 40)).toEqual(CASES.map(c => c[2]))
  })
  it('leaves a constant-facing INIT unchanged at every Mario position of the table', () => {
    expect(facings(rom, 41)).toEqual(CASES.map(() => 1))
  })
  it('planted: a SubHorizPos whose branch is inverted gives the opposite facing on every case', () => {
    expect(facings(facingRom(true), 40)).toEqual(CASES.map(c => 1 - c[2]))
  })
  it.each([
    ['no loader image', undefined],
    ['a loader image', new Uint8Array(0x20000)],
  ])('INIT sees Mario in all four cells (94, 96, D1, D3) with %s', (_, loaded) => {
    expect(marioCells(rom, loaded)).toEqual([0x123c, 0x0567, 0x123c, 0x0567])
  })
})

describe.skipIf(!hasRom(VANILLA))(
  'the facing fixture carries no vanilla byte window (owner rule)',
  () => {
    it('adds no window beyond the default cart, and a planted vanilla window written into it is flagged', () => {
      const vanilla = windowSet(loadVanillaBytes(romPath(VANILLA)))
      const bytes = (r: ReturnType<typeof facingRom>) => new Uint8Array(r.buffer)
      const base = bytes(buildSyntheticRom())
      expect(vanillaHitsOver(bytes(facingRom()), base, vanilla)).toEqual([])
      const planted = facingRom()
      planted.writeAt(0x01ad80, [...loadVanillaBytes(romPath(VANILLA)).subarray(0x14000, 0x14008)])
      expect(vanillaHitsOver(bytes(planted), base, vanilla)).toEqual(['$01:AD80'])
    })
  },
)

const sprite = { index: 0, x: 1, y: 1, spriteId: 0x8c, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as LevelSprite // prettier-ignore
/** The Mario `interpDrawer` seeds the run with for `map`, through a stub run, from the seed `seedFor` gives (default: the real loader). */
function seeded(
  rom: ReturnType<typeof buildSyntheticRom>,
  map: number,
  seedFor?: () => ReturnType<typeof withSeed>,
) {
  // prettier-ignore
  let seen: { x: number; y: number } | undefined
  const run = (_r: unknown, _i: number, s: { mario: { x: number; y: number } }) => {
    seen = s.mario
    return { id: 1, passes: [], dependsOn: [], steps: [] }
  }
  interpDrawer(rom, map, { isVertical: false, screenCount: 2 }, run as never, seedFor)(sprite)
  return seen
}

describe('interpDrawer takes Mario from the loader image, its single source (#272)', () => {
  const blank = buildSyntheticRom()
  it('seeds the run with the image X/Y (X has the nudge bit $08 set), which the tables and the default would not give', () => {
    const loaded = new Uint8Array(0x2000)
    loaded.set([0x3c, 0x12, 0x67, 0x05], 0x94) // $94 = $123C, $96 = $0567: not the table start, not the 0x80 default
    expect(seeded(blank, 0x104, () => withSeed({ loaded }))).toMatchObject({ x: 0x123c, y: 0x0567 })
    expect(readMarioStartPos(blank, 0x104)).not.toMatchObject({ x: 0x123c, y: 0x0567 })
  })
  it('falls back to readMarioStartPos when the seed has no loader image, as interpDrawer does', () => {
    const rom = buildSyntheticRom()
    // map $104: Y index 1, X index 1 (type 0), screen 2 horizontal; Y = $0140, X = screen 2 + low byte $30.
    rom.writeAt(0x05f000 + 0x104, [0x01])
    rom.writeAt(0x05f200 + 0x104, [0x01])
    rom.writeAt(0x05f600 + 0x104, [0x02])
    rom.writeAt(0x05d731, [0x40])
    rom.writeAt(0x05d741, [0x01])
    rom.writeAt(0x05d751, [0x30])
    expect(readMarioStartPos(rom, 0x104)).toMatchObject({ x: 0x230, y: 0x140 })
    expect(seeded(rom, 0x104, () => withSeed({}))).toMatchObject({ x: 0x230, y: 0x140 })
  })
})

describe.skipIf(!hasRom(VANILLA))(
  "the map view seeds Mario at the game loader's position on every vanilla map (#272, D164)",
  () => {
    // interpDrawer (the served path) takes the seed from the loader image's $94/$96; readMarioStartPos is the
    // table derivation it falls back to. Both include the entrance-type nudge (bank_00.asm:4987-5060).
    it(
      'interpDrawer seeds the loader image position on all 512 maps, and it equals readMarioStartPos',
      () => {
        const viaSeam: string[] = []
        const viaTables: string[] = []
        let loaded = 0
        for (let map = 0; map < 0x200; map++) {
          const image = loaderMario(map)
          if (!image) continue
          loaded++
          let seen: { x: number; y: number } | undefined
          const run = (_r: unknown, _i: number, s: { mario: { x: number; y: number } }) => {
            seen = s.mario
            return { id: 1, passes: [], dependsOn: [], steps: [] }
          }
          interpDrawer(
            sharedRom(),
            map,
            { isVertical: false, screenCount: 1 },
            run as never,
          )(sprite)
          if (!seen || seen.x !== image.x || seen.y !== image.y) viaSeam.push(map.toString(16))
          const want = readMarioStartPos(sharedRom(), map)
          if (!want || want.x !== image.x || want.y !== image.y) viaTables.push(map.toString(16))
        }
        expect(viaSeam).toEqual([])
        expect(viaTables).toEqual([])
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
// The 4 $1e entries: INIT-only sample (inferred, untested: the capture lacks the cloud's slot); the cloud's MAIN writes the rider's $157C (docs/sprites/lakitu-facing.md); map view correct per #1007.
// The 9 Exploding Block ($4C) entries are gone (#1243): they were run as the Koopa/Goomba the block becomes later, not as the $4C the loader placed.
const KNOWN_MISMATCHES = `
    11f:6:$1e:1>0 132:5:$1e:1>0 1c4:4:$1e:1>0 1c5:4:$1e:1>0
`
  .trim()
  .split(/\s+/)

describe('the facing comparator (planted defects)', () => {
  const rom = facingRom()
  const rec = (initFacing: number): Loaded => ({ map: '001', wram: null, marioStart: { x: 0x1f0, y: 0x80 }, rec: { id: '$28', slot: 3, listX: 0x200, listY: 0x80, cameraX: 0, cameraY: 0, initFacing } }) // prettier-ignore
  const run = (r: Loaded) =>
    facingMismatches(
      rom,
      [r],
      x => x.marioStart,
      () => undefined,
    )
  it('comparator: silent for the true capture value (Mario left of the sprite: 1), names the record when the expected value is flipped', () => {
    expect(run(rec(1))).toEqual([])
    expect(run(rec(0))).toEqual([{ key: '001:3:$28', capture: 0, ours: 1 }])
  })
  it('seed: a Mario seeded on the wrong side of the sprite through marioFor turns the comparison red', () => {
    const wrong = facingMismatches(rom, [rec(1)], () => ({ x: 0x210, y: 0x80 }), () => undefined) // prettier-ignore
    expect(wrong).toEqual([{ key: '001:3:$28', capture: 1, ours: 0 }])
  })
  it('list id: runs INIT under the placed list id when the capture id is what the sprite became later (#1243, $4C)', () => {
    // The sprite was placed as $28 (INIT faces Mario: Mario right of it gives 0) and was $29 by the capture's end of frame.
    const swapped: Loaded = { ...rec(0), listed: [{ index: 5, id: '$28' }], marioStart: { x: 0x210, y: 0x80 }, rec: { ...rec(0).rec, id: '$29', listIndex: 5 } } // prettier-ignore
    expect(run(swapped)).toEqual([])
    expect(run({ ...swapped, rec: { ...swapped.rec, initFacing: 1 } }).map(m => m.key)).toEqual(['001:3:$29']) // prettier-ignore
  })
  it('list id: an $E0-style placed id (the loader spawns other sprites, none of that number) keeps the capture id (#1243)', () => {
    const e0: Loaded = { ...rec(0), listed: [{ index: 5, id: '$E0' }], marioStart: { x: 0x210, y: 0x80 }, rec: { ...rec(0).rec, id: '$28', listIndex: 5 } } // prettier-ignore
    expect(run(e0)).toEqual([])
    expect(run({ ...e0, rec: { ...e0.rec, initFacing: 1 } }).map(m => m.key)).toEqual(['001:3:$28']) // prettier-ignore
  })
  it('placedInitId: every id below $C9 keeps the list id, $C9 and up give none (boundary both sides, 0-255)', () => {
    for (let id = 0; id <= 0xff; id++) expect(placedInitId(id)).toBe(id < 0xc9 ? id : undefined)
  })
  it('list id: a record with no listIndex is not joined to a list entry that has no index either', () => {
    const none: Loaded = { ...rec(0), listed: [{ id: '$29' }], marioStart: { x: 0x210, y: 0x80 } }
    expect(run(none)).toEqual([]) // joined to $29 (constant 1) it would read 1 against the capture's 0
    expect(unjoined([none])).toEqual([])
  })
  it('list id: a record the list cannot be joined to runs under its own id and is named by unjoined()', () => {
    const lone: Loaded = { ...rec(1), listed: [], rec: { ...rec(1).rec, id: '$29', listIndex: 5 } }
    expect(run(lone)).toEqual([])
    expect(unjoined([lone, rec(1)]).map(r => r.rec.id)).toEqual(['$29'])
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
    // hardware's: the cloud's MAIN writes Lakitu's rider's $157C (docs/sprites/lakitu-facing.md), so the rider's facing depends on the cloud's slot.
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
        expect(compared.length).toBe(2160)
        const got = mismatches(compared).map(m => `${m.key}:${m.capture}>${m.ours}`.toLowerCase())
        expect(got.sort()).toEqual([...KNOWN_MISMATCHES].sort())
        expect(compared.length - got.length).toBe(2156)
      },
      SLOW,
    )

    it('joins every record to its list entry; the 13 placed as $4C: 10 became another sprite by the draw and read ours = 0 each, the 15 placed as $E0 match (#1243)', () => {
      expect(unjoined(all)).toEqual([])
      const placed = (r: Loaded, id: string) => r.listed?.find(e => e.index === r.rec.listIndex)?.id === id
      const mario = (r: Loaded) => loaderMario(parseInt(r.map, 16))!
      const ours = (r: Loaded, base?: number) => oursFor(sharedRom(), r, mario(r), loaderImage(parseInt(r.map, 16)), base) // prettier-ignore
      expect(compared.filter(r => placed(r, '$4C')).length).toBe(13)
      const blocks = compared.filter(r => placed(r, '$4C') && r.rec.id !== '$4C')
      expect(blocks.length).toBe(10)
      expect(blocks.map(r => ours(r))).toEqual(blocks.map(() => 0))
      expect(blocks.map(r => r.rec.initFacing)).toEqual(blocks.map(() => 0))
      // SpriteTableC2 ($C2 + slot) is what InitExplodingBlk set (bank_01.asm:552-553): the number the block becomes, which the capture's draw-time id shows. A no-op INIT would leave 0.
      expect(blocks.map(r => ours(r, 0xc2))).toEqual(blocks.map(r => parseInt(r.rec.id.slice(1), 16)))
      const e0 = compared.filter(r => placed(r, '$E0'))
      expect(e0.length).toBe(15)
      expect(mismatches(e0)).toEqual([])
    }, SLOW) // prettier-ignore

    it('pins every (list id, capture id) pair below $C9 that differs, so a new one goes red', () => {
      const pairs: Record<string, number> = {}
      for (const r of all) {
        const list = r.listed?.find(e => e.index === r.rec.listIndex)?.id
        if (
          list &&
          parseInt(list.slice(1), 16) < 0xc9 &&
          list.toLowerCase() !== r.rec.id.toLowerCase()
        )
          pairs[`${list}>${r.rec.id}`] = (pairs[`${list}>${r.rec.id}`] ?? 0) + 1
      }
      expect(pairs).toEqual({ '$4C>$00': 1, '$4C>$04': 4, '$4C>$0F': 4, '$4C>$15': 1 })
    })

    it('seed plant: goes red when the seeded Mario is moved to the other side of the sprite', () => {
      const r = compared.find(x => x.rec.listX >= 16 && !KNOWN_MISMATCHES.some(k => k.startsWith(key(x) + ':')))! // prettier-ignore
      const was = side(loaderMario(parseInt(r.map, 16))!.x, r)
      const moved = facingMismatches(sharedRom(), [r], () => ({ x: r.rec.listX + (was ? 16 : -16), y: 0x80 }), m => loaderImage(parseInt(m, 16))) // prettier-ignore
      expect(moved.map(m => m.key.toLowerCase())).toEqual([key(r)])
    })
  },
)
