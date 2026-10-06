/**
 * Block content indicators on the map (#566 PR B), server side and view model,
 * with NO ROM: made-up tables, a stub art source, a hand-built model, and a
 * synthetic cart for the code gates. The corpus block at the end runs
 * `mapBlockContents` over vanilla maps. Maps and cells: $123 (FoI3) has a $11B
 * at column 77 row 20 and $11C at column 79 row 18; $105 (YI1) a $11F at
 * column 243 row 17 and a $11A at column 209 row 15 (column 1 of 3); $11E
 * (FoI1) a $125 at columns 250 and 224 (rows 21, 22); $125 (Funky) a $11D at
 * column 86 row 20; $001 (VS2) a $11D at column 231 row 18.
 */
import { describe, it, expect } from 'vitest'
import {
  FIRST_ITEM_BLOCK,
  readBlockContentTables,
  resolveBlockContents,
  type BlockContentTables,
  type BlockContents,
} from '../../../src/rom/BlockContents'
import { RomFile } from '../../../src/rom/RomFile'
import {
  blockIndicators,
  mapBlockContents,
  romArt,
  pickIndicator,
  plainWhy,
  readCoinParts,
  contentIndex,
  spawnInputs,
  type Drawn,
  type IndicatorModel,
  type ItemArt,
} from '../../../theia/extension/src/node/map-block-contents'
import { drawSprites, interpDrawer } from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import {
  decodeArts,
  hoverTarget,
  composeIndicatorScreen,
  indicatorsTouch,
  paintScreenIndicators,
  scaleNearest,
  type Indicator,
} from '../../../theia/extension/src/browser/map-view-model'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { COLORS, hGrid, sub, tile, vGrid } from '../support/mapInputs'

// ---- made-up tables: every tile $111-$12D holds a coin unless ASSIGN says otherwise ----
const ASSIGN: Record<number, number> = {
  0x111: 0x80, // column lookup, first half: even columns coin, odd multi-coin
  0x113: 0x05, // progressive content 2: sprite $41 if small, otherwise sprite $42
  0x117: 0x07, // progressive content 3, the star: sprite $43 if invincible, otherwise coin
  0x118: 0xff, // the green star counter block: coin until 7 coins, then sprite $47
  0x114: 0x1c, // content 14: the P-switch sprite
  0x115: 0x06, // plain content 3: sprite $43
}
const SELECTOR = Array.from({ length: 36 }, (_, i) => ASSIGN[FIRST_ITEM_BLOCK + i] ?? 0x0c)
const CYCLE = Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 0x0c : 0x0e))
const COPY = [0, 0x41, 0x42, 0x43, 0x46, 0x47, 0, 0, 0x48, 0x2c, 0x57, 0x58, 0x59, 0x51, 0x3e, 0x52, 0x7d] // prettier-ignore
const pad = (a: number[], n: number) => Uint8Array.from([...a, ...new Array(n - a.length).fill(0)])
const TABLES: BlockContentTables = {
  selector: Uint8Array.from(SELECTOR),
  columnCycle: Uint8Array.from(CYCLE),
  spriteInBlock: pad([...COPY, ...COPY], 0xa0),
  statusOfSprInBlk: pad(
    COPY.map((_, i) => (i === 14 ? 9 : 8)),
    0x80,
  ),
  columnOverride: Uint8Array.from([0x61, 0x62, 0x63, 0x64]),
  columnOverrideStatus: Uint8Array.from([0x0a, 0x0b, 0x0c, 0x0d]),
  pSwitchAttribute: Uint8Array.from([0x06, 0x02]),
  eggContents: Uint8Array.from([0x53, 0x54]),
  greenStarCoins: 7,
}

type Rgba = [number, number, number, number]
const solid = (c: Rgba) => {
  const a = new Uint8ClampedArray(16 * 16 * 4)
  for (let i = 0; i < 256; i++) a.set(c, i * 4)
  return a
}
const COIN: Rgba = [200, 160, 0, 255]
const MULTI: Rgba = [201, 161, 1, 255]
const spriteColour = (id: number): Rgba => [id, 9, 9, 255]

/** A stub art source that records what it was asked to draw. */
function stubArt(fail: Record<number, string> = {}) {
  const calls: string[] = []
  const art: ItemArt = {
    coin: (multi): Drawn => (calls.push(multi ? 'multi' : 'coin'), { art: solid(multi ? MULTI : COIN) }), // prettier-ignore
    sprite: (c, col, row): Drawn => {
      calls.push(`s${c.sprite.toString(16)}:${c.status}:${c.attribute ?? ''}@${col},${row}`)
      return fail[c.sprite] ? { why: fail[c.sprite]! } : { art: solid(spriteColour(c.sprite)) }
    },
  }
  return { art, calls }
}

const tiles = (priority: boolean) => {
  const t: ReturnType<typeof tile>[] = []
  for (let id = 0x100; id <= 0x130; id++) t[id] = tile(id, [sub(0), sub(0), sub(0), sub(0, 0, priority)]) // prettier-ignore
  return t
}
const model = (
  cells: [number, number, number][], // [col, row, id]
  opts: { priority?: boolean; l2?: IndicatorModel['l2']; vertical?: boolean } = {},
): IndicatorModel => {
  const grid = opts.vertical ? vGrid(2) : hGrid(2)
  for (const [c, r, id] of cells) grid[r]![c] = id
  return {
    grid,
    map16: { tiles: tiles(!!opts.priority), pipeVariants: [] },
    l2: opts.l2,
    isVertical: !!opts.vertical,
    screenCount: 2,
  }
}
const ok = (r: ReturnType<typeof blockIndicators>) => {
  if (r.status !== 'ok') throw new Error(JSON.stringify(r))
  return r
}
const at = (a: Uint8ClampedArray, x: number, y: number) => Array.from(a.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)) // prettier-ignore
const unb = (s: string) => new Uint8ClampedArray(Buffer.from(s, 'base64'))

describe('blockIndicators: placement', () => {
  it('puts each block in the plane its bottom-right subtile priority picks', () => {
    for (const [priority, plane] of [
      [false, 'l1Low'],
      [true, 'l1High'],
    ] as const) {
      const r = ok(blockIndicators(model([[3, 5, 0x11c]], { priority }), TABLES, stubArt().art))
      expect(r.indicators).toEqual([{ plane, x: 48, y: 80, art: 'coin' }])
    }
  })

  it('draws exactly the item-block range $111-$12D', () => {
    const cells: [number, number, number][] = [0x110, 0x111, 0x12d, 0x12e].map((id, i) => [i, 0, id]) // prettier-ignore
    const r = ok(blockIndicators(model(cells), TABLES, stubArt().art))
    expect(r.indicators.map(i => i.x / 16)).toEqual([1, 2])
  })

  it('hands the resolver the map column of the cell, not a screen-local one', () => {
    const { art, calls } = stubArt()
    const r = ok(blockIndicators(model([[17, 0, 0x111], [18, 0, 0x111], [20, 1, 0x111]]), TABLES, art)) // prettier-ignore
    // The first-half cycle alternates by column: odd columns are multi-coin.
    expect(r.indicators.map(i => i.art)).toEqual(['multiCoin', 'coin', 'coin'])
    for (const col of [17, 18, 20]) {
      const want = resolveBlockContents(0x111, col, TABLES)
      expect(want && 'multiCoin' in want && want.multiCoin).toBe(col % 2 === 1)
    }
    expect(calls.sort()).toEqual(['coin', 'multi'])
  })

  it('puts layer 2 blocks in their own planes at 16 * row + dy, wrapped in 512 px', () => {
    const l2 = (kind: 'objects' | 'image', dy: number, cells: [number, number][]) => {
      const grid = hGrid(2).map(r => r.map(() => null as number | null))
      for (const [c, rr] of cells) grid[rr]![c] = 0x11c
      return { ok: true as const, l2: { kind, grid, tiles: tiles(true), dy } }
    }
    const run = (m: ReturnType<typeof l2>, vertical = false) =>
      ok(blockIndicators(model([], { l2: m, vertical }), TABLES, stubArt().art)).indicators.map(i => [i.plane, i.x, i.y]) // prettier-ignore
    expect(run(l2('objects', 5, [[2, 3]]))).toEqual([['l2High', 32, 53]])
    // Row 0 with dy 500: 500 is past the map (432); the copy 512 up is -12, still touching it.
    expect(run(l2('objects', 500, [[0, 0]]))).toEqual([['l2High', 0, -12]])
    // Row 26 with dy 500: 916 mod 512 = 404 is on the map.
    expect(run(l2('objects', 500, [[0, 26]]))).toEqual([['l2High', 0, 404]])
    // Row 30 does not exist on a 27-row map; row 24 with dy 500: 884 mod 512 = 372, copy -140 is clear.
    expect(run(l2('objects', 500, [[0, 24]]))).toEqual([['l2High', 0, 372]])
    expect(run(l2('image', 0, [[2, 3]]))).toEqual([])
    // Vertical object maps are streamed: no wrap, the row is where dy puts it.
    expect(run(l2('objects', -16, [[0, 5]]), true)).toEqual([['l2High', 0, 64]])
  })
})

describe('blockIndicators: what is drawn', () => {
  it('splits a progressive block: small item bottom-left, big item top-right, black on the diagonal', () => {
    const r = ok(blockIndicators(model([[0, 0, 0x113]]), TABLES, stubArt().art))
    const a = unb(r.arts[r.indicators[0]!.art]!)
    expect(at(a, 0, 15)).toEqual(spriteColour(0x41))
    expect(at(a, 15, 0)).toEqual(spriteColour(0x42))
    for (let d = 0; d < 16; d++) expect(at(a, d, d)).toEqual([0, 0, 0, 255])
  })

  it('draws star-or-coin ($11A column 0, $122) and coin-or-1-up ($12D) as coin bottom-left, the other item top-right', () => {
    const r = ok(
      blockIndicators(
        model([
          [0, 0, 0x117],
          [1, 0, 0x118],
        ]),
        TABLES,
        stubArt().art,
      ),
    )
    expect(r.note).toBeUndefined()
    expect(r.indicators).toHaveLength(2)
    const [star, oneUp] = r.indicators.map(i => unb(r.arts[i.art]!))
    expect([at(star!, 0, 15), at(star!, 15, 0)]).toEqual([COIN, spriteColour(0x43)])
    expect([at(oneUp!, 0, 15), at(oneUp!, 15, 0)]).toEqual([COIN, spriteColour(0x47)])
    for (const a of [star!, oneUp!]) for (let d = 0; d < 16; d++) expect(at(a, d, d)).toEqual([0, 0, 0, 255]) // prettier-ignore
  })

  it('leaves a Yoshi-loose variant undrawn and says so in plain words', () => {
    const t = { ...TABLES, spriteInBlock: pad([...COPY, ...COPY.map(v => (v === 0x43 ? 0x44 : v))], 0xa0) } // prettier-ignore
    const r = ok(blockIndicators(model([[0, 0, 0x115]]), t, stubArt().art))
    expect(r.indicators).toEqual([])
    expect(r.note).toBe('Block contents not shown: 1 block whose item changes when Yoshi is loose.')
  })

  it('draws one art per distinct item, asks the sprite for the cell it first meets, and keys the P-switch by attribute', () => {
    const { art, calls } = stubArt()
    const r = ok(
      blockIndicators(
        model([
          [3, 2, 0x114],
          [5, 4, 0x114],
        ]),
        TABLES,
        art,
      ),
    )
    expect(calls).toEqual(['s3e:9:2@3,2'])
    expect(new Set(r.indicators.map(i => i.art)).size).toBe(1)
    const key = r.indicators[0]!.art
    expect(key).toBe('s3e:9:2')
    // An odd column gives the other colour, so another key (DATA_028A42 by column parity).
    const odd = ok(
      blockIndicators(
        model([
          [3, 2, 0x114],
          [4, 2, 0x114],
        ]),
        TABLES,
        stubArt().art,
      ),
    )
    expect(new Set(odd.indicators.map(i => i.art)).size).toBe(2)
    expect(odd.indicators.map(i => i.art)).toEqual(['s3e:9:2', 's3e:9:6'])
  })

  it('surfaces a table refusal, a per-block refusal and a drawing refusal, never as raw keys', () => {
    const reason = 'DATA_00F080 (36 bytes at $00F080) runs past the end of this ROM'
    expect(blockIndicators(model([]), { kind: 'unavailable', unavailable: reason }, stubArt().art)).toEqual({ status: 'unavailable', reason }) // prettier-ignore
    const short = { ...TABLES, statusOfSprInBlk: new Uint8Array(0) }
    const refused = ok(blockIndicators(model([[0, 0, 0x115]]), short, stubArt().art))
    expect(refused.indicators).toEqual([])
    expect(refused.note).toMatch(/^Block contents not shown: 1 block .*past the end/)
    const drew = ok(blockIndicators(model([[0, 0, 0x115], [1, 0, 0x115]]), TABLES, stubArt({ 0x43: 'charsNotLoaded' }).art)) // prettier-ignore
    expect(drew.indicators).toEqual([])
    expect(drew.note).toBe('Block contents not shown: 2 blocks whose graphics are not loaded in this level.') // prettier-ignore
    expect(plainWhy('refused: step budget spent')).toBe('whose sprite code was refused (step budget spent)') // prettier-ignore
    expect(plainWhy('drew no OAM tile in 64 passes')).toBe('whose item draws nothing in its first frames') // prettier-ignore
  })
})

describe('pickIndicator', () => {
  const sprite = (id: number) => ({ kind: 'sprite' as const, sprite: id, status: 8, label: '' })
  const coin = { kind: 'coin' as const, label: 'Coin' }
  const c = (alts: [string | null, object][], progressive = false) =>
    ({ alternatives: alts.map(([when, content]) => ({ when, content })), spriteIds: [], progressive: progressive ? { small: 1, big: 2 } : null, multiCoin: false, condition: '' }) as unknown as BlockContents // prettier-ignore
  it('draws one content, splits a progressive pair, splits a coin pair, ignores an empty side', () => {
    expect(pickIndicator(c([[null, sprite(5)]]))).toEqual({ kind: 'item', content: sprite(5) })
    expect(pickIndicator(c([['Mario is small', sprite(1)], [null, sprite(2)]], true))).toEqual({ kind: 'split', small: sprite(1), big: sprite(2) }) // prettier-ignore
    // $11A column 0 of 3 and $122: star if invincible, otherwise coin. $12D: coin, then 1-up.
    expect(pickIndicator(c([['Mario is invincible', sprite(3)], [null, coin]]))).toEqual({ kind: 'split', small: coin, big: sprite(3) }) // prettier-ignore
    expect(pickIndicator(c([['fewer than 30 coins are collected', coin], [null, sprite(4)]]))).toEqual({ kind: 'split', small: coin, big: sprite(4) }) // prettier-ignore
    const none = { kind: 'none', label: 'nothing' }
    expect(pickIndicator(c([['Mario is small', none], [null, sprite(2)]]))).toEqual({ kind: 'item', content: sprite(2) }) // prettier-ignore
    expect(pickIndicator(c([]))).toBeNull()
  })
  it('leaves other pairs undrawn with a reason', () => {
    expect(pickIndicator(c([['Yoshi is loose', sprite(1)], [null, sprite(2)]]))).toMatchObject({ kind: 'undrawn', why: 'whose item changes when Yoshi is loose' }) // prettier-ignore
    expect(pickIndicator(c([['x', sprite(1)], [null, sprite(2)]]))).toMatchObject({ kind: 'undrawn' }) // prettier-ignore
  })
})

// ---- the spawn and the code gates, on a synthetic cart ----
const sp = (sprite: number, status: number, extra: object = {}) => ({ kind: 'sprite' as const, sprite, status, label: '', ...extra }) // prettier-ignore

describe('the spawn inputs', () => {
  it('finds the SpriteInBlock index of an item by sprite and status, and the balloon family by position', () => {
    expect(contentIndex(sp(0x41, 8), TABLES)).toBe(1)
    expect(contentIndex(sp(0x3e, 9), TABLES)).toBe(14)
    expect(contentIndex(sp(0x3e, 8), TABLES)).toBeNull() // right sprite, status the table does not give
    expect(contentIndex(sp(0x80, 9, { position: 'X column 1 of 4' }), TABLES)).toBe(0x0b)
    expect(contentIndex(sp(0x55, 8), TABLES)).toBeNull()
  })
  it('seeds only what GenSpriteFromBlk reads: the index, the block position and cleared flags', () => {
    expect(spawnInputs(14, 0x1234, 0x0150)).toEqual({
      0x05: 14,
      0x9a: 0x34,
      0x9b: 0x12,
      0x98: 0x50,
      0x99: 0x01,
      0x1933: 0,
      0x18e2: 0,
      0x1432: 0,
    })
    // A layer 2 block above the screen top clamps to 0 rather than writing a negative byte.
    expect(spawnInputs(1, 32, -12)[0x98]).toBe(0)
  })
})

const COIN_SITE = [0xa9, 0x44, 0x99, 0x02, 0x03, 0xa9, 0x06, 0x05, 0x64, 0x99, 0x03, 0x03, 0x98, 0x4a, 0x4a, 0xa8, 0xa9, 0x02, 0x99] // prettier-ignore
const GREEN_STAR = [0xd0, 0x05, 0xa9, 0x1e, 0x8d, 0xc0, 0x0d]

/** A 512 KB LoROM of zeros with the made-up tables and the given byte runs planted. */
function cartBytes(opts: { coin?: number[]; twice?: boolean } = {}) {
  const b = new Uint8Array(0x80000)
  b[0x7fd5] = 0x20
  b.set(TABLES.selector, 0x7080)
  b.set(TABLES.columnCycle, 0x7100)
  b.set(TABLES.spriteInBlock, 0x108a3)
  b.set(TABLES.statusOfSprInBlk, 0x108c5)
  b.set(TABLES.columnOverride, 0x108d6)
  b.set(TABLES.columnOverrideStatus, 0x108d9)
  b.set(TABLES.pSwitchAttribute, 0x10a42)
  b.set(TABLES.eggContents, 0x108a1)
  b.set(GREEN_STAR, 0x20000)
  b.set(opts.coin ?? COIN_SITE, 0x30000)
  if (opts.twice) b.set(opts.coin ?? COIN_SITE, 0x32000)
  return b
}
const cart = (o: Parameters<typeof cartBytes>[0] = {}) => RomFile.fromBytes('synthetic.sfc', cartBytes(o)) // prettier-ignore

describe('the code gates', () => {
  it('reads the coin chars from their immediates', () => {
    const c = readCoinParts(cart())
    expect(c.ok && c.parts.map(p => [p.charNum, p.palette, p.dx, p.dy])).toEqual([[0x444, 11, 0, 0], [0x445, 11, 8, 0], [0x454, 11, 0, 8], [0x455, 11, 8, 8]]) // prettier-ignore
  })
  it('refuses a changed opcode and two sites, with the reason', () => {
    const bad = [...COIN_SITE]
    bad[2] = 0x9d // STA abs,X instead of STA abs,Y: the draw is not the one traced
    const r = readCoinParts(cart({ coin: bad }))
    expect(!r.ok && r.reason).toContain('is not present on this ROM')
    const two = readCoinParts(cart({ twice: true }))
    expect(!two.ok && two.reason).toContain('more than once')
  })
})

describe('mapBlockContents on a synthetic cart', () => {
  const build = (grid: number[][]) =>
    new L1ModelCache(
      () =>
        ({
          ok: true,
          inputs: { ...model([]), grid, vram: { sp1: Array.from({ length: 256 }, () => new Uint8Array(64).fill(1)) }, colors: COLORS }, // prettier-ignore
        }) as never,
    )

  it('draws a coin and a multi-coin from the cart, and the multi differs by its "+"', () => {
    const grid = hGrid(2)
    grid[4]![2] = 0x11c
    grid[4]![3] = 0x111 // column lookup: column 3 is odd, so multi-coin
    const r = mapBlockContents(build(grid), cartBytes(), 'a.sfc', 1)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.indicators.map(i => [i.plane, i.x, i.y, i.art])).toEqual([['l1Low', 32, 64, 'coin'], ['l1Low', 48, 64, 'multiCoin']]) // prettier-ignore
    const [coin, multi] = [unb(r.arts.coin!), unb(r.arts.multiCoin!)]
    expect(coin.some((v, i) => v !== multi[i])).toBe(true)
    expect(at(multi, 12, 12)).toEqual([255, 255, 255, 255])
    expect(at(coin, 12, 12)).not.toEqual([255, 255, 255, 255])
  })

  it('reports a ROM too short for its tables, and keeps one reply per bytes and map', () => {
    const short = new Uint8Array(0x8000)
    short[0x7fd5] = 0x20
    expect(mapBlockContents(build(hGrid(1)), short, 's.sfc', 1)).toMatchObject({ status: 'unavailable' }) // prettier-ignore
    const b = cartBytes()
    const cache = build(hGrid(1))
    expect(mapBlockContents(cache, b, 'a.sfc', 2)).toBe(mapBlockContents(cache, b, 'a.sfc', 2))
  })

  it('names the coin gate in the note when the coin draw is not the traced one', () => {
    const grid = hGrid(1)
    grid[0]![0] = 0x11c
    const bad = [...COIN_SITE]
    bad[17] = 0x00
    const r = mapBlockContents(build(grid), cartBytes({ coin: bad }), 'b.sfc', 3)
    expect(r.status === 'ok' && r.indicators).toEqual([])
    expect(r.status === 'ok' && r.note).toContain('the coin sprite draw (bank_02.asm:3432-3441)')
  })
})

// ---- the view model ----
const A = (id: string, x: number, y: number, plane: Indicator['plane'] = 'l1Low'): Indicator => ({ plane, x, y, art: id }) // prettier-ignore

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

describe('composeIndicatorScreen: indicators draw in the layer pass of their block', () => {
  const g = { orientation: 'horizontal' as const, width: 32, height: 32 }
  const arts = decodeArts({ a: Buffer.from(solid([200, 0, 0, 255])).toString('base64') })
  const native = (cells: [number, number][], rgb: [number, number, number]) => {
    const d = new Uint8ClampedArray(32 * 32 * 4)
    for (const [x, y] of cells) d.set([...rgb, 255], (y * 32 + x) * 4)
    return d
  }
  const lists = { main: ['l2Low', 'l1Low'] as const, sub: [] as const }
  const run = (planes: Record<string, Uint8ClampedArray | null>, ind: Indicator[], zoom = 2, hoverId?: string) => // prettier-ignore
    composeIndicatorScreen({ width: 32, height: 32, zoom, screen: 0, geometry: g, planes: planes as never, lists: { main: [...lists.main], sub: [] }, math: null, indicators: ind, arts, hoverId }) // prettier-ignore
  const at2 = (r: ReturnType<typeof run>, x: number, y: number) => Array.from(r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)) // prettier-ignore

  it('composes at screen resolution', () => {
    const r = run({ l1Low: null, l2Low: null }, [A('a', 0, 0, 'l2Low')], 3)
    expect([r.width, r.height]).toEqual([96, 96])
  })

  it('shows an indicator of the farther layer where the nearer layer has nothing', () => {
    const r = run({ l1Low: null, l2Low: null }, [A('a', 0, 0, 'l2Low')])
    expect(at2(r, 30, 30)).toEqual([200, 0, 0, 255]) // the quadrant (16..31 at 2x)
    expect(at2(r, 10, 10)).toEqual([0, 0, 0, 0])
  })

  it('hides it where a nearer layer has an opaque pixel, exactly as it hides the block', () => {
    // The nearer plane's native pixel (14, 14) is 2 x 2 screen pixels at 2x: (28..29, 28..29), over the indicator.
    const r = run({ l1Low: native([[14, 14]], [0, 0, 255]), l2Low: null }, [A('a', 0, 0, 'l2Low')])
    expect(at2(r, 28, 28)).toEqual([0, 0, 255, 255])
    expect(at2(r, 29, 29)).toEqual([0, 0, 255, 255])
    expect(at2(r, 30, 28)).toEqual([200, 0, 0, 255]) // the indicator outside the covering pixel stays
    expect(at2(r, 30, 30)).toEqual([200, 0, 0, 255])
  })

  it('draws a nearer-layer indicator over a farther-layer pixels, and a hidden layer indicator not at all', () => {
    const far = native([[14, 14]], [0, 255, 0])
    const near = run({ l1Low: null, l2Low: far }, [A('a', 0, 0, 'l1Low')])
    expect(at2(near, 28, 28)).toEqual([200, 0, 0, 255])
    const hidden = run({ l2Low: far }, [A('a', 0, 0, 'l1Low')]) // layer 1 not shown: its plane is absent
    expect(at2(hidden, 28, 28)).toEqual([0, 255, 0, 255])
    expect(hidden.painted).toEqual([])
  })

  it('reports what it painted, and whether any indicator touches the screen', () => {
    const r = run(
      { l1Low: null, l2Low: null },
      [A('a', 0, 0), A('a', 0, 0, 'l2Low')],
      1,
      'l1Low:0:0',
    )
    expect(r.painted.map(p => [p.id, p.hover])).toEqual([['l1Low:0:0', true], ['l2Low:0:0', false]]) // prettier-ignore
    const base = { screen: 0, geometry: g, lists: { main: ['l1Low' as const], sub: [] as never[] } }
    expect(indicatorsTouch({ ...base, planes: { l1Low: null }, indicators: [A('a', 0, 0)] })).toBe(
      true,
    )
    expect(indicatorsTouch({ ...base, planes: {}, indicators: [A('a', 0, 0)] })).toBe(false) // plane hidden
    expect(indicatorsTouch({ ...base, planes: { l1Low: null }, indicators: [A('a', 64, 0)] })).toBe(
      false,
    ) // another screen
    expect(
      indicatorsTouch({ ...base, planes: { l1Low: null }, indicators: [A('a', 0, 0, 'l2Low')] }),
    ).toBe(false) // plane not composed
  })

  it('scales by nearest sampling, keeping each source pixel whole', () => {
    const src = new Uint8ClampedArray([1, 0, 0, 255, 2, 0, 0, 255])
    expect(Array.from(scaleNearest(src, 2, 1, 4, 1)).filter((_, i) => i % 4 === 0)).toEqual([
      1, 1, 2, 2,
    ])
    expect(Array.from(scaleNearest(src, 2, 1, 1, 1))[0]).toBe(1)
  })
})

describe('paintScreenIndicators', () => {
  const g = { orientation: 'horizontal' as const, width: 64, height: 64 }
  const arts = decodeArts({ a: Buffer.from(solid([200, 0, 0, 255])).toString('base64') })
  const list = [A('a', 16, 16), A('a', 80, 16), A('a', 16, 16, 'l2Low')]
  it.each([1, 2, 3])(
    'paints the quadrant at rest and the block on hover at %ix, in screen pixels',
    z => {
      const rest = new Uint8ClampedArray(64 * z * 64 * z * 4)
      const r = paintScreenIndicators(rest, 0, g, z, list, arts, p => p === 'l1Low', undefined)
      expect(r).toEqual([{ id: 'l1Low:16:16', hover: false, box: { x0: 24 * z, y0: 24 * z, x1: 32 * z, y1: 32 * z } }]) // prettier-ignore
      const hov = new Uint8ClampedArray(64 * z * 64 * z * 4)
      const h = paintScreenIndicators(hov, 0, g, z, list, arts, p => p === 'l1Low', 'l1Low:16:16')
      expect(h[0]!.box).toEqual({ x0: 16 * z, y0: 16 * z, x1: 32 * z, y1: 32 * z })
      const lit = (d: Uint8ClampedArray) => d.filter((v, i) => i % 4 === 3 && v !== 0).length
      expect([lit(rest), lit(hov)]).toEqual([(8 * z) ** 2, (16 * z) ** 2])
    },
  )
  it('draws only the shown planes and only the blocks on its screen', () => {
    const none = paintScreenIndicators(new Uint8ClampedArray(64 * 64 * 4), 0, g, 1, list, arts, () => false, undefined) // prettier-ignore
    expect(none).toEqual([])
    const s1 = paintScreenIndicators(new Uint8ClampedArray(64 * 64 * 4), 1, g, 1, list, arts, p => p === 'l1Low', undefined) // prettier-ignore
    expect(s1.map(i => i.box.x0)).toEqual([80 - 64 + 8])
  })
})

/** The vanilla tables, read from the corpus ROM (corpus-gated callers only). */
function VANILLA_TABLES(bytes: Uint8Array): BlockContentTables {
  const t = readBlockContentTables(RomFile.fromBytes('v.sfc', Buffer.from(bytes)))
  if ('unavailable' in t) throw new Error(t.unavailable)
  return t
}

/** The coin's colours on map $10B, from the cart's own coin draw. */
function romArtCoin(): Set<string> {
  const bytes = new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)
  const built = new L1ModelCache().get(bytes, romPath(VANILLA), 0x10b, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
  if (!built.ok) throw new Error(built.reason)
  const d = romArt(
    RomFile.fromBytes('v.sfc', Buffer.from(bytes)),
    0x10b,
    built.inputs,
    VANILLA_TABLES(bytes),
  ).coin(false)
  if (!('art' in d)) throw new Error(d.why)
  const out = new Set<string>()
  for (let i = 0; i < d.art.length; i += 4)
    if (d.art[i + 3]) out.add(Array.from(d.art.subarray(i, i + 3)).join())
  return out
}

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

  it('splits a progressive block into two different items, and $11A column 1 of 3 shows the 1-up alone', () => {
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
    expect(at(r, 209, 15).map(i => i.art)).toEqual(['s78:8:']) // $11A at column 1 of 3: the 1-up
  })

  it('draws $11A column 0 of 3 as the option A split: coin bottom-left, star top-right', () => {
    const r = run(0x10b)
    const [cell] = at(r, 176, 20) // 176 mod 16 = 0
    expect(cell?.art).toBe('coin/s76:8:')
    const art = unb(r.arts[cell!.art]!)
    const opaque = (below: boolean) => {
      const out: number[][] = []
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          if (y > x === below && y !== x && art[(y * 16 + x) * 4 + 3])
            out.push(Array.from(art.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 3)))
      return out
    }
    expect(opaque(true).length).toBeGreaterThan(10)
    expect(opaque(false).length).toBeGreaterThan(10)
    // The coin's own pixels are below the diagonal, and the star's above it.
    const coin = romArtCoin()
    expect(opaque(true).some(p => coin.has(p.join()))).toBe(true)
    expect(opaque(false).every(p => !coin.has(p.join()) || p.join() === '0,0,0')).toBe(true)
  })

  it('shows each cell the item of its own column ($125 key vs balloon, $11D blue vs silver)', () => {
    const f = run(0x11e)
    const [key, balloon] = [at(f, 224, 22), at(f, 250, 21)]
    expect(f.arts[key[0]!.art]).not.toBe(f.arts[balloon[0]!.art])
    const blue = run(0x125)
    const silver = run(0x001)
    expect(blue.arts[at(blue, 86, 20)[0]!.art]).not.toBe(silver.arts[at(silver, 231, 18)[0]!.art])
  })

  // The spawn seeds, run on the core (bank_02.asm:1122-1160): a status-9 egg is green, a status-9 $04 a shell.
  it('draws a status-9 Yoshi egg green and a status-9 $04 as a shell, not the walking Koopa', () => {
    const bytes = new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)
    const built = new L1ModelCache().get(bytes, romPath(VANILLA), 0x126, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
    if (!built.ok) throw new Error(built.reason)
    const art = romArt(
      RomFile.fromBytes('v.sfc', Buffer.from(bytes)),
      0x126,
      built.inputs,
      VANILLA_TABLES(bytes),
    )
    const draw = (sprite: number, status: number) => {
      const d = art.sprite({ kind: 'sprite', sprite, status, label: '' }, 5, 10)
      if (!('art' in d)) throw new Error(d.why)
      return d.art
    }
    const egg = draw(0x2c, 9)
    let green = 0
    for (let i = 0; i < egg.length; i += 4) if (egg[i + 3] && egg[i + 1]! > egg[i]! + 60 && egg[i + 1]! > egg[i + 2]! + 60) green++ // prettier-ignore
    expect(green).toBeGreaterThan(20)
    // The same sprite placed by the level (INIT, status 8) is the walking Koopa; the spawn's status 9 is the shell.
    const level = { vram: built.inputs.vram, colors: built.inputs.colors }
    const rom = RomFile.fromBytes('v.sfc', Buffer.from(bytes))
    const [koopa] = drawSprites([{ screen: 0, x: 5, y: 10, spriteId: 4, extraBit: false, raw: [0, 0, 0], index: 0 }] as never, level, interpDrawer(rom, 0x126, built.inputs)) // prettier-ignore
    expect(koopa!.status).toBe('drawn')
    expect(koopa!.rgba).not.toBe(Buffer.from(draw(4, 9)).toString('base64'))
  })

  // The L1 line (owner pick): per item, clipped to that item's half of the diagonal pixel, so a diagonal art
  // pixel is black where EITHER item is opaque. The mockup (spikes/progressive-powerup-indicators gen.cjs, `diag`)
  // counts 13, 12, 11 and 12 diagonal pixels for $11F, $120, $11A column 0 and $12D, from its own static, unflipped
  // art. The core-run art matches it for $11F (13) and $12D (12) and differs for $120 (15) and $11A (12): the run
  // draws the feather mirrored (its first pass is flipped) and the star one pixel wider on the diagonal. So the rule is
  // asserted against the constituents of the real art, and the core's own counts are pinned: 13, 15, 12 and 12 (owner ruling
  // 2026-10-06: the core's first frame stays, the mirrored feather and the wider star included).
  const diagOf = (a: Uint8ClampedArray) => Array.from({ length: 16 }, (_, i) => a[(i * 16 + i) * 4 + 3] !== 0) // prettier-ignore
  it.each([
    [0x105, 'mushroom / flower ($11F)', 's74:8:', 's75:8:', 13],
    [0x002, 'mushroom / feather ($120)', 's74:8:', 's77:8:', 15],
    [0x10b, 'coin / star ($11A column 0 of 3)', 'coin', 's76:8:', 12],
    [0x005, 'coin / 1-up ($12D)', 'coin', 's78:8:', 12],
  ] as const)(
    'draws the line on every diagonal pixel either item paints: map %#, %s',
    (map, _name, small, big, pinned) => {
      // prettier-ignore
      const bytes = new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)
      const cache = new L1ModelCache()
      const r = mapBlockContents(cache, bytes, romPath(VANILLA), map)
      if (r.status !== 'ok') throw new Error(JSON.stringify(r))
      const split = unb(
        r.arts[`${small}/${big}`] ?? r.arts[`${small}/${big}`.replace('/', '/')] ?? '',
      )
      expect(split.length, `${small}/${big} is on map ${map.toString(16)}`).toBe(1024)
      const built = cache.get(bytes, romPath(VANILLA), map, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
      if (!built.ok) throw new Error(built.reason)
      const art = romArt(
        RomFile.fromBytes('v.sfc', Buffer.from(bytes)),
        map,
        built.inputs,
        VANILLA_TABLES(bytes),
      )
      const one = (k: string) => {
        const d = k === 'coin' ? art.coin(false) : art.sprite({ kind: 'sprite', sprite: parseInt(k.slice(1), 16), status: 8, label: '' }, 5, 10) // prettier-ignore
        if (!('art' in d)) throw new Error(d.why)
        return diagOf(d.art)
      }
      const [a, b] = [one(small), one(big)]
      const got = Array.from({ length: 16 }, (_, i) => split[(i * 16 + i) * 4 + 3] !== 0)
      expect(got).toEqual(a.map((v, i) => v || b[i]!))
      for (let i = 0; i < 16; i++) if (got[i]) expect(Array.from(split.subarray((i * 16 + i) * 4, (i * 16 + i) * 4 + 3))).toEqual([0, 0, 0]) // prettier-ignore
      expect(got.filter(Boolean).length).toBe(pinned)
    },
  )
})
