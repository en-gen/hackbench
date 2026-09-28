/**
 * CODE_0DDF3A (bank_0D.asm:7107), standard object $37 in tilesets 3/9/10/11/14:
 * the castle wall that stamps screen 0 and then block-copies it to later
 * screens (en-gen/hackbench#291).
 *
 * Synthetic cart only, so this runs in CI where the corpus is absent. The
 * cart holds only what the port reads: opcodes, the JSR targets it gates
 * on (the stock subroutine addresses), and operands. Every operand value,
 * table address and table entry is invented and differs from vanilla, so a
 * port that uses a vanilla constant instead of reading the operand goes red.
 * Several are chosen to drive the rare paths: a stamp at column 13 crosses
 * the screen edge, and a stamp starting at $D3 carries into the next page.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { createGrid, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { makeCursor, TileGrid } from '../../../src/rom/objectHandlers/cursor'
import { handle_0DDF3A } from '../../../src/rom/objectHandlers/standardHandlers'
import { STANDARD_HANDLERS } from '../../../src/rom/objectHandlers/dispatch'

const HANDLER = 0x0ddf3a
/** LoROM file offset of an SNES address in banks $00-$3F. */
const off = (snes: number): number => ((snes >> 16) & 0x3f) * 0x8000 + (snes & 0x7fff)
const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, a >> 16]
const word = (w: number): number[] => [w & 0xff, w >> 8]
const [LDA, LDX, LDY, ADC, AND, LDA_LONG_X, MVN, JSR, STA_IND_Y, INX] = [0xa9, 0xa2, 0xa0, 0x69, 0x29, 0xbf, 0x54, 0x20, 0x97, 0xe8] // prettier-ignore

// Synthetic tables, nowhere near the vanilla ones. The copy index starts at
// $0102 (LDA #$02 into _8, LDA #$01 into _9), so the 16 copy entries sit at
// +$200 of their operand, with 512 clear bytes: a size-0 object reads 256.
const [T_POS, T_POS_HI, T_DC, T_DD, T_DE] = [0x0d8100, 0x0d8110, 0x0d8120, 0x0d8140, 0x0d8160]
const [T_DST_LO, T_DST_HI] = [0x0d8200, 0x0d8800]
const ENTRIES = 0x200

const FILL = 0x44
const DC = Array.from({ length: 16 }, (_, i) => 0x80 + i)
const DD = Array.from({ length: 16 }, (_, i) => 0x90 + i)
const DE = Array.from({ length: 16 }, (_, i) => 0xa0 + i)
const screenPtr = (s: number): number => 0xc800 + s * 0x1b0

/** Stock subroutines the port models rather than reads (bank_0D.asm). */
const CALLS: [number, number][] = [
  [6, 0xa6b1], [23, 0xaa08], [28, 0xa95b], [34, 0xa6ba], [47, 0xa987], [99, 0xaa08],
  [106, 0xa95b], [114, 0xa6ba], [117, 0xa97d], [120, 0xaa0d], [127, 0xa95b], [130, 0xaa0d],
  [137, 0xa95b], [140, 0xaa0d], [149, 0xa97d], [163, 0xaa08], [170, 0xa95b], [178, 0xa6ba],
  [185, 0xa97d], [188, 0xaa0d], [195, 0xa95b],
] // prettier-ignore

/** [offset, bytes] planted in the handler body; every opcode here is gated. */
function plants(): [number, number[]][] {
  return [
    [2, [AND, 0x07]], // mask
    [9, [LDY, 0x66]], // row start: row 6, col 6, so 12 columns cross the screen edge
    [13, [LDA, 0x0b]], // 12 columns
    [17, [LDA, 0x02]], // 3 rows
    [26, [LDA, FILL]],
    [40, [ADC, 0x50]], // stride: rows 6, 11, then 16 through the carry
    [54, [LDA, 0x10]], // stamp pointer low byte: one row down
    [62, [LDA, 0x01]], // first stamp index
    [66, [LDA, 0x01]], // 2 stamps
    [70, [LDA, 0x01]], // 2 mid rows
    [76, [LDA_LONG_X, ...long(T_POS)]],
    [83, [LDA_LONG_X, ...long(T_POS_HI)]],
    [93, [LDA, 0x02]], // top 3 wide
    [97, [LDX, 0x01]], // X starts at 1
    [102, [LDA_LONG_X, ...long(T_DC)]],
    [123, [LDA_LONG_X, ...long(T_DC)]],
    [133, [LDA_LONG_X, ...long(T_DD)]],
    [143, [LDA_LONG_X, ...long(T_DE)]],
    [147, [STA_IND_Y, 0x6b]],
    [156, [INX, INX, INX]],
    [159, [LDA, 0x04]], // cap 5 wide
    [166, [LDA_LONG_X, ...long(T_DC)]],
    [181, [LDA, 0x03]], // base 4 wide
    [191, [LDA_LONG_X, ...long(T_DC)]],
    [212, [LDA, 0x02]], // first copy index
    [216, [LDA, 0x01]], // copy index high byte
    [226, [LDA_LONG_X, ...long(T_DST_LO)]],
    [232, [LDA_LONG_X, ...long(T_DST_HI)]],
    [238, [LDA, ...word(0x00ff)]], // low bytes: $100 moved
    [243, [LDA, ...word(0xc900)]], // from screen 0 row 16
    [255, [MVN, 0x7e, 0x7e]],
    [259, [LDA, ...word(0x00ef)]], // page bytes: $F0 moved, so row 15 keeps its page
    [264, [LDA, ...word(0xc900)]],
    [276, [MVN, 0x7f, 0x7f]],
    ...CALLS.map(([at, t]): [number, number[]] => [at, [JSR, ...word(t)]]),
  ]
}

type Edit = (buf: Buffer, h: number) => void

function cart(edit: Edit = () => {}): RomFile {
  const buf = Buffer.alloc(0x80000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode
  const h = off(HANDLER)
  for (const [at, bytes] of plants()) buf.set(bytes, h + at)
  // Stamps 0 and 3 are decoys; stamps 1 and 2 are drawn.
  const stamps = [0xca00, 0xc82d, 0xc8d3, 0xca00]
  stamps.forEach((p, i) => {
    buf[off(T_POS) + i] = p & 0xff
    buf[off(T_POS_HI) + i] = p >> 8
  })
  buf.set(DC, off(T_DC))
  buf.set(DD, off(T_DD))
  buf.set(DE, off(T_DE))
  // Copy targets: entry 2 -> screen 3, entry 3 -> screen 1, every other one
  // of the 16 -> screen 2, where the object sits, so a wrong index shows.
  for (let s = 0; s < 16; s++) {
    const p = s === 2 ? screenPtr(3) : s === 3 ? screenPtr(1) : screenPtr(2)
    buf.writeUInt16LE(p, off(T_DST_LO) + ENTRIES + s * 2)
    buf.writeUInt16LE(p, off(T_DST_HI) + ENTRIES + s * 2)
  }
  edit(buf, h)
  return new RomFile('synthetic.sfc', buf)
}

/** Screen 0 rows 16-26 hold page-1 tiles another object drew; the copy moves them. */
function prefilled(screens: number): TileGrid {
  const g = createGrid(screens)
  for (let r = 16; r < 27; r++) for (let c = 0; c < 16; c++) g[r][c] = 0x100 | ((r * 16 + c) & 0xff) // prettier-ignore
  return g
}

function run(
  rom: RomFile,
  x: number,
  y: number,
  size: number,
  screens = 4,
  vertical = false,
): TileGrid {
  const grid = vertical ? createGrid(screens, true) : prefilled(screens)
  const cur = makeCursor(grid, rom, 11, x, y, 0x37, size)
  cur.handlerAddr = HANDLER
  handle_0DDF3A(cur)
  return grid
}

const p1 = (lo: number): number => 0x100 | lo
const E = TILE_EMPTY
const cells = (g: TileGrid, r: number, c0: number, n: number): number[] => g[r].slice(c0, c0 + n)
const rows = (g: TileGrid, s: number, r0: number, n: number): number[][] =>
  g.slice(r0, r0 + n).map(r => r.slice(s * 16, s * 16 + 16))
const blank = (n: number): number[][] => Array.from({ length: n }, () => Array(16).fill(E))

describe('CODE_0DDF3A castle wall (synthetic cart)', () => {
  it('is dispatched: STANDARD_HANDLERS routes $0DDF3A to the port', () => {
    expect(STANDARD_HANDLERS[0x0ddf3a]).toBe(handle_0DDF3A)
  })

  it('fills rows from LDY #imm, STRIDE apart, wrapping at the screen edge and carrying', () => {
    // Object on screen 1; y=3 is ignored, LDY #imm replaces the position.
    // Size $09 & 7 = 1 copy, onto screen 3, clear of screens 1 and 2.
    const g = run(cart(), 16, 3, 0x09)
    for (const r of [6, 11, 16]) {
      expect(cells(g, r, 22, 12)).toEqual(Array(12).fill(p1(FILL)))
      expect(cells(g, r, 18, 4)).toEqual(Array(4).fill(E))
      expect(cells(g, r, 34, 4)).toEqual(Array(4).fill(E))
    }
    for (const r of [5, 21, 26]) expect(cells(g, r, 16, 32)).toEqual(Array(32).fill(E))
  })

  it('fills the lower half when the high coordinate is set, running on into the next screen', () => {
    const g = run(cart(), 64, 16, 0x09, 7)
    expect(cells(g, 22, 70, 12)).toEqual(Array(12).fill(p1(FILL)))
    expect(cells(g, 0, 86, 12)).toEqual(Array(12).fill(p1(FILL)))
    expect(cells(g, 5, 86, 12)).toEqual(Array(12).fill(p1(FILL)))
    expect(cells(g, 6, 64, 16)).toEqual(Array(16).fill(E))
  })

  it('stamps at column 13 wrap to the next screen at its row start', () => {
    // Pointer $C810 + $2D: row 3, col 13. Size $09 & 7 = 1 copy, onto screen 3.
    const g = run(cart(), 32, 0, 0x09)
    expect(cells(g, 3, 13, 4)).toEqual([...DC.slice(1, 4).map(p1), E])
    // Mid rows: X=4 into three tables, the third a raw STA with no INY.
    for (const r of [4, 5]) expect(cells(g, r, 12, 5)).toEqual([E, DC[4], DD[4], DE[4], E])
    // Cap and base run past col 15 into screen 1, restarting at col 0 of the row.
    expect(cells(g, 6, 13, 5)).toEqual(DC.slice(7, 12).map(p1))
    expect(cells(g, 7, 13, 4)).toEqual(DC.slice(12, 16))
    expect(cells(g, 5, 29, 3)).toEqual([E, E, E])
  })

  it('keeps the pointer low byte the last stamp left, and carries mid-stamp', () => {
    // Stamp 2 starts at hi $C8 with the $C0 low byte stamp 1's base row left: row 25.
    const g = run(cart(), 32, 0, 0x09)
    expect(cells(g, 25, 3, 3)).toEqual(DC.slice(1, 4).map(p1))
    // Its later rows restart from the bookmark ($C810 + $E3): rows 15, 16.
    for (const r of [15, 16]) expect(cells(g, r, 3, 3)).toEqual([DC[4], DD[4], DE[4]])
    expect(g[16][6]).toBe(0x100 | ((16 * 16 + 6) & 0xff)) // the mid rows leave column 3 alone
    // $F3 + $10 carries: cap at row 17, and the bookmark follows, so base is row 18.
    expect(cells(g, 17, 3, 5)).toEqual(DC.slice(7, 12).map(p1))
    expect(cells(g, 18, 3, 4)).toEqual(DC.slice(12, 16))
    expect(cells(g, 1, 0, 4)).toEqual([E, E, E, E]) // decoy stamp 0 not drawn
  })

  it('copies from srcLo/srcHi to the table entries from copyStart, lengths +1, overlap ascending', () => {
    // Size $0A & 7 = 2 copies: entry 2 (screen 3), then entry 3 (screen 1).
    const g = run(cart(), 32, 0, 0x0a)
    const src = rows(g, 0, 16, 11)
    expect(rows(g, 3, 0, 11)).toEqual(src)
    expect(rows(g, 3, 11, 5)).toEqual(blank(5))
    // Row 16 is past the copy; it keeps the fill that ran over from screen 2.
    expect(cells(g, 16, 48, 16)).toEqual([p1(FILL), p1(FILL), ...Array(14).fill(E)])
    expect(rows(g, 3, 17, 10)).toEqual(blank(10))
    expect(rows(g, 1, 0, 11)).toEqual(src)
    // Screen 1 overlaps its source: rows 11-15 re-read what rows 0-4 just got.
    expect(rows(g, 1, 11, 4)).toEqual(rows(g, 0, 16, 4))
    // Row 15 got its low bytes ($100 moved) but not its pages ($F0 moved).
    expect(rows(g, 1, 15, 1)[0]).toEqual(rows(g, 0, 20, 1)[0].map(v => v & 0xff))
    expect(rows(g, 1, 16, 11)).toEqual(blank(11))
    // Screen 2, the object's, is untouched by the copy.
    expect(cells(g, 6, 38, 10)).toEqual(Array(10).fill(p1(FILL)))
  })

  it('a size-0 object wraps its 8-bit counter: 256 copies, every table entry used', () => {
    const g = run(cart(), 32, 0, 0x08) // $08 & 7 = 0
    expect(rows(g, 2, 0, 11)).toEqual(rows(g, 0, 16, 11))
  })

  const declines = (edit: Edit): void => expect(run(cart(edit), 32, 0, 0x0a)).toEqual(prefilled(4))
  const hex = (n: number): string => '$' + n.toString(16).toUpperCase()

  it.each<[string, Edit]>([
    ...plants().map(([at]): [string, Edit] => [`the opcode at +${at} differs`, (b, h) => void (b[h + at] ^= 0xff)]),
    ...CALLS.map(([at, t]): [string, Edit] => [`the JSR at +${at} no longer reaches ${hex(t)}`, (b, h) => void (b[h + at + 2] ^= 0x01)]),
    ['the low-byte MVN names a bank other than $7E', (b, h) => void (b[h + 257] ^= 0x01)],
    ['the page-byte MVN names a bank other than $7F', (b, h) => void (b[h + 278] ^= 0x01)],
  ])('declines to draw when %s', (_, edit) => declines(edit)) // prettier-ignore

  it('declines quickly on a long INX run instead of counting it', () => {
    const t0 = Date.now()
    declines((b, h) => void b.fill(0xe8, h + 156, h + 156 + 0x1000))
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('declines to draw on a vertical level, whose Map16 layout it does not model', () => {
    expect(run(cart(), 0, 0, 0x02, 2, true)).toEqual(createGrid(2, true))
  })
})
