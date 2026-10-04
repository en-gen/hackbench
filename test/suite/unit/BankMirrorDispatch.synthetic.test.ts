/**
 * Handler lookups fold the $80-$FF FastROM mirror onto $00-$7F (#302).
 * Many hacks store a dispatch pointer as $8Dxxxx where stock holds $0Dxxxx;
 * the handler maps are keyed $0Dxxxx. One test per lookup site routes a $8D
 * pointer and asserts the handler ran.
 *
 * Synthetic cart only (runs without the corpus). Evidence scope: pointer
 * layout per romData.ts and the handler preambles read by the ports; every
 * address below is invented except the ones the handler map is keyed on.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { createGrid, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { makeCursor, TileGrid } from '../../../src/rom/objectHandlers/cursor'
import {
  dispatchExtended,
  dispatchStandard,
  objectsDispatchedTo,
  EXTENDED_HANDLERS,
  STANDARD_HANDLERS,
  type HandlerFn,
} from '../../../src/rom/objectHandlers/dispatch'
import {
  handle_0DC341,
  handle_0DCF53,
  handle_0DD070,
} from '../../../src/rom/objectHandlers/standardHandlers'
import { mirror } from '../../../src/rom/addressing'
import {
  ADDR_EXTENDED_DISPATCH,
  ADDR_TILESET_DISPATCH,
} from '../../../src/rom/objectHandlers/romData'

const off = (snes: number): number => ((snes >> 16) & 0x3f) * 0x8000 + (snes & 0x7fff)
const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, a >> 16]
const put = (buf: Buffer, snes: number, bytes: number[]): void => void buf.set(bytes, off(snes))

const DISPATCHER = 0x0da44b // tileset 0 dispatcher, 10-byte preamble then the table
const FAKE_EXT = 0x0dd000
const FAKE_STD = 0x0dd100
const PIPE = 0x0dab3e
const added: number[] = []

afterEach(() => {
  for (const a of added.splice(0)) {
    delete EXTENDED_HANDLERS[a]
    delete STANDARD_HANDLERS[a]
  }
})

function cart(edit: (buf: Buffer) => void): RomFile {
  const buf = Buffer.alloc(0x80000, 0)
  buf[0x7fd5] = 0x20
  edit(buf)
  return new RomFile('synthetic.sfc', buf)
}

const changed = (g: TileGrid): boolean => g.some(row => row.some(t => t !== TILE_EMPTY))
const spy = (): { fn: HandlerFn; seen: number[] } => {
  const seen: number[] = []
  return { seen, fn: cur => void seen.push(cur.handlerAddr) }
}

describe('mirror()', () => {
  it('folds $80-$FF onto $00-$7F and leaves the offset alone', () => {
    expect(mirror(0x8dab3e)).toBe(0x0dab3e)
    expect(mirror(0x0dab3e)).toBe(0x0dab3e)
  })
})

describe('bank mirror at every handler lookup (#302)', () => {
  it('dispatchExtended routes a $8D pointer', () => {
    const s = spy()
    EXTENDED_HANDLERS[FAKE_EXT] = s.fn
    added.push(FAKE_EXT)
    const rom = cart(b => put(b, ADDR_EXTENDED_DISPATCH, long(0x8d0000 | (FAKE_EXT & 0xffff))))
    dispatchExtended(makeCursor(createGrid(1), rom, 0, 0, 0, 0, 0))
    expect(s.seen).toEqual([FAKE_EXT])
  })

  it('dispatchStandard routes a $8D entry, with a $8D dispatcher address', () => {
    const s = spy()
    STANDARD_HANDLERS[FAKE_STD] = s.fn
    added.push(FAKE_STD)
    const rom = cart(b => {
      put(b, ADDR_TILESET_DISPATCH, long(0x800000 | DISPATCHER))
      put(b, DISPATCHER + 10, long(0x8d0000 | (FAKE_STD & 0xffff)))
    })
    dispatchStandard(makeCursor(createGrid(1), rom, 0, 0, 0, 1, 0))
    expect(s.seen).toEqual([FAKE_STD])
  })

  it('object $12 stored as $8DAB3E reaches CODE_0DAB3E and its pipe variant', () => {
    const rom = cart(b => {
      put(b, ADDR_TILESET_DISPATCH, long(DISPATCHER))
      put(b, DISPATCHER + 10 + 17 * 3, long(0x8d0000 | (PIPE & 0xffff)))
      put(b, PIPE + 18, long(0x8dab6e)) // variant 0, also $8D
    })
    const grid = createGrid(1)
    dispatchStandard(makeCursor(grid, rom, 0, 2, 2, 0x12, 0))
    expect(changed(grid)).toBe(true)
  })

  it('objectsDispatchedTo finds extended and standard $8D pointers', () => {
    const f = spy().fn
    EXTENDED_HANDLERS[FAKE_EXT] = f
    STANDARD_HANDLERS[FAKE_EXT] = f
    added.push(FAKE_EXT)
    const rom = cart(b => {
      put(b, ADDR_EXTENDED_DISPATCH + 3 * 5, long(0x8d0000 | (FAKE_EXT & 0xffff)))
      put(b, ADDR_TILESET_DISPATCH, long(0x800000 | DISPATCHER))
      put(b, DISPATCHER + 10 + 3 * 7, long(0x8d0000 | (FAKE_EXT & 0xffff)))
    })
    expect(objectsDispatchedTo(rom, 0, f)).toEqual([
      { type: 'extended', objectNumber: 5 },
      { type: 'standard', objectNumber: 8 },
    ])
  })

  it('the staircase dispatcher (CODE_0DC341) routes a $8D variant', () => {
    const H = 0x0dd200
    const rom = cart(b => put(b, H + 9, long(0x8dc358)))
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 4, 4, 61, 0x10)
    cur.handlerAddr = H
    handle_0DC341(cur)
    expect(changed(grid)).toBe(true)
  })

  it('the staircase dispatcher (CODE_0DCF53) routes a $8D variant', () => {
    const H = 0x0dd300
    const rom = cart(b => put(b, H + 9, long(0x8dcf6e)))
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 4, 4, 0, 0x10)
    cur.handlerAddr = H
    handle_0DCF53(cur)
    expect(changed(grid)).toBe(true)
  })

  it('the 2-tall staircase dispatcher (CODE_0DD070) routes a $8D variant', () => {
    const H = 0x0dd400
    const rom = cart(b => put(b, H + 10, long(0x8dd080)))
    const grid = createGrid(1)
    const cur = makeCursor(grid, rom, 0, 6, 6, 0, 0x03)
    cur.handlerAddr = H
    handle_0DD070(cur)
    expect(changed(grid)).toBe(true)
  })
})

describe('dispatcher table in the $FE/$FF ROM mirror of a 4 MB cart (#302)', () => {
  // mirror() would fold $FE onto $7E (WRAM, unreadable); only handler-map KEYS
  // are normalized, the table reads keep the raw bank.
  const FE = 0xfe8000
  const rom4mb = (): RomFile => {
    const buf = Buffer.alloc(0x400000, 0)
    buf[0x7fd5] = 0x20
    buf.set(long(0x0dd100), 0x3f0000 + 10) // $FE800A: object 1 -> $0DD100
    buf.set(long(FE), off(ADDR_TILESET_DISPATCH))
    return new RomFile('synthetic.sfc', buf)
  }

  it('dispatchStandard still reads a table at $FE8000', () => {
    const s = spy()
    STANDARD_HANDLERS[FAKE_STD] = s.fn
    added.push(FAKE_STD)
    dispatchStandard(makeCursor(createGrid(1), rom4mb(), 0, 0, 0, 1, 0))
    expect(s.seen).toEqual([FAKE_STD])
  })

  it('objectsDispatchedTo still reads a table at $FE8000', () => {
    const f = spy().fn
    STANDARD_HANDLERS[FAKE_STD] = f
    added.push(FAKE_STD)
    expect(objectsDispatchedTo(rom4mb(), 0, f)).toEqual([{ type: 'standard', objectNumber: 1 }])
  })
})
