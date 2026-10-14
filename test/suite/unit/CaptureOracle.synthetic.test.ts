/**
 * The capture viewer's decoders and BG1 oracle (tools/scripts/capture_decode.ts)
 * must go red on each defect they exist to catch. Synthetic bytes only: CI
 * has no ROM and no Mesen captures.
 *
 * Fixtures are laid out with their own arithmetic, not the module's
 * helpers, so a helper bug cannot also shape the expected bytes.
 */
import { describe, expect, it } from 'vitest'
import * as D from '../../../tools/scripts/capture_decode'
import { fixture, NAMES, POS, addr64 } from './fixtures/captureFixture'

const red = (inp: D.OracleInput, decode?: typeof D.decodeWord) =>
  expect(D.verdict(D.checkBg1(inp, decode))).toBe('fail')
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
/** Registers for a map-wide render: BG2 map at $3000, BG3 map at $5000 with chars at $4000. */
const REGS = { BGMODE_2105: 1, BG2SC_2108: 0x33, BG12NBA_210B: 0, BG3SC_2109: 0x53, BG34NBA_210C: 4, OBSEL_2101: 0 } // prettier-ignore
const noScroll = [
  [0, 0],
  [0, 0],
  [0, 0],
]

describe('capture BG1 oracle', () => {
  it.each([false, true])('passes a capture whose VRAM matches (vertical %s)', vertical => {
    const r = D.checkBg1(fixture({ vertical }))
    expect(r.compared).toBe(30 * (vertical ? 32 : 27) * 4)
    expect(r.mismatches).toEqual([])
    expect(r.ids).toBeGreaterThan(100)
    expect(r.strips).toEqual([1, 30])
    expect(D.blindSpots(fixture({ vertical }))).toEqual([])
  })

  it('goes red on the wrong quadrant order', () => red({ ...fixture(), order: [0, 1, 2, 3] }))

  it('goes red on a quadrant order applied as order[q] instead of order.indexOf(q)', () => {
    // POS is the inverse of the named order, so indexOf over it equals order[q].
    red({ ...fixture(), order: POS })
  })

  it.each([-1, 1, 16])('goes red on screen stride off by %i', d => {
    const f = fixture()
    red({ ...f, meta: { ...f.meta, bytesPerScreen: f.meta.bytesPerScreen + d } })
  })

  it('goes red when the decoder ignores flipX', () => {
    const r = D.checkBg1(fixture(), w => ({ ...D.decodeWord(w), flipX: 0 }))
    expect(r.mismatches.length).toBeGreaterThan(0)
    expect(r.mismatches.every(m => m.vram & 0x4000)).toBe(true)
  })

  it('goes red on the wrong BG1SC base', () => red({ ...fixture(), bg1sc: 0x27 }))

  it.each([
    [
      'half-screen term zeroed',
      (m: D.GridMeta, c: number, r: number) => D.map16Index(m, c & 15, r),
    ],
    ['row and column swapped', (m: D.GridMeta, c: number, r: number) => D.map16Index(m, r, c)],
  ])('goes red on a vertical index with the %s', (_, index) => {
    red({ ...fixture({ vertical: true }), index })
  })

  it('reports a camera outside the map as not compared, not as a pass', () => {
    const r = D.checkBg1({ ...fixture(), camX: 0x4000 })
    expect(r.compared).toBe(0)
    expect(D.verdict(r)).toBe('not compared')
    expect(D.checkBg1({ ...fixture(), camX: 0 }).strips).toEqual([0, 22]) // only strips that exist
  })

  it('names the misplacements a one-tile level could not catch', () => {
    const f = fixture({ ids: () => 7 })
    expect(D.verdict(D.checkBg1(f))).toBe('pass')
    expect(D.blindSpots(f)).toEqual(expect.arrayContaining(['x+16', 'y-16', 'stride-1']))
  })

  // Every id is a pipe here, and strip 5 has a recorded variant: the words
  // defs give, in quadrant order, so the fixture's VRAM agrees with it.
  const variant = (defs: Uint8Array) =>
    Array.from({ length: 512 * 4 }, (_, k) => {
      const [id, q] = [k >> 2, k & 3]
      return defs[id * 8 + POS[q] * 2] | (defs[id * 8 + POS[q] * 2 + 1] << 8)
    })

  it('compares pipe cells with their column variant, and leaves unrecorded ones out', () => {
    const f = fixture()
    const pipe = { lo: 0, hi: 511, strips: { 5: variant(f.defs) } }
    const r = D.checkBg1({ ...f, pipe })
    expect(r.compared).toBe(27 * 4)
    expect(r.guessed).toBe(29 * 27 * 4)
    f.vram[addr64(10, 3) * 2] ^= 1 // strip 5, row 1
    expect(D.verdict(D.checkBg1({ ...f, pipe }))).toBe('fail')
  })

  it("goes red on a pipe drawn with another entry's variant", () => {
    const f = fixture()
    const other = variant(f.defs.map(b => b ^ 0x5a))
    expect(D.verdict(D.checkBg1({ ...f, pipe: { lo: 0, hi: 511, strips: { 5: other } } }))).toBe(
      'fail',
    )
  })

  it('draws a pipe cell without its variant from the resident defs, and lists it as a guess', () => {
    const f = fixture()
    const vram = f.vram.slice()
    vram.fill(0xff, 0x8000) // every char at name base word $4000 is solid color 15
    const run = (strips: Record<string, number[]>) =>
      D.foreground(vram, f.grid, f.defs, f.meta, f.order, { lo: 0, hi: 511, strips }, 0x4000)
    const guessed = run({})
    expect(guessed.guesses.length).toBe(48 * 27)
    expect(guessed.guesses[0].reason).toMatch(/^Guess: pipe color\./)
    expect(guessed.idx.slice(0, 16).every(v => v !== 0)).toBe(true) // drawn, not blank
    const all = Object.fromEntries(Array.from({ length: 48 }, (_, s) => [s, variant(f.defs)]))
    const known = run(all)
    expect(known.guesses).toEqual([])
    expect(known.idx).toEqual(guessed.idx)
  })

  it('ORs the recorded word mask into every drawn and compared word', () => {
    const f = fixture()
    const vram = f.vram.slice()
    vram.fill(0xff, 0x8000) // every char at name base word $4000 is solid color 15
    const pals = (meta: D.GridMeta) => [...D.foreground(vram, f.grid, f.defs, meta, f.order, D.NO_PIPES, 0x4000).idx].map(v => v >> 4) // prettier-ignore
    const [plain, ored] = [pals(f.meta), pals({ ...f.meta, wordOr: 0x1000 })]
    expect(plain.some(p => p < 4)).toBe(true) // some palette the mask changes
    expect(ored.filter((p, i) => p !== (plain[i] | 4)).length).toBe(0)
    // The same mask on the compare side: the fixture's VRAM holds the words without it.
    red({ ...fixture(), meta: { ...f.meta, wordOr: 0x1000 } })
  })

  it('gives a missing def no word, which never matches', () => {
    const f = fixture()
    const r = D.checkBg1({ ...f, defs: f.defs.slice(0, 8 * 256) })
    expect(r.mismatches.some(m => m.derived === -1)).toBe(true)
  })

  it('refuses a quadrant order the capture did not name in full', () => {
    expect(D.parseQuadrantOrder(NAMES)).toEqual([1, 2, 3, 0])
    expect(D.parseQuadrantOrder(undefined)).toBeNull()
    expect(D.parseQuadrantOrder(['top-left', 'top-left', 'top-right', 'bottom-right'])).toBeNull()
  })
})

describe('SNES picture comparison', () => {
  const MAGENTA = [255, 0, 255]
  // One pixel: ours (RGB, opaque or not) against Mesen's (RGB), optional sentinel.
  function one(ours: number[], drawn: boolean, theirs: number[], sentinel: number[] | null) {
    const base = new Uint8ClampedArray([...ours, 255])
    const ref = { x: 0, y: 0, w: 1, h: 1, px: new Uint8ClampedArray([...theirs, 255]), sentinel }
    return D.refDiff(base, new Uint8Array([drawn ? 1 : 0]), 1, 1, ref, 0).differ
  }
  it('goes red when ours is transparent but the SNES drew opaque black', () => {
    expect(one([0, 0, 0], false, [0, 0, 0], MAGENTA)).toBe(1)
  })
  it('goes red when ours drew opaque black but the SNES left it transparent', () => {
    expect(one([0, 0, 0], true, MAGENTA, MAGENTA)).toBe(1)
  })
  it('matches transparent with transparent whatever the backdrop colors', () => {
    expect(one([0, 99, 189], false, MAGENTA, MAGENTA)).toBe(0)
  })
  it('compares opaque colors, and only colors when no sentinel was recorded', () => {
    expect(one([8, 16, 24], true, [8, 16, 24], MAGENTA)).toBe(0)
    expect(one([8, 16, 24], true, [8, 16, 32], MAGENTA)).toBe(1)
    expect(one([0, 0, 0], false, [0, 0, 0], null)).toBe(0) // unverified, not caught
  })
})

describe('Sprites layer', () => {
  const W = 512
  const vram = new Uint8Array(0x10000).fill(0xff) // every char solid
  const count = (idx: Uint8Array) => idx.reduce((n, v) => n + (v ? 1 : 0), 0)
  // One sprite of one large (16x16 under OBSEL size 0) piece at its list position.
  const one: D.SpritePiece[] = [{ i: 5, dx: 0, dy: 0, tile: 0, attr: 0, large: 1 }]
  const spawn = (x: number, reason = '', pieces: D.SpritePiece[] | null = one) =>
    ({ id: 0xbd, x, y: 0, pieces, obsel: 0, reason }) // prettier-ignore

  it('draws a sprite straddling a screen boundary whole, and once', () => {
    const r = D.spriteLayer([spawn(250)], vram, W, 32)
    expect(count(r.idx)).toBe(16 * 16)
    expect(r.idx[D.REF_DY * W + 250] && r.idx[D.REF_DY * W + 265]).toBeTruthy()
  })

  it('marks an unrecorded sprite as a guess and does not draw it', () => {
    const r = D.spriteLayer([spawn(40, 'Its spawn was not recorded', null)], vram, W, 32)
    expect(r.guesses.map(g => g.reason)).toEqual([
      'Guess: sprite $BD. Its spawn was not recorded; marked at its list position, not drawn.',
    ])
    expect(count(r.idx)).toBe(0)
  })

  it('offsets an entry by 9-bit X modulo 512, never by reading X as signed', () => {
    // Sprite at screen x 264 (off the right edge), entry drawn 8 px left of it at screen 256.
    expect(D.pieceOffset(256, 100, 1264, 300, 1000, 200)).toEqual([-8, 0])
    expect(D.pieceOffset(264 + 48, 110, 1264, 300, 1000, 200)).toEqual([48, 10])
    expect(D.pieceOffset(8, 100, 504 + 1000, 300, 1000, 200)).toEqual([16, 0]) // wraps past 511
  })

  it('does not wrap the Y offset: a piece far above or below its sprite keeps its distance (#811)', () => {
    // Sprite at screen y 100 (spriteY 300, camY 200); sweep the piece's screen line.
    for (let y = 0; y < 224; y += 7) {
      expect(D.pieceOffset(0, y, 1000, 300, 1000, 200)[1]).toBe(y - 100)
    }
    // Past +127 and past -128 relative to the sprite: sprite at screen y 10 and 200.
    expect(D.pieceOffset(0, 200, 1000, 210, 1000, 200)[1]).toBe(190)
    expect(D.pieceOffset(0, 5, 1000, 400, 1000, 200)[1]).toBe(-195)
    // Sprite off the screen below, piece drawn well above it (past -255).
    expect(D.pieceOffset(0, 20, 1000, 600, 1000, 200)[1]).toBe(-380)
  })

  it('reads the sprite-to-camera difference as signed 16 bits, never mod 256 (#811)', () => {
    // A sprite above the level top reads 65532 against camera 0: screen y -4.
    expect(D.pieceOffset(0, 4, 1000, 65532, 1000, 0)[1]).toBe(8)
  })

  it('puts the $E0 boundary exactly at line 224 (#811)', () => {
    expect(D.pieceOffset(0, 223, 1000, 300, 1000, 200)[1]).toBe(123)
    expect(D.pieceOffset(0, 224, 1000, 300, 1000, 200)[1]).toBe(-132)
    for (let y = 216; y < 224; y++)
      expect(D.pieceOffset(0, y, 1000, 300, 1000, 200)[1]).toBe(y - 100)
  })

  it('unwrapDy window runs -32..223 (#811)', () => {
    expect(D.unwrapDy(-33, 500, 500)).toBe(223)
    expect(D.unwrapDy(-32, 500, 500)).toBe(-32)
    expect(D.unwrapDy(223, 500, 500)).toBe(223)
  })

  it('unwrapDy picks the multiple of 256 that lands on the visible screen (#811)', () => {
    for (let sy = -32; sy < 224; sy += 5)
      for (let line = -32; line < 224; line += 11) {
        const trueDy = line - sy
        const recorded = ((((trueDy + 128) % 256) + 256) % 256) - 128
        expect(D.unwrapDy(recorded, 500 + sy, 500)).toBe(trueDy)
      }
  })

  it('reads an OAM line of $E0 or more as above the top edge (#811)', () => {
    // Straddling piece at line 240 is screen y -16; sprite at screen y 4.
    expect(D.pieceOffset(0, 240, 1000, 204, 1000, 200)[1]).toBe(-20)
    for (let y = 224; y < 256; y += 5) {
      expect(D.pieceOffset(0, y, 1000, 300, 1000, 200)[1]).toBe(y - 256 - 100)
    }
  })
})

// A char whose every pixel is color c (4bpp) at byte address a.
function solid(vram: Uint8Array, a: number, c: number) {
  for (let y = 0; y < 8; y++)
    for (let p = 0; p < 4; p++) vram[a + (p >> 1) * 16 + y * 2 + (p & 1)] = (c >> p) & 1 ? 0xff : 0
}

describe('window comparison', () => {
  it("draws a window's BG at that window's own scroll, not the level origin", () => {
    const vram = new Uint8Array(0x10000)
    // BG1 map at word $2000, 64x64; tile column tx uses char tx & 7, char c solid color c + 1.
    for (let ty = 0; ty < 64; ty++)
      for (let tx = 0; tx < 64; tx++) vram[addr64(tx, ty) * 2] = tx & 7
    for (let c = 0; c < 8; c++) solid(vram, c * 32, c + 1)
    const pal = new Uint8Array(768).map((_, i) => i)
    const regs = { ...REGS, BG1SC_2107: 0x23 }
    const at = (scrollX: number) =>
      D.windowLayer('bg1', { vram, pal, oam: null, regs, scroll: [[scrollX, 0], ...noScroll.slice(1)], player: [] }).rgba[0] // prettier-ignore
    expect(at(0)).toBe(pal[1 * 3]) // column 0: char 0, color 1
    expect(at(24)).toBe(pal[4 * 3]) // scrolled 3 columns: char 3, color 4
  })
})

describe('OBJ decode', () => {
  const vram = new Uint8Array(0x10000)
  solid(vram, 0, 1) // char 0: the top-left 8x8 of a 16x16 at tile 0
  solid(vram, 32, 2) // char 1: its top-right
  const row0 = (attr: number) => {
    const out = new Array(16).fill(0)
    D.drawObj(vram, D.objAttr(0, 0, attr, 1), 0, 0, (x, y, ci) => {
      if (y === 0) out[x] = ci & 15
    })
    return [out[0], out[15]]
  }
  it('mirrors a whole 16x16 under flipX, not each 8x8 in place', () => {
    expect(row0(0)).toEqual([1, 2])
    expect(row0(0x40)).toEqual([2, 1])
  })
  /** A window whose only visible OAM entry is Mario's (66), an 8x8 at (x, x). */
  const marioWindow = (x: number) => {
    const oam = new Uint8Array(544)
    for (let i = 0; i < 128; i++) oam[i * 4 + 1] = 0xf0
    oam.set([x, x, 0, 0], 66 * 4)
    return { vram, pal: new Uint8Array(768).fill(9), oam, regs: { OBSEL_2101: 0 }, scroll: noScroll, player: [66] } // prettier-ignore
  }
  it("leaves Mario's pixels out of the comparison, where the SNES picture still shows him", () => {
    const l = D.windowLayer('obj', marioWindow(0), 8, 8)
    const snes = new Uint8ClampedArray(8 * 8 * 4).fill(9) // opaque everywhere Mario is
    const pic = { x: 0, y: 0, w: 8, h: 8, px: snes, sentinel: [255, 0, 255] }
    expect(D.refDiff(l.rgba, l.opaque, 8, 8, { ...pic, skip: l.skip }, 0)).toEqual({ n: 0, differ: 0 }) // prettier-ignore
    expect(D.refDiff(l.rgba, l.opaque, 8, 8, pic, 0).differ).toBe(64)
  })

  it("leaves Mario's entries out of a window's sprites", () => {
    const w = marioWindow(10)
    expect(D.windowLayer('obj', w).opaque.some(v => v)).toBe(false)
    expect(D.windowLayer('obj', { ...w, player: [] }).opaque.some(v => v)).toBe(true)
  })
})

describe('Effects tiling', () => {
  // BG3 map at word $5000 (64x64): every cell char 1, which is solid color 3 (2bpp).
  const f = fixture()
  const vram = new Uint8Array(0x10000)
  for (let a = 0x5000; a < 0x6000; a++) vram[a * 2] = 1
  for (let y = 0; y < 8; y++) vram[0x8000 + 16 + y * 2] = vram[0x8000 + 16 + y * 2 + 1] = 0xff
  const render = (hideBg3?: number[]) => D.renderLevel({ meta: f.meta, order: f.order, pipe: f.pipe, background: 'none', grid: b64(f.grid), defs: b64(f.defs), vram: b64(vram), regs: REGS, spawns: [], hideBg3 }) // prettier-ignore

  it('draws the whole BG3 tilemap tiled 1:1 from the map origin, not only the camera window', () => {
    const r = render()
    const fx = r.layers[2].idx
    for (const [x, y] of [
      [0, 0],
      [300, 5],
      [700, 400],
      [r.W - 1, r.H - 1],
    ])
      expect(fx[y * r.W + x]).toBe(3)
    expect(r.layers[1].idx.every(v => v === 0)).toBe(true) // no Background
  })

  it('leaves the status bar cells out of the drawing and out of a window comparison', () => {
    // Cell (2, 1) of the 64-wide map is the status bar: 1 * 64 + 2.
    const hideBg3 = [66]
    const r = render(hideBg3)
    const fx = r.layers[2].idx
    expect(fx[12 * r.W + 20]).toBe(0) // inside cell (2, 1)
    expect(fx[12 * r.W + 12]).toBe(3) // cell (1, 1), drawn
    const w = { vram, pal: new Uint8Array(768), oam: null, regs: REGS, scroll: noScroll, player: [], hideBg3 } // prettier-ignore
    const win = D.windowLayer('bg3', w, 32, 32)
    // REF_DY: window row y shows map row y + 1, so cell row 1 covers y 7..14.
    expect(win.skip[10 * 32 + 20]).toBe(1)
    expect(win.opaque[10 * 32 + 20]).toBe(0)
    expect(win.skip[10 * 32 + 12]).toBe(0)
    expect(win.opaque[10 * 32 + 12]).toBe(1)
  })
})

describe('Background tiling', () => {
  it('tiles a 512 px BG2 map 1:1 from the map origin with no seam at x = 256', () => {
    const f = fixture()
    const vram = new Uint8Array(0x10000)
    // BG2 map at word $3000 (64x64): column tx uses char 1 + (tx & 7) and palette row
    // (tx >> 3) & 7, so every one of the 64 columns differs and the period is 512 px.
    for (let ty = 0; ty < 64; ty++)
      for (let tx = 0; tx < 64; tx++) {
        const a = addr64(tx, ty, 0x3000)
        vram[a * 2] = 1 + (tx & 7)
        vram[a * 2 + 1] = ((tx >> 3) & 7) << 2
      }
    for (let c = 1; c < 9; c++) solid(vram, 0x8000 + c * 32, c) // BG2 chars at word $4000
    const regs = { ...REGS, BG12NBA_210B: 0x40 }
    const r = D.renderLevel({ meta: f.meta, order: f.order, pipe: f.pipe, background: 'preset', grid: b64(f.grid), defs: b64(f.defs), vram: b64(vram), regs, spawns: [] }) // prettier-ignore
    const bg = r.layers[1].idx
    const want = (x: number) => (((x % 512) >> 6) & 7) * 16 + 1 + (((x % 512) >> 3) & 7)
    for (const x of [0, 250, 255, 256, 257, 262, 511, 512, 700])
      expect(bg[5 * r.W + x]).toBe(want(x))
  })
})

describe('SNES decoders', () => {
  it.each([
    [4, [0x80, 0x80], [0x00, 0x80], 11],
    [2, [0x80, 0x00], [0xff, 0xff], 1], // the next char is set: a 2bpp read must not reach it
  ])('%sbpp reads each plane from its own byte', (bpp, lo, hi, want) => {
    const vram = new Uint8Array(0x10000)
    const a = 0x1000 * 2 + bpp * 8 // base word $1000, char 1
    vram.set(lo, a + 2)
    vram.set(hi, a + 16 + 2)
    expect(D.charPixel(vram, 0x1000, bpp, 1, 0, 1)).toBe(want)
    expect(D.charPixel(vram, 0x1000, bpp, 1, 1, 1)).toBe(0)
  })

  it('draws the backdrop through color math with the fixed color, never halved', () => {
    const c0 = new Uint8Array([10 | (20 << 5) | (30 << 10), (10 | (20 << 5) | (30 << 10)) >> 8])
    const fixed = 5 | (15 << 5) | (31 << 10)
    const w = (c: number) => (c << 3) | (c >> 2)
    expect(D.backdropRgb(c0, 0x20, 0x02, fixed)).toEqual([15, 31, 31].map(w)) // add, clamped
    expect(D.backdropRgb(c0, 0x60, 0x02, fixed)).toEqual([15, 31, 31].map(w)) // half ignored
    expect(D.backdropRgb(c0, 0xa0, 0x00, fixed)).toEqual([5, 5, 0].map(w)) // subtract, clamped
    expect(D.backdropRgb(c0, 0x00, 0x02, fixed)).toEqual([10, 20, 30].map(w)) // backdrop not enabled
    expect(D.backdropRgb(c0, 0x20, 0x30, fixed)).toEqual([10, 20, 30].map(w)) // math never
    expect(D.backdropRgb(c0, 0x20, 0xc0, fixed)).toEqual([0, 0, 0]) // forced black
    expect(D.backdropRgb(c0, 0x20, 0x10, fixed)).toBeNull() // depends on the math window
    expect(D.backdropRgb(c0, 0x20, 0x40, fixed)).toBeNull()
  })

  it('widens BGR555 to 8 bits per channel in RGB order', () => {
    const w = 31 | (16 << 5) | (1 << 10)
    expect(D.bgr555(new Uint8Array([w & 255, w >> 8]), 0)).toEqual([255, 132, 8])
  })

  it('addresses all four screens of a 64x64 map, wrapping at 32K words', () => {
    const quads = [0, 32].flatMap(ty => [0, 32].map(tx => D.tilemapWordAddr(0x23, tx, ty)))
    expect(quads).toEqual([0x2000, 0x2400, 0x2800, 0x2c00])
    expect(D.tilemapWordAddr(0x21, 5, 33)).toBe(0x2000 + 32 + 5) // 64x32 wraps vertically
    expect(D.tilemapWordAddr(0xa3, 3, 40)).toBe(D.tilemapWordAddr(0x23, 3, 40))
  })

  it('orders mode 1 layers front to back, BG3 high on top only with BGMODE bit 3', () => {
    const mid = [
      [3, 3],
      [0, 1],
      [1, 1],
      [3, 2],
      [0, 0],
      [1, 0],
      [3, 1],
    ]
    expect(D.layerOrder(0x09)).toEqual([[2, 1], ...mid, [3, 0], [2, 0]])
    expect(D.layerOrder(0x01)).toEqual([...mid, [2, 1], [3, 0], [2, 0]])
  })

  it('decodes OAM with the high table, OBSEL sizes and both name bases', () => {
    const oam = new Uint8Array(544)
    for (let i = 0; i < 128; i++) oam[i * 4 + 1] = 0xf0 // hidden below the screen
    oam.set([0x10, 20, 0x1f, 0x01 | (2 << 1) | (3 << 4) | 0x40], 0)
    oam.set([0x30, 0xf8, 0x02, 0x80], 4) // straddles the top edge
    oam[512] = 0b1011 // entry 0: X bit 8 and large; entry 1: large
    const obsel = (3 << 5) | (1 << 3) | 3 // 16/32, name base word $6000, second table + $2000
    const s = [1, 0].map(i => D.oamEntry(oam, i, obsel)!)
    expect(D.oamEntry(oam, 2, obsel)).toBeNull()
    expect(s[1]).toMatchObject({ x: 0x10 - 256, y: 20, w: 32, h: 32, pal: 2, prio: 3 })
    expect(s[1].base).toBe(0x6000 + 0x2000)
    expect(s[1].flipX).toBeTruthy()
    expect(s[0]).toMatchObject({ x: 0x30, y: 0xf8 - 256, w: 32, h: 32, base: 0x6000 })
    expect(D.spriteChar(0x1f, 1, 1)).toBe(0x20) // low nibble wraps, row adds $10
    expect(D.spriteChar(0xf0, 0, 1)).toBe(0x00)
  })
})
