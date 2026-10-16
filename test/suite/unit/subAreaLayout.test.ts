/**
 * SPIKE (#946): card placement arithmetic and the tile scan on built grids (no ROM),
 * and the chosen vanilla levels' neighbour cards (describe.skipIf without the vanilla ROM).
 */
import { beforeAll, describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  CARD_GAP,
  CARD_H,
  CARD_W,
  EDGE_GAP,
  buildSubAreaLayout,
  findEnterable,
  fitInCard,
  placeCards,
  reverseSide,
  type Side,
} from '../../../src/rom/subAreaLayout'
import { freshRom, hasRom, VANILLA } from '../support/corpus'

const main = { w: 1024, h: 432 }
const card = (side: Side, ...xy: Array<[number, number]>) => ({
  side,
  mains: xy.map(([x, y]) => ({ x, y })),
})

describe('placeCards (synthetic)', () => {
  it('below, above, beside and left: centred on the link, one edge gap from the map', () => {
    const at = (side: Side, x: number, y: number, scale: number) =>
      placeCards(main, [card(side, [x, y])], scale)[0]
    expect(at('below', 400, 200, 0.5)).toEqual({ x: 200 - CARD_W / 2, y: 216 + EDGE_GAP })
    expect(at('above', 400, 200, 0.5)).toEqual({ x: 200 - CARD_W / 2, y: -(CARD_H + EDGE_GAP) })
    expect(at('beside', 1000, 380, 0.5)).toEqual({ x: 512 + EDGE_GAP, y: 190 - CARD_H / 2 })
    expect(at('left', 20, 100, 1)).toEqual({ x: -(CARD_W + EDGE_GAP), y: 100 - CARD_H / 2 })
  })
  it('a return card with two links is centred on their midpoint', () => {
    const [p] = placeCards(main, [card('below', [100, 200], [500, 300])], 0.5)
    expect(p!.x).toBe(150 - CARD_W / 2)
  })
  it('two cards on one side never overlap; the other side and the input order are untouched', () => {
    const r = placeCards(
      main,
      [card('below', [900, 0]), card('below', [900, 0]), card('above', [900, 0]), card('below', [100, 0])], // prettier-ignore
      0.5,
    )
    expect(r[3]!.x).toBe(50 - CARD_W / 2)
    const xs = [r[3]!, r[0]!, r[1]!].map(p => p.x)
    for (let k = 1; k < xs.length; k++) expect(xs[k]! - xs[k - 1]!).toBeGreaterThanOrEqual(CARD_W + CARD_GAP) // prettier-ignore
    expect(r[0]!.x).toBe(450 - CARD_W / 2)
    expect(r[1]!.x).toBe(r[0]!.x + CARD_W + CARD_GAP)
    expect(r[2]).toEqual({ x: 450 - CARD_W / 2, y: -(CARD_H + EDGE_GAP) })
  })
  it('an inbound link reverses the side: a pipe going down puts the origin above', () => {
    expect([reverseSide('below'), reverseSide('above'), reverseSide('beside')]).toEqual(['above', 'below', 'left']) // prettier-ignore
  })
  it('a map is letterboxed into the card with its aspect kept', () => {
    const wide = fitInCard(768, 432)
    expect(wide.scale).toBeCloseTo(160 / 768, 6)
    expect(wide.oy).toBeCloseTo((96 - 432 * wide.scale) / 2, 6)
    const tall = fitInCard(512, 768)
    expect(tall.scale).toBeCloseTo(0.125, 6)
    expect(tall.ox).toBeCloseTo((160 - 64) / 2, 6)
  })
})

describe('findEnterable (synthetic grid)', () => {
  /** Flat x, y, tile triples on an empty 64 x 27 grid. */
  const scan = (cells: number[], screen: number) => {
    const g = Array.from({ length: 27 }, () => new Array<number>(64).fill(0))
    for (let i = 0; i < cells.length; i += 3) g[cells[i + 1]!]![cells[i]!] = cells[i + 2]!
    return findEnterable(g, false, screen)
  }
  it('a cap over a body is a down pipe: below, centred on the two-tile cap', () => {
    const f = scan([20, 10, 0x137, 21, 10, 0x138, 20, 11, 0x135], 1)
    expect(f).toMatchObject({ kind: 'below', at: { x: 20 * 16 + 16, y: 160 }, count: 1 })
  })
  it('a cap under a body is an up pipe: above', () => {
    expect(scan([20, 10, 0x137, 20, 9, 0x135], 1)?.kind).toBe('above')
  })
  it('a door and a side pipe are beside; two on one screen count 2', () => {
    const f = scan([17, 5, 0x20, 30, 6, 0x13f], 1)
    expect(f).toMatchObject({ kind: 'beside', count: 2, at: { x: 17 * 16 + 8, y: 96 } })
  })
  it('only the asked screen is scanned, and an empty screen finds nothing', () => {
    expect(scan([17, 5, 0x20], 0)).toBeNull()
  })
})

describe.skipIf(!hasRom(VANILLA))('buildSubAreaLayout on the vanilla ROM', () => {
  let rom: SmwRom
  beforeAll(() => {
    rom = new SmwRom(freshRom(VANILLA))
  })
  const layout = (slot: number) => {
    const r = buildSubAreaLayout(rom, slot)
    if (!r.ok) throw new Error(r.reason)
    return r
  }
  const cardOf = (slot: number, nb: number) => layout(slot).cards.find(c => c.slot === nb)!

  it('$00B: the pipe on screen 7 puts $0E1 below, linked at the pipe', () => {
    const c = cardOf(0x0b, 0xe1)
    expect(c).toMatchObject({ side: 'below', basis: 'tile', outbound: true, screens: 8 })
    expect(c.links[0]).toMatchObject({ main: { x: 2000, y: 288 }, card: { x: 136, y: 320 } })
  })
  it('$0BE: the up pipe on screen 3 puts $0D0 above', () => {
    expect(cardOf(0xbe, 0xd0)).toMatchObject({ side: 'above', basis: 'tile' })
  })
  it('$0BE: $0D0 has a return (its own exit leads back), so it is one card with two links', () => {
    expect(cardOf(0xbe, 0xd0).links).toHaveLength(2)
  })
  it('$107: the door on screen $0A puts $1EA beside', () => {
    expect(cardOf(0x107, 0x1ea)).toMatchObject({ side: 'beside', basis: 'tile' })
  })
  it('$0E1: $00B, the map you came from, is a neighbour above (reversed from its down pipe)', () => {
    const c = cardOf(0xe1, 0x0b)
    expect(c).toMatchObject({ side: 'above', inbound: true })
    expect(c.links.at(-1)!.card).toEqual({ x: 2000, y: 288 })
  })
  it('$022: no pipe tile on its exit screen, so its cards are guesses', () => {
    expect(layout(0x22).cards.filter(c => c.outbound).map(c => c.basis)).toEqual(['heuristic', 'heuristic', 'heuristic']) // prettier-ignore
  })
})
