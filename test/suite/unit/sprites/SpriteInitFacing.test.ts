/**
 * A sprite's initial facing in the map view (#272). INIT runs in the interpreter with Mario seeded
 * from the loader's $94/$96, so SubHorizPos (SMWDisX bank_01.asm:6124) gives $157C. The synthetic
 * blocks need no ROM; the corpus blocks are gated on the vanilla cart and the layers_v5 captures.
 */
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { readMarioStartPos } from '../../../../src/rom/MarioStartPos'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { interpDrawer } from '../../../../theia/extension/src/node/map-sprites'
import { loadCaptures, type Loaded } from '../../support/captures'
import { freshRom, hasCaptures, hasRom, VANILLA } from '../../support/corpus'
import { facingAfterInit, facingMismatches } from '../../support/initFacing'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

/** CallSpriteInit's table of 201 words, right after its 11 bytes of code. */
const INIT_TABLE = 0x018170 + 11

/** Synthetic cart with SubHorizPos at a free address, id 40 (INIT faces Mario) and id 41 (INIT stores a constant). */
function facingRom() {
  const rom = buildSyntheticRom()
  // SubHorizPos, SMWDisX bank_01.asm:6124-6134: Y = 1 when Mario ($94/$95) is left of the sprite ($E4,X / $14E0,X).
  rom.writeAt(0x01ad30, [0xa0, 0x00, 0xa5, 0x94, 0x38, 0xf5, 0xe4, 0x85, 0x0f, 0xa5, 0x95, 0xfd, 0xe0, 0x14, 0x10, 0x01, 0xc8, 0x60]) // prettier-ignore
  rom.writeAt(0x019600, [0x20, 0x30, 0xad, 0x98, 0x9d, 0x7c, 0x15, 0x60]) // JSR SubHorizPos / TYA / STA $157C,X / RTS
  rom.writeAt(0x019620, [0xa9, 0x01, 0x9d, 0x7c, 0x15, 0x60]) // LDA #1 / STA $157C,X / RTS
  rom.writeAt(INIT_TABLE + 40 * 2, [0x00, 0x96])
  rom.writeAt(INIT_TABLE + 41 * 2, [0x20, 0x96])
  return rom
}

describe('INIT facing through SubHorizPos (synthetic)', () => {
  const rom = facingRom()
  const at = (id: number, marioX: number) => facingAfterInit(rom, id, { mario: { x: marioX, y: 0x80 }, sprite: { x: 0x200, y: 0x80 }, slot: 3 }) // prettier-ignore
  it('is 1 with Mario left of the sprite, 0 right of it, 0 on a tie', () => {
    expect([at(40, 0x1f0), at(40, 0x210), at(40, 0x200)]).toEqual([1, 0, 0])
  })
  it('compares the 16-bit X, so the high byte decides across a screen', () => {
    expect([at(40, 0x0ff), at(40, 0x300)]).toEqual([1, 0])
  })
  it('leaves a constant-facing INIT unchanged on both sides', () => {
    expect([at(41, 0x1f0), at(41, 0x210)]).toEqual([1, 1])
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
    interpDrawer(blank, 0x104, { isVertical: false, screenCount: 2 }, run as never, () =>
      withSeed({ loaded }),
    )(sprite)
    expect(seen).toMatchObject({ x: 0x1234, y: 0x0567 })
    expect(readMarioStartPos(blank, 0x104)).not.toMatchObject({ x: 0x1234, y: 0x0567 })
  })
})

describe.skipIf(!hasRom(VANILLA))(
  'the map view seed is the entrance-table start on every vanilla map (#272)',
  () => {
    // The seed is the loader image's $94/$96 (interpDrawer); readMarioStartPos is the table
    // derivation the same code falls back to. Both include the CODE_00A635 entrance nudge.
    it('loader $94/$96 equals readMarioStartPos for all 512 maps', () => {
      const rom = freshRom()
      const bad: string[] = []
      let loaded = 0
      for (let map = 0; map < 0x200; map++) {
        const l = loadLevelState(rom, map)
        if (!l.ok) continue
        loaded++
        const seed = {
          x: l.wram[0x94]! | (l.wram[0x95]! << 8),
          y: l.wram[0x96]! | (l.wram[0x97]! << 8),
        }
        const want = readMarioStartPos(rom, map)
        if (!want || want.x !== seed.x || want.y !== seed.y) bad.push(map.toString(16))
      }
      expect(bad).toEqual([])
      expect(loaded).toBe(0x200)
    })
  },
)

/** map:slot:id of every capture record whose marioAtInit differs from marioStart: INIT saw another Mario than we seed, so facing is not comparable (236 records, 106 maps, one capture set; the issue's 62 / 34 was an earlier count). A repeated key is two records. */
const EXCLUDED = `
    001:8:$09 001:9:$09 002:8:$42 002:9:$42 004:6:$b9 005:7:$a3 006:9:$07 007:5:$9e 007:6:$27
    007:7:$27 008:5:$05 008:6:$05 008:7:$3e 008:8:$02 008:9:$05 009:9:$11 00a:9:$3d 00b:7:$9e
    00c:9:$8f 00d:2:$06 00d:7:$05 00d:7:$06 00d:8:$04 00d:9:$05 00d:9:$72 00f:5:$63 010:3:$05
    010:4:$4d 010:5:$bd 010:6:$4d 011:9:$c2 014:9:$3e 01a:7:$2f 01a:8:$2f 01a:9:$30 01b:8:$ac
    01b:9:$ad 01c:7:$13 01c:8:$13 01c:9:$04 01c:9:$13 021:4:$39 021:4:$39 021:5:$52 022:9:$6e
    023:7:$a3 024:6:$6e 024:7:$2f 024:8:$6f 024:9:$b9 093:6:$29 093:7:$b6 094:5:$b6 094:6:$29
    094:7:$b6 0be:9:$c3 0bf:9:$57 0c0:7:$9d 0c3:8:$49 0c3:9:$49 0c4:8:$7b 0c4:9:$8d 0c6:9:$7b
    0cb:9:$7b 0cd:9:$3e 0ce:7:$9d 0cf:9:$77 0d0:7:$6f 0d2:6:$0a 0d2:7:$0a 0d2:8:$0a 0d2:9:$0a
    0d3:5:$b6 0d3:6:$29 0d3:7:$b6 0d4:9:$a5 0d6:9:$b4 0d7:5:$55 0d7:7:$5f 0d8:9:$3e 0db:9:$24
    101:6:$24 101:7:$b9 102:4:$05 102:7:$47 102:8:$47 102:9:$47 103:5:$b9 104:4:$b9 104:5:$8c
    104:6:$8a 104:7:$8a 104:8:$8a 104:9:$8a 105:3:$05 105:7:$bd 106:8:$05 106:9:$04 106:9:$05
    109:8:$6c 109:9:$0b 10a:9:$05 10a:9:$61 10b:9:$04 10e:9:$c6 10f:8:$46 10f:9:$48 110:6:$b1
    110:7:$b1 113:5:$09 113:6:$09 113:7:$09 115:7:$07 115:9:$be 116:9:$bf 117:8:$2f 117:9:$a8
    11a:6:$06 11a:6:$06 11a:7:$05 11a:8:$04 11a:9:$2e 11b:5:$05 11b:6:$04 11b:7:$03 11b:8:$07
    11b:9:$3e 11c:8:$1f 11d:0:$28 11d:2:$39 11e:2:$86 11f:3:$06 11f:4:$05 11f:6:$09 11f:7:$05
    11f:7:$1e 120:8:$3b 120:9:$c2 121:5:$13 121:6:$13 121:7:$3e 121:8:$13 121:9:$3e 122:8:$c1
    122:9:$c1 123:2:$05 123:7:$9d 125:5:$50 125:6:$9a 126:2:$86 127:8:$9c 127:9:$16 12a:6:$6c
    12a:7:$b9 12a:8:$6b 12a:9:$64 12b:9:$95 12c:5:$63 12d:4:$04 12d:4:$07 12d:5:$07 12d:6:$03
    12d:6:$04 12d:6:$05 12d:6:$05 12d:7:$06 12d:7:$07 130:5:$c2 130:6:$c2 130:7:$c2 130:8:$2c
    130:9:$76 132:5:$1e 132:6:$3e 132:7:$2c 134:9:$74 135:2:$04 135:3:$05 135:7:$2c 136:6:$c4
    136:7:$08 136:8:$c4 136:9:$c4 193:5:$b6 193:6:$29 193:7:$b6 194:6:$29 194:7:$b6 1bd:9:$c6
    1be:9:$70 1bf:7:$15 1bf:8:$15 1bf:9:$2e 1c0:9:$c4 1c1:6:$c2 1c1:7:$c2 1c2:8:$11 1c2:9:$11
    1c3:9:$11 1c4:2:$3e 1c4:3:$3e 1c4:4:$78 1c4:5:$3e 1c4:6:$78 1c4:7:$78 1c5:5:$3e 1c6:8:$c4
    1c6:9:$c4 1ca:7:$84 1ca:8:$84 1ca:9:$84 1cc:9:$93 1cd:6:$bc 1cd:7:$bc 1cd:8:$bc 1ce:7:$32
    1cf:7:$26 1cf:8:$26 1cf:9:$26 1d1:3:$bb 1d1:4:$bb 1d1:6:$bb 1d1:7:$a5 1d1:8:$a5 1d1:9:$a5
    1d2:7:$a2 1d2:8:$a2 1d4:6:$33 1d4:7:$33 1d5:9:$7b 1d6:9:$7b 1d9:1:$90 1da:8:$7b 1da:9:$8d
    1db:7:$37 1db:9:$37
`
  .trim()
  .split(/\s+/)

/** Included records where our INIT facing differs from the capture's, as map:slot:id:capture>ours. Not fixed here (#272 is tests only); a fix or a new mismatch must change this list. */
const KNOWN_MISMATCHES = `
    11e:0:$04:0>1 11e:3:$04:0>1 11e:3:$0f:0>1 11e:4:$04:0>1 11e:6:$00:0>1 11e:6:$04:0>1
    11e:7:$0f:0>1 11e:8:$0f:0>1 11f:6:$1e:1>0 126:7:$0f:0>1 1c4:4:$1e:1>0 1c5:4:$1e:1>0
`
  .trim()
  .split(/\s+/)

describe('the facing comparison reports a flipped capture (planted defect)', () => {
  const rom = facingRom()
  const rec = (initFacing: number): Loaded => ({ map: '001', wram: null, marioStart: { x: 0x1f0, y: 0x80 }, rec: { id: '$28', slot: 3, listX: 0x200, listY: 0x80, cameraX: 0, cameraY: 0, initFacing } }) // prettier-ignore
  it('is silent for the true facing (Mario left of the sprite: 1) and names the record when flipped', () => {
    expect(facingMismatches(rom, [rec(1)], () => undefined)).toEqual([])
    expect(facingMismatches(rom, [rec(0)], () => undefined)).toEqual([
      { key: '001:3:$28', capture: 0, ours: 1 },
    ])
  })
})

describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'INIT facing vs level-load captures (#272)',
  () => {
    const all: Loaded[] = hasCaptures() && hasRom(VANILLA) ? loadCaptures() : []
    const withFacing = all.filter(r => r.rec.initFacing !== undefined)
    const same = (r: Loaded) => !!r.marioStart && r.rec.marioAtInit?.x === r.marioStart.x && r.rec.marioAtInit?.y === r.marioStart.y // prettier-ignore
    const rom = hasRom(VANILLA) ? freshRom() : facingRom() // the skipIf body still runs without a cart
    const loadedBy = new Map<string, Uint8Array | undefined>()
    const loadedFor = (m: string) => {
      if (!loadedBy.has(m)) {
        const l = loadLevelState(rom, parseInt(m, 16))
        loadedBy.set(m, l.ok ? l.wram : undefined)
      }
      return loadedBy.get(m)
    }
    const key = (r: Loaded) => `${r.map}:${r.rec.slot}:${r.rec.id}`.toLowerCase()
    const included = withFacing.filter(same)

    it('names every excluded record (marioAtInit differs from marioStart), by exact list', () => {
      expect(withFacing.length).toBe(2262)
      expect(
        withFacing
          .filter(r => !same(r))
          .map(key)
          .sort(),
      ).toEqual([...EXCLUDED].sort())
      expect(new Set(EXCLUDED.map(k => k.split(':')[0])).size).toBe(106)
    })

    it('matches the capture on every other record except the named known mismatches', () => {
      expect(included.length).toBe(2026)
      const got = facingMismatches(rom, included, loadedFor).map(m =>
        `${m.key}:${m.capture}>${m.ours}`.toLowerCase(),
      )
      expect(got.sort()).toEqual([...KNOWN_MISMATCHES].sort())
    })

    it('goes red when a capture record is flipped (corpus plant)', () => {
      const r = included.find(x => !KNOWN_MISMATCHES.some(k => k.startsWith(key(x) + ':')))!
      const flipped = { ...r, rec: { ...r.rec, initFacing: 1 - r.rec.initFacing! } }
      expect(facingMismatches(rom, [flipped], loadedFor).map(m => m.key.toLowerCase())).toEqual([
        key(r),
      ])
    })
  },
)
