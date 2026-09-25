/**
 * The drawing half of the capture viewer's decoders: everything a map page
 * needs to draw. page() copies every export of this module into the page
 * (functions by Function.toString, constants as JSON), so each may reference
 * only the others and builtins. The checks are in capture_decode.ts.
 *
 * Written fresh on purpose: these validate captures that in turn validate
 * src/rom/, so importing its decoders would let one bug hide on both sides.
 * Formats: PPU register layouts per SMWDisX hardware_registers.asm (OBJSEL
 * :19-37, BGMODE :59-76, BGnSC :90-101, BG12NBA :146-153); tilemap word,
 * planar 2bpp/4bpp, BGR555, OAM and the mode 1 layer order per the Super
 * Famicom Development Wiki (docs/references.md:29).
 */

export interface WordFields {
  char: number
  pal: number
  prio: number
  flipX: number
  flipY: number
}

export interface GridMeta {
  orientation: string
  screens: number
  bytesPerScreen: number
  /** File offsets of the low and high planes, and of Layer 1 within each. */
  lowOffset: number
  highOffset: number
  base: number
  /** OR'd into every tile word, as the game's strip upload does (the capture records it). */
  wordOr?: number
}

/**
 * Map16 ids lo..hi whose words differ per strip, and for each strip whose
 * variant the capture holds, 4 words per id in quadrant order (TL TR BL BR).
 */
export interface PipeInfo {
  lo: number
  hi: number
  strips: Record<string, number[]>
}

/** No pipe range: every id takes the resident defs. */
export const NO_PIPES: PipeInfo = { lo: 1, hi: 0, strips: {} }

/** A cell drawn from data the capture cannot confirm, and why, in plain language. */
export interface Guess {
  c: number
  r: number
  kind: 'pipe' | 'sprite'
  reason: string
}

/** The first visible line shows map row camera Y + 1 (docs/capture-viewer.md, REF_DY). */
export const REF_DY = 1

/** `$1B0`, zero-padded to `w` digits; `prefix` '' for a bare label. */
export function hex(n: number, w = 0, prefix = '$') {
  return prefix + n.toString(16).toUpperCase().padStart(w, '0')
}

/** A tile word, or `no def` for a Map16 id past the defs. */
export function hexWord(w: number) {
  return w < 0 ? 'no def' : hex(w)
}

export function decodeWord(w: number): WordFields {
  // prettier-ignore
  return { char: w & 0x3ff, pal: (w >> 10) & 7, prio: (w >> 13) & 1, flipX: (w >> 14) & 1, flipY: (w >> 15) & 1 }
}

export function gridDims(m: GridMeta): { cols: number; rows: number } {
  return m.orientation === 'vertical'
    ? { cols: 32, rows: m.screens * 16 }
    : { cols: m.screens * 16, rows: m.bytesPerScreen / 16 }
}

/**
 * Byte offset of Map16 cell (c, r) in one plane. The in-screen layouts are the
 * two map16_grid.json states; loadLevel refuses any other.
 */
export function map16Index(m: GridMeta, c: number, r: number): number {
  if (m.orientation === 'vertical') {
    return m.base + (r >> 4) * m.bytesPerScreen + (c >> 4) * 0x100 + (r & 15) * 16 + (c & 15)
  }
  return m.base + (c >> 4) * m.bytesPerScreen + r * 16 + (c & 15)
}

/** The id is (high & 1) * 256 + low, the rule map16_grid.json states. */
export function map16Id(grid: Uint8Array, m: GridMeta, c: number, r: number, index = map16Index) {
  const i = index(m, c, r)
  return grid[m.lowOffset + i] | ((grid[m.highOffset + i] & 1) << 8)
}

/** The word for quadrant (dx, dy) of Map16 tile `id`; defs hold 4 LE words per tile. */
export function defWord(defs: Uint8Array, order: number[], id: number, dx: number, dy: number) {
  const o = id * 8 + order.indexOf((dy << 1) | dx) * 2
  return defs[o] | (defs[o + 1] << 8)
}

/** A strip is a column in a horizontal map and a row in a vertical one. */
export function stripOf(m: GridMeta, c: number, r: number) {
  return m.orientation === 'vertical' ? r : c
}

/**
 * The word for quadrant q of a cell: a pipe's per-strip variant when the
 * capture holds it, else the resident defs. `guess` marks a pipe whose
 * strip variant is missing, drawn with the resident one (right shape,
 * possibly the wrong color).
 */
// prettier-ignore
export function cellWord(defs: Uint8Array, order: number[], p: PipeInfo, id: number, strip: number, q: number) {
  const pipe = id >= p.lo && id <= p.hi
  const w = pipe ? p.strips[strip] : undefined
  const word = w ? w[(id - p.lo) * 4 + q] : defWord(defs, order, id, q & 1, q >> 1)
  return { word, guess: pipe && !w }
}

/**
 * The Foreground raster (BG1 from grid + defs) for the whole map: CGRAM
 * index per pixel (0 = transparent, as color 0 of a row never draws), the
 * tilemap priority bit, and every cell drawn from a guess.
 */
// prettier-ignore
export function foreground(vram: Uint8Array, grid: Uint8Array, defs: Uint8Array, meta: GridMeta, order: number[], p: PipeInfo, base: number) {
  const { cols, rows } = gridDims(meta)
  const W = cols * 16
  const idx = new Uint8Array(W * rows * 16)
  const pri = new Uint8Array(W * rows * 16)
  const guesses: Guess[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const id = map16Id(grid, meta, c, r)
      if (id >= defs.length >> 3) continue
      for (let q = 0; q < 4; q++) {
        const cw = cellWord(defs, order, p, id, stripOf(meta, c, r), q)
        if (cw.guess && q === 0) guesses.push({ c, r, kind: 'pipe', reason: 'Guess: pipe color. This column was not drawn during capture; showing the variant resident at capture.' })
        const f = decodeWord(cw.word | (meta.wordOr ?? 0))
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            const v = charPixel(vram, base, 4, f.char, f.flipX ? 7 - x : x, f.flipY ? 7 - y : y)
            const i = (r * 16 + (q >> 1) * 8 + y) * W + c * 16 + (q & 1) * 8 + x
            if (v) [idx[i], pri[i]] = [f.pal * 16 + v, f.prio]
          }
      }
    }
  return { idx, pri, guesses }
}

/** VRAM word address of tilemap cell (tx, ty) under BGnSC `sc`; VRAM is 32K words. */
export function tilemapWordAddr(sc: number, tx: number, ty: number): number {
  const wide = sc & 1
  const tall = (sc >> 1) & 1
  const x = tx & (wide ? 63 : 31)
  const y = ty & (tall ? 63 : 31)
  const screen = (x >> 5) + (y >> 5) * (wide ? 2 : 1)
  return (((sc & 0xfc) << 8) + screen * 0x400 + (y & 31) * 32 + (x & 31)) & 0x7fff
}

/** Color index 0-15 of pixel (x, y) in a planar char; baseWord is the BG/OBJ name base. */
// prettier-ignore
export function charPixel(vram: Uint8Array, baseWord: number, bpp: number, ch: number, x: number, y: number) {
  const a = (baseWord * 2 + ch * bpp * 8) & 0xffff
  const bit = 7 - x
  let v = ((vram[a + y * 2] >> bit) & 1) | (((vram[a + y * 2 + 1] >> bit) & 1) << 1)
  if (bpp === 4) {
    const b = (a + 16) & 0xffff
    v |= (((vram[b + y * 2] >> bit) & 1) << 2) | (((vram[b + y * 2 + 1] >> bit) & 1) << 3)
  }
  return v
}

/** CGRAM entry as RGB, 5-bit channels widened the way Mesen's PNGs show them. */
export function bgr555(cgram: Uint8Array, i: number): number[] {
  const w = cgram[i * 2] | (cgram[i * 2 + 1] << 8)
  return [w & 31, (w >> 5) & 31, (w >> 10) & 31].map(c => (c << 3) | (c >> 2))
}

/** All 256 CGRAM colors as RGB triples. */
export function palette(cgram: Uint8Array) {
  const p = new Uint8Array(768)
  for (let i = 0; i < 256; i++) p.set(bgr555(cgram, i), i * 3)
  return p
}

/**
 * Mode 1, front to back, as [layer, priority]: layers 0 BG1, 1 BG2, 2 BG3,
 * 3 OBJ. BGMODE bit 3 lifts BG3's high plane to the very front.
 */
export function layerOrder(bgmode: number): number[][] {
  const top = bgmode & 8 ? [[2, 1]] : []
  const low = bgmode & 8 ? [] : [[2, 1]]
  // prettier-ignore
  return [...top, [3, 3], [0, 1], [1, 1], [3, 2], [0, 0], [1, 0], [3, 1], ...low, [3, 0], [2, 0]]
}

/** OBJ width and height for OBSEL's size mode, small (0) or large (1). */
export function objSize(obsel: number, large: number): number[] {
  // prettier-ignore
  const SZ = [[8, 8, 16, 16], [8, 8, 32, 32], [8, 8, 64, 64], [16, 16, 32, 32], [16, 16, 64, 64], [32, 32, 64, 64], [16, 32, 32, 64], [16, 32, 32, 32]][obsel >> 5]
  return [SZ[large * 2], SZ[large * 2 + 1]]
}

/** The OBJ fields drawObj needs, from an attribute byte. */
export function objAttr(obsel: number, tile: number, attr: number, large: number) {
  const [w, h] = objSize(obsel, large)
  const base0 = (obsel & 7) << 13
  const base = attr & 1 ? base0 + ((((obsel >> 3) & 3) + 1) << 12) : base0
  // prettier-ignore
  return { w, h, tile, base, pal: (attr >> 1) & 7, prio: (attr >> 4) & 3, flipX: attr & 0x40, flipY: attr & 0x80 }
}

export type Put = (x: number, y: number, ci: number, p: number) => void

/** One OBJ with its top-left at (x0, y0). */
// prettier-ignore
export function drawObj(vram: Uint8Array, s: ReturnType<typeof objAttr>, x0: number, y0: number, put: Put) {
  for (let sy = 0; sy < s.h; sy++)
    for (let sx = 0; sx < s.w; sx++) {
      const [col, row] = [s.flipX ? s.w - 1 - sx : sx, s.flipY ? s.h - 1 - sy : sy]
      const c = charPixel(vram, s.base, 4, spriteChar(s.tile, col >> 3, row >> 3), col & 7, row & 7)
      if (c) put(x0 + sx, y0 + sy, 128 + s.pal * 16 + c, s.prio)
    }
}

/** Char of the 8x8 cell (col, row) in a sprite; each nibble wraps within the 16x16 table. */
export function spriteChar(tile: number, col: number, row: number) {
  return ((tile + (row << 4)) & 0xf0) | ((tile + col) & 0x0f)
}

/** One OAM entry of a spawned sprite, relative to the sprite's own position; `i` orders drawing. */
export interface SpritePiece {
  i: number
  dx: number
  dy: number
  tile: number
  attr: number
  large: number
}

/** A sprite-list entry at its list position; null pieces = not drawn, only marked. */
export interface Spawn {
  id: number
  x: number
  y: number
  pieces: SpritePiece[] | null
  obsel: number
  reason: string
  /** Which animation frame is drawn and which were recorded, for the hover. */
  frames?: string
}

/**
 * The map-wide Sprites layer: each list sprite once, its pieces around
 * its list position, never clipped to a screen (Mario is never in a spawn
 * record). A spawn with a `reason` is a guess: drawn if it has pieces,
 * else only marked at its list position.
 */
// prettier-ignore
export function spriteLayer(spawns: Spawn[], vram: Uint8Array, W: number, H: number) {
  const idx = new Uint8Array(W * H)
  const pri = new Uint8Array(W * H)
  const guesses: Guess[] = []
  const put = (x: number, y: number, ci: number, p: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    ;[idx[y * W + x], pri[y * W + x]] = [ci, p]
  }
  for (const s of spawns) {
    if (s.reason) guesses.push({ c: s.x >> 4, r: s.y >> 4, kind: 'sprite', reason: 'Guess: sprite ' + hex(s.id) + '. ' + s.reason + (s.pieces ? '.' : '; marked at its list position, not drawn.') })
    for (const p of [...(s.pieces ?? [])].sort((a, b) => b.i - a.i))
      drawObj(vram, objAttr(s.obsel, p.tile, p.attr, p.large), s.x + p.dx, s.y + REF_DY + p.dy, put)
  }
  return { idx, pri, guesses }
}

/**
 * Fill `idx`/`pri` (W wide) over rect [x0, x1) x [y0, y1) from a BG
 * tilemap: pixel (x, y) shows tilemap pixel (x + ox, y + oy), wrapped.
 */
// prettier-ignore
export function drawBg(vram: Uint8Array, sc: number, nbaWord: number, bpp: number, rect: number[], ox: number, oy: number, idx: Uint8Array, pri: Uint8Array, W: number, hide?: Set<number>, hidden?: Uint8Array) {
  const [tw, th] = [sc & 1 ? 512 : 256, sc & 2 ? 512 : 256]
  for (let y = rect[2]; y < rect[3]; y++)
    for (let x = rect[0]; x < rect[1]; x++) {
      const px = (((x + ox) % tw) + tw) % tw
      const py = (((y + oy) % th) + th) % th
      // A hidden tilemap cell (64-wide cell index) is left out, and marked.
      if (hide?.has((py >> 3) * 64 + (px >> 3))) {
        if (hidden) hidden[y * W + x] = 1
        continue
      }
      const a = tilemapWordAddr(sc, px >> 3, py >> 3) * 2
      const f = decodeWord(vram[a] | (vram[a + 1] << 8))
      const c = charPixel(vram, nbaWord, bpp, f.char, f.flipX ? 7 - (px & 7) : px & 7, f.flipY ? 7 - (py & 7) : py & 7)
      if (c) [idx[y * W + x], pri[y * W + x]] = [f.pal * (1 << bpp) + c, f.prio]
    }
}

/** Base64 to bytes, in the page and in Node alike. */
export function unb64(s: string) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0))
}

/** Everything the map-wide render uses: the map data and the load sample. No window data. */
export interface LevelInput {
  meta: GridMeta
  order: number[]
  pipe: PipeInfo
  /**
   * The Background as loaded: a preset BG2 tilemap, Layer 2 objects in the
   * Map16 grid (laid out by `l2`), none, or refused (a layout the capture
   * does not state).
   */
  background: 'preset' | 'objects' | 'none' | 'refused'
  l2?: GridMeta
  /** BG3 tilemap cells (row * 64 + column) the capture says are the status bar: not map data. */
  hideBg3?: number[]
  grid: string
  defs: string
  vram: string
  regs: Record<string, number>
  spawns: Spawn[]
}

/**
 * The map drawn once from its data with the load sample's graphics:
 * Foreground from grid + defs (+ per-column pipe sets), Background from the
 * Layer 2 source as loaded, Effects at the load camera, Sprites from the
 * spawn records. It takes no window data, by construction.
 */
// prettier-ignore
export function renderLevel(L: LevelInput) {
  const [vram, grid, defs] = [unb64(L.vram), unb64(L.grid), unb64(L.defs)]
  const { cols, rows } = gridDims(L.meta)
  const [W, H] = [cols * 16, rows * 16]
  const R = L.regs
  const fg = foreground(vram, grid, defs, L.meta, L.order, L.pipe, (R.BG12NBA_210B & 15) << 12)
  const bg = { idx: new Uint8Array(W * H), pri: new Uint8Array(W * H) }
  // A preset Background and the Effects tilemap are each drawn whole, origin
  // at map (0, 0), no parallax, as src/rom/model/L2Layer.ts:57-68 placed Layer 2.
  const nba2 = (R.BG12NBA_210B >> 4) << 12
  if (L.background === 'preset') drawBg(vram, R.BG2SC_2108, nba2, 4, [0, W, 0, H], 0, 0, bg.idx, bg.pri, W)
  if (L.background === 'objects' && L.l2) {
    // Layer 2 objects: a Map16 grid of its own, drawn with the same defs and BG2's chars.
    const l2 = foreground(vram, grid, defs, L.l2, L.order, NO_PIPES, nba2)
    const w2 = gridDims(L.l2).cols * 16
    const h2 = l2.idx.length / w2
    for (let y = 0; y < Math.min(H, h2); y++)
      for (let x = 0; x < Math.min(W, w2); x++) [bg.idx[y * W + x], bg.pri[y * W + x]] = [l2.idx[y * w2 + x], l2.pri[y * w2 + x]]
  }
  const fx = { idx: new Uint8Array(W * H), pri: new Uint8Array(W * H) }
  drawBg(vram, R.BG3SC_2109, (R.BG34NBA_210C & 15) << 12, 2, [0, W, 0, H], 0, 0, fx.idx, fx.pri, W, new Set(L.hideBg3 ?? []))
  const spr = spriteLayer(L.spawns, vram, W, H)
  return { W, H, layers: [{ idx: fg.idx, pri: fg.pri }, bg, fx, { idx: spr.idx, pri: spr.pri }], guesses: [...fg.guesses, ...spr.guesses] }
}
