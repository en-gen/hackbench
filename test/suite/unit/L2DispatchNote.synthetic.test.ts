/**
 * An L2 object build reports a hooked object dispatch like L1's does (#493).
 * Synthetic cart, no ROM: stock dispatch bytes as in DispatchPathGate (#302),
 * one standard object whose handler writes a tile, stream at $078000.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { createGrid, expandObject } from '../../../src/rom/ObjectExpander'
import { parseL2Objects } from '../../../src/rom/LevelParser'
import { loadL2Objects } from '../../../src/rom/L2Loader'
import { buildL2Inputs } from '../../../src/rom/model/L2Model'
import type { L1Inputs } from '../../../src/rom/model/L1Model'
import type { SmwRom } from '../../../src/rom/SmwRom'
import { writeStockSkipChain } from '../support/skipChain'
import { plantUploaderTable, OBJ_A_AT } from '../support/l2UploaderRom'
import { STANDARD_HANDLERS } from '../../../src/rom/objectHandlers/dispatch'
import { ADDR_TILESET_DISPATCH } from '../../../src/rom/objectHandlers/romData'

const off = (snes: number): number => ((snes >> 16) & 0x3f) * 0x8000 + (snes & 0x7fff)
const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, a >> 16]
const STD_ENTRY = 0x0da415
const DISPATCHER = 0x0da44b
const FAKE = 0x0dd100
STANDARD_HANDLERS[FAKE] = cur => void (cur.grid[cur.row][cur.col] = 7)

const cart = (edit: (b: Buffer) => void = () => {}): RomFile => {
  const b = Buffer.alloc(0x80000, 0)
  b[0x7fd5] = 0x20
  b.set([0xe2, 0x30, 0xad, 0x31, 0x19, 0x22, 0xfa, 0x86, 0x00], off(STD_ENTRY))
  b.set(long(DISPATCHER), off(ADDR_TILESET_DISPATCH))
  b.set([0xe2, 0x30, 0xa6, 0x5a, 0xca, 0x8a, 0x22, 0xfa, 0x86, 0x00], off(DISPATCHER))
  b.set(long(FAKE), off(DISPATCHER + 10)) // object 1
  b.set([0, 0, 0, 0, 0, 0x00, 0x10, 0x00, 0xff], off(0x078000)) // header, object 1 at 0,0, end
  edit(b)
  return new RomFile('synthetic.sfc', b)
}
const hook = (b: Buffer): void => void b.set([0x5c, ...long(0x92ccd2)], off(STD_ENTRY))

describe('loadL2Objects dispatch note (#493)', () => {
  it('stock bytes give no note and the handler drew', () => {
    const r = loadL2Objects(cart(), 0x078000, 1, 0, false)!
    expect(r.unverified).toEqual([])
    expect(r.grid[0][0]).toBe(7)
  })

  it('a hooked $0DA415 is named once, however many objects', () => {
    const r = loadL2Objects(
      cart(b => {
        hook(b)
        b.set([0x00, 0x10, 0x00, 0x00, 0x11, 0x00, 0xff], off(0x078000 + 5)) // three objects
      }),
      0x078000,
      1,
      0,
      false,
    )!
    expect(r.unverified).toHaveLength(1)
    expect(r.unverified[0]).toContain('$0DA415')
    expect(r.unverified[0]).toContain('$92CCD2')
  })

  it('the grid is the same hooked or stock: the note changes nothing drawn', () => {
    const stock = loadL2Objects(cart(), 0x078000, 1, 0, false)!
    const hooked = loadL2Objects(cart(hook), 0x078000, 1, 0, false)!
    expect(hooked.grid).toEqual(stock.grid)
  })

  // Object 1 reaches `handler` through the stock dispatcher; the stream holds that one object.
  const via = (handler: number, edit: (b: Buffer) => void = () => {}) =>
    cart(b => {
      b.set(long(handler), off(DISPATCHER + 10))
      edit(b)
    })
  const nullSinkGrid = (rom: RomFile) => {
    const grid = createGrid(1)
    for (const o of parseL2Objects(rom.readAt(0x078000, 0x2000)!, 1, false))
      expandObject(grid, o, rom, 0)
    return grid
  }

  it('a handler refused by the #452 opcode gate puts its refusal in the notes and draws nothing', () => {
    // handle_0DB49E reads a JSR at +19; the zeroed byte there is not $20.
    const rom = via(0x0db49e)
    const r = loadL2Objects(rom, 0x078000, 1, 0, false)!
    expect(r.unverified).toHaveLength(2) // the JSR at +19 and the JMP at +52
    for (const n of r.unverified) expect(n).toContain('$0DB49E refused')
    expect(r.grid).toEqual(createGrid(1))
    // With the JSR in place the same handler draws, so the empty grid above is the gate's doing.
    const ok = via(
      0x0db49e,
      b => ((b[off(0x0db49e + 19)] = 0x20), (b[off(0x0db49e + 34 + 18)] = 0x4c)),
    )
    expect(loadL2Objects(ok, 0x078000, 1, 0, false)!.grid).not.toEqual(createGrid(1))
  })

  it('the interpreter-gated slope handler CODE_0DADEB (bank_0D.asm:2671) is drawn by the port: grid equals the null-sink grid, no note', () => {
    // CODE_0DAB3E (bank_0D.asm:2278) at object 1, variant 0 (size 0) -> table at +18 -> CODE_0DADEB.
    const rom = via(0x0dab3e, b => b.set(long(0x0dadeb), off(0x0dab3e + 18)))
    const r = loadL2Objects(rom, 0x078000, 1, 0, false)!
    expect(r.unverified).toEqual([])
    expect(r.grid).toEqual(nullSinkGrid(rom))
    expect(r.grid).not.toEqual(createGrid(1)) // the port drew something, so a no-op draw would differ
  })
})

// MapScreenL2 mocks loadL2Objects, so only this unmocked path proves the real loader's note
// survives buildL2Inputs onto the L2 inputs (#493).
describe('buildL2Inputs over the real loader (#493)', () => {
  const build = (edit: (b: Buffer) => void) => {
    const rom = cart(b => {
      b.set([0x00, 0x80, 0x07], off(0x05e600)) // level 0 L2 pointer -> $078000, an object stream
      b[off(0x05803b)] = 0xc9 // stock CMP #$FF at the L2 preset check
      edit(b)
    })
    plantUploaderTable(rom, () => OBJ_A_AT) // every mode streams objects (bank_05.asm:111-114)
    writeStockSkipChain(rom)
    const smw = { rom, getVerticalTable: () => ({ ok: true, table: new Array(32).fill(0) }) }
    const l1 = { screenCount: 1, isVertical: false, header: { levelMode: 1, objectTileset: 0 }, map16: { tiles: [] } } // prettier-ignore
    return buildL2Inputs(smw as unknown as SmwRom, 0, l1 as unknown as L1Inputs)
  }

  it('a hooked $0DA415 reaches l2.unverified; stock bytes leave it empty', () => {
    const hooked = build(hook)
    if (!hooked.ok) throw new Error(hooked.reason)
    expect(hooked.l2.unverified).toHaveLength(1)
    expect(hooked.l2.unverified![0]).toContain('$0DA415')
    const stock = build(() => {})
    if (!stock.ok) throw new Error(stock.reason)
    expect(stock.l2.unverified).toEqual([])
  })

  it('a two-note stream (the #452 refusals) arrives whole, in order', () => {
    // Same two refusals as the loader test above; a model keeping only the first note fails here.
    const r = build(b => b.set(long(0x0db49e), off(DISPATCHER + 10)))
    if (!r.ok) throw new Error(r.reason)
    expect(r.l2.unverified).toHaveLength(2)
    const direct = loadL2Objects(
      cart(b => b.set(long(0x0db49e), off(DISPATCHER + 10))),
      0x078000,
      1,
      0,
      false,
    )!
    expect(r.l2.unverified).toEqual(direct.unverified)
  })
})
