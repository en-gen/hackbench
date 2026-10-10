/**
 * The checking half of the capture viewer's decoders: the BG1 consistency
 * oracle and the comparison with Mesen's layer pictures. Node only; the page
 * gets capture_draw.ts, which this module re-exports.
 */
import {
  REF_DY,
  cellWord,
  decodeWord,
  drawBg,
  drawObj,
  gridDims,
  map16Id,
  map16Index,
  objAttr,
  stripOf,
  tilemapWordAddr,
} from './capture_draw'
import type { GridMeta, PipeInfo, Put, SpritePiece, WordFields } from './capture_draw'

export * from './capture_draw'

/** "$1B0", "0x1B0", "432" or a number; NaN when it is none of them. */
export function parseNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return NaN
  const s = v.trim()
  if (s.startsWith('$')) return parseInt(s.slice(1), 16)
  if (/^0x/i.test(s)) return parseInt(s.slice(2), 16)
  return /^\d+$/.test(s) ? parseInt(s, 10) : NaN
}

export function encodeWord(f: WordFields): number {
  return f.char | (f.pal << 10) | (f.prio << 13) | (f.flipX << 14) | (f.flipY << 15)
}

/**
 * Storage order of a Map16 tile's four words, as quadrant slots
 * (0 TL, 1 TR, 2 BL, 3 BR), from the names map16_defs.json writes. Null
 * unless all four are named once: never a vanilla default.
 */
export function parseQuadrantOrder(v: unknown): number[] | null {
  const names = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
  const order = Array.isArray(v) ? v.map(n => names.indexOf(n)) : []
  return order.length === 4 && new Set(order).size === 4 && !order.includes(-1) ? order : null
}

/**
 * The backdrop as the PPU outputs it, as 8-bit RGB: CGRAM color 0 through
 * color math with COLDATA's fixed color, or null where CGWSEL makes it
 * depend on the window registers (docs/capture-viewer.md, Backdrop).
 */
export function backdropRgb(cgram: Uint8Array, cgadsub: number, cgwsel: number, fixed: number) {
  const region = (cgwsel >> 4) & 3
  const black = (cgwsel >> 6) & 3
  if (black === 1 || black === 2 || region === 1 || region === 2) return null
  if (black === 3) return [0, 0, 0]
  const c0 = cgram[0] | (cgram[1] << 8)
  const out = [0, 5, 10].map(sh => {
    const [m, f] = [(c0 >> sh) & 31, (fixed >> sh) & 31]
    if (!(cgadsub & 0x20) || region === 3) return m
    return Math.min(31, Math.max(0, cgadsub & 0x80 ? m - f : m + f))
  })
  return out.map(c => (c << 3) | (c >> 2))
}

export interface RefPicture {
  x: number
  y: number
  w: number
  h: number
  px: Uint8ClampedArray
  /** The RGB Mesen drew where no layer pixel was, or null when not recorded. */
  sentinel: number[] | null
  /** Pixels (w wide) left out of the comparison: where the game drew Mario. */
  skip?: Uint8Array
}

/**
 * Count the pixels compared (`n`) and those where one of Mesen's isolated
 * layer pictures differs from our raster (`base`, RGBA, W wide, with
 * `opaque` set where a layer drew), placed at its camera, row dy below.
 * With a sentinel, transparency is compared on its own: our transparent
 * against the sentinel, our opaque against any other color, so opaque black
 * cannot pass for transparent. Without a sentinel only colors are compared,
 * and transparency is unverified.
 */
// prettier-ignore
export function refDiff(base: Uint8ClampedArray, opaque: Uint8Array, W: number, H: number, ref: RefPicture, dy: number) {
  let [n, differ] = [0, 0]
  const s = ref.sentinel
  for (let y = 0; y < ref.h; y++)
    for (let x = 0; x < ref.w; x++) {
      const [X, Y] = [ref.x + x, ref.y + dy + y]
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue
      if (ref.skip?.[y * ref.w + x]) continue
      const [i, j] = [(Y * W + X) * 4, (y * ref.w + x) * 4]
      const p = [ref.px[j], ref.px[j + 1], ref.px[j + 2]]
      const clearThere = s !== null && p[0] === s[0] && p[1] === s[1] && p[2] === s[2]
      const clearHere = !opaque[Y * W + X]
      const gap = s !== null && clearThere !== clearHere
      const both = s !== null && clearThere && clearHere
      n++
      if (gap || (!both && [0, 1, 2].some(c => base[i + c] !== p[c]))) differ++
    }
  return { n, differ }
}

/**
 * OAM entry i decoded, or null when it sits wholly below the screen.
 * High table: bit 0 is X bit 8, bit 1 selects the large size; OBSEL picks
 * the sizes and both name bases. y is the OAM line, wrapped above 0.
 */
export function oamEntry(oam: Uint8Array, i: number, obsel: number) {
  const hi = (oam[512 + (i >> 2)] >> ((i & 3) * 2)) & 3
  const o = objAttr(obsel, oam[i * 4 + 2], oam[i * 4 + 3], hi >> 1)
  const x = oam[i * 4] - (hi & 1 ? 256 : 0)
  let y = oam[i * 4 + 1]
  if (y >= 224 && y + o.h <= 256) return null
  if (y + o.h > 256) y -= 256
  return { i, x, y, ...o }
}

/** Draw OAM entries `ids` back to front at screen origin (x0, y0). */
// prettier-ignore
export function drawOam(oam: Uint8Array, ids: number[], obsel: number, vram: Uint8Array, x0: number, y0: number, put: Put) {
  for (const i of [...ids].sort((a, b) => b - a)) {
    const s = oamEntry(oam, i, obsel)
    if (s) drawObj(vram, s, x0 + s.x, y0 + s.y, put)
  }
}

/**
 * Whether two arrangements are the same drawing: the same tiles (char,
 * size, name table, palette, flips) at the same offsets from one another.
 * Priority bits and draw order are not compared.
 */
export function sameShape(a: SpritePiece[], b: SpritePiece[]) {
  const key = (ps: SpritePiece[]) =>
    ps.map(p => [p.dx - ps[0].dx, p.dy - ps[0].dy, p.tile, p.attr & 0xcf, p.large].join(',')).sort().join(';') // prettier-ignore
  return a.length > 0 && a.length === b.length && key(a) === key(b)
}

/**
 * The sprite's screen line: level Y minus camera Y, both 16-bit memory words
 * (a sprite above the level top reads ~65532), so signed from 16 bits, not
 * wrapped at 256.
 */
export const spriteScreenY = (spriteY: number, camY: number) =>
  ((spriteY - camY + 0x8000) & 0xffff) - 0x8000

/**
 * An OAM entry's offset from its sprite, both read the same frame. OAM X is
 * 9 bits (low byte plus high-table bit 8) and wraps, so the offset is taken
 * modulo 512 into -256..255, never by reading X as signed. Y is a screen line:
 * 224 or more is a piece straddling the top edge, read as line - 256 (agrees
 * with oamEntry for the pieces the caller keeps, at 8/16/32-line sizes); the
 * offset is not wrapped, since a piece can sit more than 128 lines from its
 * sprite (the $104 flame, #811). The caller drops pieces parked wholly
 * below the screen first (OAM line 224 or more, bottom at or before 256).
 */
// prettier-ignore
export function pieceOffset(oamX9: number, oamY: number, spriteX: number, spriteY: number, camX: number, camY: number) {
  const wrap = (v: number, m: number) => (((((v % m) + m) % m) + m / 2) % m) - m / 2
  const screenY = oamY >= 224 ? oamY - 256 : oamY
  return [wrap(oamX9 - (spriteX - camX), 512), screenY - spriteScreenY(spriteY, camY)]
}

/**
 * A recorded dy is the true offset modulo 256 in -128..127 (the recorder,
 * hackbench-validation capture/mesen/headless_capture.lua:1389, where sn.sy
 * is the sprite's level Y minus Layer1YPos, set at :1279-1283). Choose the
 * multiple of 256 that puts the piece on the visible window -32..223, which
 * is 256 wide and so unique. Limit: OBJ pieces run to 64 lines, so a 64-line
 * piece whose top is above line -32 yet still reaches the screen is placed
 * 256 lines too low (and then dropped as parked); 32 lines or less is exact.
 */
export function unwrapDy(dy: number, spriteY: number, camY: number) {
  const v = dy + spriteScreenY(spriteY, camY)
  return dy + (((((v + 32) % 256) + 256) % 256) - 32 - v)
}

/** One window as the SNES comparison needs it: its own VRAM, palette, OAM and scroll. */
export interface WindowInput {
  vram: Uint8Array
  pal: Uint8Array
  oam: Uint8Array | null
  regs: Record<string, number>
  /** BG1, BG2, BG3 scroll as [H, V] pairs. */
  scroll: number[][]
  player: number[]
  /** BG3 cells that are the status bar: neither drawn nor compared. */
  hideBg3?: number[]
}

/**
 * One layer of one window in that window's screen coordinates, as the
 * matching layer_*.png shows it: BGs from its VRAM at its scroll (PNG row y
 * is BG line V + y + REF_DY), OBJ from its OAM minus Mario's entries.
 */
// prettier-ignore
export function windowLayer(name: string, w: WindowInput, width = 256, height = 224) {
  const [idx, pri] = [new Uint8Array(width * height), new Uint8Array(width * height)]
  // Pixels left out of the comparison: Mario, and status bar cells.
  const skip = new Uint8Array(width * height)
  const R = w.regs
  const k = ['bg1', 'bg2', 'bg3'].indexOf(name)
  if (k >= 0) {
    const sc = [R.BG1SC_2107, R.BG2SC_2108, R.BG3SC_2109][k]
    const nba = [(R.BG12NBA_210B & 15) << 12, (R.BG12NBA_210B >> 4) << 12, (R.BG34NBA_210C & 15) << 12][k]
    const skipCells = k === 2 && w.hideBg3?.length ? new Set(w.hideBg3) : undefined
    drawBg(w.vram, sc, nba, k === 2 ? 2 : 4, [0, width, 0, height], w.scroll[k][0], w.scroll[k][1] + REF_DY, idx, pri, width, skipCells, skip)
  }
  // Mario is never drawn. The SNES picture shows him, so the pixels his
  // entries cover are left out of the comparison rather than counted.
  if (k < 0 && w.oam) {
    const ids = [...Array(128).keys()].filter(i => !w.player.includes(i))
    drawOam(w.oam, ids, R.OBSEL_2101, w.vram, 0, 0, (x, y, ci) => {
      if (x >= 0 && y >= 0 && x < width && y < height) idx[y * width + x] = ci
    })
    drawOam(w.oam, w.player, R.OBSEL_2101, w.vram, 0, 0, (x, y) => {
      if (x >= 0 && y >= 0 && x < width && y < height) skip[y * width + x] = 1
    })
  }
  const rgba = new Uint8ClampedArray(width * height * 4)
  const opaque = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++)
    if (idx[i]) {
      opaque[i] = 1
      rgba.set([w.pal[idx[i] * 3], w.pal[idx[i] * 3 + 1], w.pal[idx[i] * 3 + 2], 255], i * 4)
    }
  return { rgba, opaque, skip }
}

export interface OracleInput {
  vram: Uint8Array
  grid: Uint8Array
  defs: Uint8Array
  meta: GridMeta
  order: number[]
  bg1sc: number
  camX: number
  camY: number
  pipe: PipeInfo
  /** Look the grid up this many Map16 cells away from the tilemap cell. */
  shift?: number[]
  index?: typeof map16Index
  /** Cells the game generated before this frame: key row * cols + column, the id it wrote. */
  generated?: Map<number, number>
}

export interface Mismatch {
  tx: number
  ty: number
  id: number
  vram: number
  derived: number
}

export interface OracleResult {
  compared: number
  mismatches: Mismatch[]
  /** Cells drawn from a guess, so left out of the comparison. */
  guessed: number
  ids: number
  strips: number[]
  /** Generated cells compared against their generated tile instead of the load grid. */
  runtime?: number[]
}

/** Comparing nothing is not a pass: it is not compared. */
export function verdict(
  r: Pick<OracleResult, 'compared' | 'mismatches'>,
): 'pass' | 'fail' | 'not compared' {
  return r.compared === 0 ? 'not compared' : r.mismatches.length ? 'fail' : 'pass'
}

/**
 * Every BG1 cell of every strip the PPU holds must carry, in VRAM, the word
 * grid + defs give for that map coordinate: the 32 strips from the camera's
 * strip - 8, one trimmed at each end for upload lag (docs/capture-viewer.md,
 * Strip window). The derived word is decoded and re-encoded, so a field the
 * decoder drops (the viewer draws from those fields) shows as a mismatch.
 */
export function checkBg1(inp: OracleInput, decode = decodeWord): OracleResult {
  const { cols, rows } = gridDims(inp.meta)
  const vert = inp.meta.orientation === 'vertical'
  const cam = (vert ? inp.camY : inp.camX) >> 4
  const [sx, sy] = inp.shift ?? [0, 0]
  // The strips that exist, which are the ones compared; empty when none do.
  const strips = [Math.max(0, cam - 7), Math.min(cam + 22, (vert ? rows : cols) - 1)]
  const out: OracleResult = { compared: 0, mismatches: [], guessed: 0, ids: 0, strips }
  const ids = new Set<number>()
  for (let s = strips[0]; s <= strips[1]; s++) {
    for (let k = 0; k < (vert ? cols : rows); k++) {
      const [c, r] = vert ? [k, s] : [s, k]
      const [gc, gr] = [c + sx, r + sy]
      if (gc < 0 || gr < 0 || gc >= cols || gr >= rows) continue
      const made = inp.generated?.get(gr * cols + gc)
      if (made !== undefined) (out.runtime ??= []).push(gr * cols + gc)
      const id = made ?? map16Id(inp.grid, inp.meta, gc, gr, inp.index)
      const hasDef = id < inp.defs.length >> 3
      const strip = stripOf(inp.meta, gc, gr)
      if (hasDef && cellWord(inp.defs, inp.order, inp.pipe, id, strip, 0).guess) {
        out.guessed += 4
        continue
      }
      ids.add(id)
      for (let q = 0; q < 4; q++) {
        const [tx, ty] = [c * 2 + (q & 1), r * 2 + (q >> 1)]
        const a = tilemapWordAddr(inp.bg1sc, tx, ty) * 2
        const got = inp.vram[a] | (inp.vram[a + 1] << 8)
        const word = hasDef
          ? cellWord(inp.defs, inp.order, inp.pipe, id, strip, q).word | (inp.meta.wordOr ?? 0)
          : -1
        const derived = hasDef ? encodeWord(decode(word)) : -1
        out.compared++
        if (got !== derived) out.mismatches.push({ tx, ty, id, vram: got, derived })
      }
    }
  }
  out.ids = ids.size
  return out
}

/**
 * The misplacements a passing check should have caught, and which of them
 * would not have failed: a map where any would not is only weakly checked.
 * A variant that compares nothing catches nothing, so it counts too.
 */
export function blindSpots(inp: OracleInput): string[] {
  const m = inp.meta
  const variants: [string, Partial<OracleInput>][] = [
    ['x+16', { shift: [1, 0] }],
    ['x-16', { shift: [-1, 0] }],
    ['y+16', { shift: [0, 1] }],
    ['y-16', { shift: [0, -1] }],
    ['stride+1', { meta: { ...m, bytesPerScreen: m.bytesPerScreen + 1 } }],
    ['stride-1', { meta: { ...m, bytesPerScreen: m.bytesPerScreen - 1 } }],
  ]
  if (m.orientation === 'vertical') {
    const noHalf = (g: GridMeta, c: number, r: number) => map16Index(g, c & 15, r)
    variants.push(['half-screen term', { index: noHalf }])
  }
  return variants.filter(([, v]) => verdict(checkBg1({ ...inp, ...v })) !== 'fail').map(([n]) => n)
}
