/**
 * Block content indicators on the map (#566 PR B): the pick, the per-plane
 * painting and hover choice with synthetic data, then `mapBlockContents` over
 * vanilla maps (corpus only). Maps and cells: $123 (FoI3) has a $11B at column
 * 77 row 20 and $11C at column 79 row 18; $105 (YI1) a $11F at column 243 row
 * 17 and a $11A at column 209 row 15 (column 1 of 3); $125 (Funky) a $111 at
 * column 117 row 15 and a $11D at column 86 row 20; $11E (FoI1) a $125 at
 * columns 250 and 224 (rows 21, 22); $001 (VS2) a $11D at column 231 row 18.
 */
import { describe, it, expect } from 'vitest'
import type { BlockContents } from '../../../src/rom/BlockContents'
import { RomFile } from '../../../src/rom/RomFile'
import {
  pickIndicator,
  mapBlockContents,
} from '../../../theia/extension/src/node/map-block-contents'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import {
  decodeArts,
  hoverTarget,
  paintPlaneIndicators,
  type Indicator,
} from '../../../theia/extension/src/browser/map-view-model'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const sprite = (id: number) => ({ kind: 'sprite' as const, sprite: id, status: 8, label: '' })
const contents = (
  alts: [string | null, ReturnType<typeof sprite>][],
  progressive = false,
): BlockContents =>
  ({
    alternatives: alts.map(([when, content]) => ({ when, content })),
    spriteIds: [],
    progressive: progressive ? { small: 1, big: 2 } : null,
    multiCoin: false,
    condition: '',
  }) as BlockContents

describe('pickIndicator', () => {
  it('draws a single content, splits a progressive pair, and leaves state-dependent blocks undrawn', () => {
    expect(pickIndicator(contents([[null, sprite(5)]]))).toEqual({
      kind: 'item',
      content: sprite(5),
    })
    expect(
      pickIndicator(
        contents(
          [
            ['Mario is small', sprite(1)],
            [null, sprite(2)],
          ],
          true,
        ),
      ),
    ).toEqual({ kind: 'split', small: sprite(1), big: sprite(2) })
    // star-or-coin, coin-or-1-up: #623
    expect(
      pickIndicator(
        contents([
          ['Mario is invincible', sprite(3)],
          [null, sprite(4)],
        ]),
      ),
    ).toBeNull()
    expect(pickIndicator(contents([]))).toBeNull()
  })
})

const A = (id: string, x: number, y: number, plane: Indicator['plane'] = 'l1Low'): Indicator => ({ plane, x, y, art: id }) // prettier-ignore
const fill = (v: number, n: number) => new Uint8ClampedArray(n * n * 4).fill(v)

describe('hoverTarget', () => {
  const list = [A('a', 32, 32), A('b', 32, 32, 'l2Low'), A('c', 64, 32)]
  const all = () => true
  const rank = (p: Indicator['plane']) => (p === 'l2Low' ? 1 : 2)
  it('finds the block under the pointer, and nothing between blocks', () => {
    expect(hoverTarget(list, 70, 40, all, rank)?.art).toBe('c')
    expect(hoverTarget(list, 50, 40, all, rank)).toBeNull()
    expect(hoverTarget(list, 80, 40, all, rank)).toBeNull()
  })
  it('takes the nearer plane and skips a hidden one', () => {
    expect(hoverTarget(list, 40, 40, all, rank)?.art).toBe('a')
    expect(hoverTarget(list, 40, 40, p => p !== 'l1Low', rank)?.art).toBe('b')
  })
})

describe('paintPlaneIndicators', () => {
  const g = { orientation: 'horizontal' as const, width: 64, height: 64 }
  const arts = decodeArts({ a: Buffer.from(fill(200, 16)).toString('base64') })
  const list = [A('a', 16, 16), A('a', 80, 16), A('a', 16, 16, 'l2Low')]
  it('paints only its plane, on its screen, at rest then on hover', () => {
    const data = new Uint8ClampedArray(64 * 64 * 4)
    const rest = paintPlaneIndicators(data, 'l1Low', 0, g, list, arts, undefined)
    expect(rest).toEqual([{ id: 'l1Low:16:16', hover: false, box: { x0: 24, y0: 24, x1: 32, y1: 32 } }]) // prettier-ignore
    const hov = new Uint8ClampedArray(64 * 64 * 4)
    const r2 = paintPlaneIndicators(hov, 'l1Low', 0, g, list, arts, 'l1Low:16:16')
    expect(r2[0]!.box).toEqual({ x0: 16, y0: 16, x1: 32, y1: 32 })
    expect(paintPlaneIndicators(new Uint8ClampedArray(64 * 64 * 4), 'l1Low', 1, g, list, arts, undefined)).toHaveLength(1) // prettier-ignore
  })
})

describe.skipIf(!hasRom(VANILLA))('mapBlockContents on the vanilla ROM', () => {
  const run = (index: number) => {
    const bytes = new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)
    const r = mapBlockContents(new L1ModelCache(), bytes, romPath(VANILLA), index)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    return r
  }
  const at = (r: ReturnType<typeof run>, col: number, row: number) =>
    r.indicators.filter(i => i.x === col * 16 && i.y === row * 16)

  it('gives a multi-coin block ($11B) another picture than a single-coin one ($11C)', () => {
    const r = run(0x123)
    const [multi, single] = [at(r, 77, 20), at(r, 79, 18)]
    expect([multi.length, single.length]).toEqual([1, 1])
    expect(r.arts[multi[0]!.art]).not.toBe(r.arts[single[0]!.art])
  })

  it('splits a progressive block into two different items and leaves $11A column 0 of 3 out', () => {
    const r = run(0x105)
    const [prog] = at(r, 243, 17)
    expect(prog).toBeDefined()
    const art = new Uint8ClampedArray(Buffer.from(r.arts[prog!.art]!, 'base64'))
    const colour = (x: number, y: number) => art.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4).join() // prettier-ignore
    const below = new Set<string>()
    const above = new Set<string>()
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (art[(y * 16 + x) * 4 + 3]) (y > x ? below : above).add(colour(x, y)) // prettier-ignore
    expect(below.size).toBeGreaterThan(0)
    expect(above.size).toBeGreaterThan(0)
    expect([...below].join('|')).not.toBe([...above].join('|'))
    expect(at(r, 209, 15)).toHaveLength(1) // $11A at column 1 of 3: the 1-up
  })

  it('shows each cell the item of its own column ($125 key vs balloon, $11D blue vs silver)', () => {
    const f = run(0x11e)
    const [key, balloon] = [at(f, 224, 22), at(f, 250, 21)]
    expect(f.arts[key[0]!.art]).not.toBe(f.arts[balloon[0]!.art])
    const blue = run(0x125)
    const silver = run(0x001)
    expect(blue.arts[at(blue, 86, 20)[0]!.art]).not.toBe(silver.arts[at(silver, 231, 18)[0]!.art])
  })
})
