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
  exitsFromStream,
  findEnterables,
  fitInCard,
  mainEnd,
  outboundCards,
  placeCards,
  resolveExitSlots,
  returnCard,
  reverseSide,
  type CardDeps,
  type CardDto,
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

describe('findEnterables (synthetic grid)', () => {
  /** Flat x, y, tile triples on an empty 128 x 27 grid (8 screens). */
  const gridOf = (cells: number[]) => {
    const g = Array.from({ length: 27 }, () => new Array<number>(128).fill(0))
    for (let i = 0; i < cells.length; i += 3) g[cells[i + 1]!]![cells[i]!] = cells[i + 2]!
    return g
  }
  const scan = (cells: number[], screen: number, tileset?: number) =>
    findEnterables(gridOf(cells), false, screen, tileset)
  it('a cap over a body is a down pipe: below, centred on the two-tile cap', () => {
    const f = scan([20, 10, 0x137, 21, 10, 0x138, 20, 11, 0x135], 1)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ kind: 'below', at: { x: 20 * 16 + 16, y: 160 } })
  })
  it('a cap under a body is an up pipe: above', () => {
    expect(scan([20, 10, 0x137, 20, 9, 0x135], 1)[0]?.kind).toBe('above')
  })
  it('a door and a side pipe are beside; each is one feature', () => {
    const f = scan([17, 5, 0x20, 30, 6, 0x13f], 1)
    expect(f.map(x => x.tile)).toEqual(['door', 'side pipe'])
    expect(f[0]).toMatchObject({ kind: 'beside', at: { x: 17 * 16 + 8, y: 96 } })
  })
  it('a $1F over a $20 is one door; a lone $1F is a conditional one that sorts last', () => {
    expect(scan([17, 4, 0x1f, 17, 5, 0x20], 1)).toHaveLength(1)
    const f = scan([17, 4, 0x1f, 25, 9, 0x20], 1)
    expect(f).toHaveLength(2)
    expect(f.map(x => x.conditional)).toEqual([undefined, 'only for small Mario'])
    const lone = scan([17, 4, 0x1f, 25, 9, 0x27, 30, 6, 0x13f], 1)
    expect(lone.map(x => x.tile)).toEqual(['side pipe', 'door', 'door'])
    expect(lone[1]!.conditional).toMatch(/small/)
  })
  it('decorative pipe tiles and the low-byte lookalikes on the wrong page are not enterable', () => {
    expect(scan([17, 4, 0x133, 18, 4, 0x136, 19, 4, 0x13e, 20, 4, 0x037, 21, 4, 0x03f, 22, 4, 0x138 + 0x100], 1)).toEqual([]) // prettier-ignore
  })
  it('$9C is a door in tileset 1 only', () => {
    expect(scan([17, 4, 0x9c], 1, 1)).toHaveLength(1)
    expect(scan([17, 4, 0x9c], 1, 2)).toHaveLength(0)
  })
  it('only the asked screen is scanned, and an empty screen finds nothing', () => {
    expect(scan([17, 5, 0x20], 0)).toEqual([])
  })
})

/**
 * A stream whose first `screens` objects each open a new screen, then the exits, each as a
 * 4-byte extended object: b0 = the exit's own field, b1 = 0 (primary, bit 8 clear), b2 = 0,
 * then the destination low byte (CODE_0DA512, bank_0D.asm:1416-1438).
 */
function streamOf(screens: number, exits: Array<[number, number]>): Uint8Array {
  const bytes = [0, 0, 0, 0, 0]
  for (let i = 0; i < screens; i++) bytes.push(0x80, 0x10, 0)
  for (const [field, dest] of exits) bytes.push(field, 0, 0, dest)
  bytes.push(0xff)
  return Uint8Array.from(bytes)
}
const noSecondary = () => null

describe('exit slots (synthetic stream)', () => {
  it('two exits on stream screen 7 with fields 3 and 7 are filed under 3 and 7, not both under 7', () => {
    const r = exitsFromStream(streamOf(7, [[3, 0xe1], [7, 0xe0]]), 0, noSecondary)! // prettier-ignore
    expect(r.exits).toEqual([
      { screen: 3, dest: 0xe1, index: null },
      { screen: 7, dest: 0xe0, index: null },
    ])
    expect(r.notes).toEqual([])
  })
  it('two exits with the same field: the later one wins and a note names the dropped one', () => {
    const r = exitsFromStream(streamOf(7, [[5, 0xe1], [5, 0xe0]]), 0, noSecondary)! // prettier-ignore
    expect(r.exits).toEqual([{ screen: 5, dest: 0xe0, index: null }])
    expect(r.notes).toHaveLength(1)
    expect(r.notes[0]).toMatch(/\$05.*\$0E0.*\$0E1/)
  })
  it('the field is byte 0 & $1F: the new-screen flag and object bits do not leak in', () => {
    const r = resolveExitSlots([{ screen: 0x1f, dest: 1, index: null }])
    expect(r.exits[0]!.screen).toBe(0x1f)
    const s = exitsFromStream(streamOf(0, [[0x93, 0xe1]]), 0, noSecondary)!
    expect(s.exits[0]!.screen).toBe(0x13)
  })
})

describe('outboundCards and returnCard (synthetic)', () => {
  const grid = (cells: number[]) => {
    const g = Array.from({ length: 27 }, () => new Array<number>(128).fill(0))
    for (let i = 0; i < cells.length; i += 3) g[cells[i + 1]!]![cells[i]!] = cells[i + 2]!
    return g
  }
  // Side pipe on screen 3, down pipe (cap pair over a body) on screen 7.
  const g = grid([3 * 16 + 4, 10, 0x13f, 7 * 16 + 2, 10, 0x137, 7 * 16 + 3, 10, 0x138, 7 * 16 + 2, 11, 0x135]) // prettier-ignore
  const deps = (refuse: CardDeps['refuse'] = () => null): CardDeps => ({
    landing: ex => ({ x: ex.dest * 10, y: 40 }),
    neighbour: dest =>
      dest === 0xdf ? 'Map $0DF is a boss arena' : { w: 256, h: 432, screens: 1 },
    action: () => ({ side: undefined, act: null }),
    refuse,
  })
  const run = (exits: Array<{ screen: number; dest: number }>, g2 = g, d = deps()) => {
    const cards = new Map<number, CardDto>()
    const notes: string[] = []
    outboundCards(
      exits.map(e => ({ ...e, index: null })),
      g2,
      false,
      1,
      d,
      cards,
      notes,
    )
    return { cards, notes }
  }

  it('two exits filed under different screens: two cards, each line starts on its own pipe', () => {
    const { cards, notes } = run([{ screen: 3, dest: 0xe1 }, { screen: 7, dest: 0xe0 }]) // prettier-ignore
    expect([...cards.keys()]).toEqual([0xe1, 0xe0])
    const side = cards.get(0xe1)!.links
    const down = cards.get(0xe0)!.links
    expect(side).toEqual([{ dir: 'exit', from: { x: 3 * 16 * 16 + 4 * 16 + 8, y: 176 }, to: { x: 0xe1 * 10, y: 40 } }]) // prettier-ignore
    expect(down).toEqual([{ dir: 'exit', from: { x: 7 * 256 + 2 * 16 + 16, y: 160 }, to: { x: 0xe0 * 10, y: 40 } }]) // prettier-ignore
    expect(cards.get(0xe1)!.side).toBe('beside')
    expect(cards.get(0xe0)!.side).toBe('below')
    expect(notes).toEqual([])
  })
  it('two pipes or doors on one exit screen: a note says they all lead to this exit', () => {
    const two = grid([4 * 16 + 4, 10, 0x13f, 4 * 16 + 9, 12, 0x20])
    const { cards } = run([{ screen: 4, dest: 0xe1 }], two)
    expect(cards.get(0xe1)!.links).toHaveLength(1)
    expect(cards.get(0xe1)!.notes.join(' ')).toMatch(/2 pipes or doors on screen \$04 all lead to this exit/) // prettier-ignore
  })
  it('no pipe or door on the exit screen: a heuristic line from the screen centre, with a note', () => {
    const { cards } = run([{ screen: 5, dest: 0xe1 }])
    const c = cards.get(0xe1)!
    expect(c.basis).toBe('heuristic')
    expect(c.links[0]!.from).toEqual({ x: 5 * 256 + 128, y: 216 })
    expect(c.notes.join(' ')).toMatch(/No pipe or door on screen \$05/)
  })
  it('an exit that is not a card, or whose map cannot be read, is a note naming the slot and why', () => {
    const d = deps(dest => (dest === 0x10 ? 'the overworld enters that map' : null))
    const { cards, notes } = run([{ screen: 3, dest: 0x10 }, { screen: 7, dest: 0xdf }], g, d) // prettier-ignore
    expect(cards.size).toBe(0)
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatch(/\$010.*overworld/)
    expect(notes[1]).toMatch(/\$0DF.*boss arena/)
  })
  it('direction: the exit line runs main -> card, the return line card -> main', () => {
    const cards = new Map<number, CardDto>()
    outboundCards([{ screen: 7, dest: 0xe0, index: null }], g, false, 1, deps(), cards, [])
    // The card map's own exit pipe (screen 2) leads back to a landing in the main map.
    const back = grid([2 * 16 + 6, 9, 0x13f])
    returnCard(cards, 0xe0, { grid: back, isVertical: false, tileset: 1, screens: 8 }, { screen: 2, dest: 0x0b, index: null }, deps()) // prettier-ignore
    const [exit, ret] = cards.get(0xe0)!.links
    expect(exit!.dir).toBe('exit')
    expect(mainEnd(exit!)).toEqual(exit!.from)
    expect(exit!.to).toEqual({ x: 0xe0 * 10, y: 40 })
    expect(ret).toEqual({ dir: 'return', from: { x: 2 * 256 + 6 * 16 + 8, y: 160 }, to: { x: 0x0b * 10, y: 40 } }) // prettier-ignore
    expect(mainEnd(ret!)).toEqual(ret!.to)
    expect(cards.get(0xe0)).toMatchObject({ outbound: true, inbound: true })
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
  const exits = (slot: number) => layout(slot).cards.flatMap(c => c.links.filter(l => l.dir === 'exit').map(l => ({ slot: c.slot, ...l }))) // prettier-ignore

  it('$00B: exactly two exit cards, $0E1 from the side pipe on screen 3 and $0E0 from the down pipe on screen 7', () => {
    const r = layout(0x0b)
    expect(
      r.cards
        .filter(c => c.outbound)
        .map(c => c.slot)
        .sort(),
    ).toEqual([0xe0, 0xe1])
    const [e1, e0] = [cardOf(0x0b, 0xe1), cardOf(0x0b, 0xe0)]
    expect(e1).toMatchObject({ side: 'beside', basis: 'tile', outbound: true })
    expect(e0).toMatchObject({ side: 'below', basis: 'tile', outbound: true })
    expect(e1.links.filter(l => l.dir === 'exit')).toHaveLength(1)
    expect(e0.links.filter(l => l.dir === 'exit')).toHaveLength(1)
    expect(Math.floor(e1.links[0]!.from.x / 256)).toBe(3)
    expect(Math.floor(e0.links[0]!.from.x / 256)).toBe(7)
  })
  it('$0BE: the up pipe on screen 3 puts $0D0 above', () => {
    expect(cardOf(0xbe, 0xd0)).toMatchObject({ side: 'above', basis: 'tile' })
  })
  it('$0BE: $0D0 has a return (its own exit leads back), so it is one card with an exit and a return', () => {
    expect(
      cardOf(0xbe, 0xd0)
        .links.map(l => l.dir)
        .sort(),
    ).toEqual(['exit', 'return'])
  })
  it('$107: the door on screen $0A puts $1EA beside', () => {
    expect(cardOf(0x107, 0x1ea)).toMatchObject({ side: 'beside', basis: 'tile' })
  })
  it('$0E1: $00B, the map you came from, is a card to the left (its exit is a side pipe) with a return line', () => {
    const c = cardOf(0xe1, 0x0b)
    expect(c).toMatchObject({ side: 'left', inbound: true })
    expect(c.links.at(-1)!.dir).toBe('return')
  })
  it('$0E1: its exit to $0DF is a note saying why (a boss arena the game never loads), not a card', () => {
    const r = layout(0xe1)
    expect(r.cards.map(c => c.slot)).toEqual([0x0b])
    expect(r.notes.join(' ')).toMatch(/\$0DF.*boss arena/)
  })
  it('$022: its exit lines start on the pipes on screens 6, 15 and 16', () => {
    const screens = exits(0x22).map(l => Math.floor(l.from.x / 256))
    expect(screens.sort((a, b) => a - b)).toEqual([6, 15, 16])
    expect(layout(0x22).cards.filter(c => c.outbound).map(c => c.basis)).toEqual(['tile', 'tile', 'tile']) // prettier-ignore
  })
})
