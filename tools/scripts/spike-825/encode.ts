/**
 * #825 SPIKE, not shipped, never imported by shipped code. An indexed encoding of what
 * `screenResult` draws as RGBA: per plane a tilemap of 8x8 cells (tile, palette row, flips),
 * the tiles as palette indices (deduplicated per map) and the colors. `decodePlane` is the
 * reference decoder and the correctness oracle (byte-identical RGBA vs today's planes).
 * Placement loops mirror map-screen.ts drawPlanes / drawL3Planes (read-only wrap, no edits there).
 */
import { getCharPixels } from '../../../src/rom/GfxLoader'
import { L3_HUD_ROW_CUTOFF, L3_TILEMAP_COLS, L3_TILEMAP_ROWS } from '../../../src/rom/L3Loader'
import { ghostOf } from '../../../src/rom/render/HiddenTiles'
import { renderMap16Tile } from '../../../src/rom/TileRenderer'
import { cellOf, screenTiles, type MapInputs } from '../../../theia/extension/src/node/map-screen'
import type { SubTile } from '../../../src/rom/Map16'

/** One plane: cells sit at pixel (ox + 8c, oy + 8r); word 0 = empty, else (tile+1) | pal<<11 | flipX<<14 | flipY<<15. */
export interface IPlane {
  ox: number
  oy: number
  cols: number
  rows: number
  cells: Uint16Array
  /** 0: the map's CGRAM (row*16+index); 1: layer 3's 2bpp palettes (row*4+index). */
  pal: 0 | 1
}
export interface TileSet {
  keys: Map<number, number>
  pixels: Uint8Array[]
}
export const newTileSet = (): TileSet => ({ keys: new Map(), pixels: [] })
const word = (t: number, pal: number, fx: number, fy: number) =>
  (t + 1) | (pal << 11) | (fx << 14) | (fy << 15)

function tileOf(ts: TileSet, key: number, px: Uint8Array): number {
  let t = ts.keys.get(key)
  if (t === undefined) {
    // The cell word holds tile+1 in 11 bits: a map with more distinct chars than this needs a wider word.
    if (ts.pixels.length >= 0x7ff) throw new Error('tile set exceeds the 11-bit tile index')
    ts.keys.set(key, (t = ts.pixels.length))
    ts.pixels.push(px)
  }
  return t
}

class Builder {
  planes: IPlane[]
  escapes = 0
  constructor(
    private w: number,
    private h: number,
    private ts: TileSet,
    ox: number,
    oy: number,
    pal: 0 | 1,
  ) {
    const cols = Math.ceil((w - ox) / 8)
    const rows = Math.ceil((h - oy) / 8)
    this.planes = [0, 1].map(() => ({
      ox,
      oy,
      cols,
      rows,
      cells: new Uint16Array(cols * rows),
      pal,
    }))
  }
  /** Place one 8x8 at screen pixel (x, y); out-of-screen quads are skipped as the clip does. */
  put(
    p: number,
    x: number,
    y: number,
    key: number,
    px: Uint8Array,
    pal: number,
    fx: number,
    fy: number,
  ) {
    const pl = this.planes[p]!
    if (y + 8 <= 0 || y >= this.h || x + 8 <= 0 || x >= this.w) return
    const [c, r] = [(x - pl.ox) / 8, (y - pl.oy) / 8]
    pl.cells[r * pl.cols + c] = word(tileOf(this.ts, key, px), pal, fx, fy)
  }
  done(): (IPlane | null)[] {
    return this.planes.map(pl => (pl.cells.some(v => v) ? pl : null))
  }
}

/** Grid origin of a plane shifted by `v` px: the cell lattice's offset in (-8, 0]. */
const norm8 = (v: number) => (((v % 8) + 8) % 8 === 0 ? 0 : (((v % 8) + 8) % 8) - 8)

/** L1 or L2 of one screen as [low, high] indexed planes. */
function gridPlanes(
  m: MapInputs,
  ts: TileSet,
  screen: number,
  rows: number,
  dy: number,
  period: number,
  cellAt: (x: number, y: number) => { owner: SubTile[]; escape: boolean } | undefined,
) {
  const { w, h } = screenTiles(m.isVertical)
  const [x0, top] = m.isVertical ? [0, screen * h * 16] : [screen * w, 0]
  const b = new Builder(w * 16, h * 16, ts, 0, norm8(dy), 0)
  for (let y = 0; y < rows; y++) {
    const shifted = y * 16 + dy
    const base = Number.isFinite(period) ? ((shifted % period) + period) % period : shifted
    const copies = Number.isFinite(period) ? Math.ceil((top + h * 16 - base) / period) : 1
    for (let k = Math.ceil((top - 15 - base) / period) || 0; k < copies; k++) {
      const at = base + k * (Number.isFinite(period) ? period : 0)
      if (at + 16 <= top || at >= top + h * 16) continue
      for (let x = 0; x < w; x++) {
        const cell = cellAt(x0 + x, y)
        if (!cell) continue
        b.escapes += cell.escape ? 1 : 0
        cell.owner.forEach((s, i) => {
          const px = getCharPixels(m.vram, s.charNum)
          if (!px) throw new Error(`char ${s.charNum} missing from VRAM`)
          const [qx, qy] = [(i & 1) * 8, (i >> 1) * 8]
          b.put(s.priority ? 1 : 0, x * 16 + qx, at + qy - top, s.charNum, px, s.palette, +s.flipX, +s.flipY) // prettier-ignore
        })
      }
    }
  }
  return { planes: b.done(), escapes: b.escapes }
}

export interface IScreen {
  planes: Record<string, IPlane | null>
  /** Cells whose RGBA is a hidden-switch ghost: no index form, not encoded. */
  escapes: number
}

/** Every plane of one screen, keyed as MAP_PLANE_KEYS. Switches off (the fixtures' state). */
export function encodeScreen(m: MapInputs, ts: TileSet, screen: number): IScreen {
  const out: IScreen = { planes: {}, escapes: 0 }
  const l1 = gridPlanes(m, ts, screen, m.grid.length, 0, Infinity, (x, y) => {
    const id = m.grid[y]?.[x]
    if (id === undefined) return undefined
    const { def, art } = cellOf(m, id, screen)
    if (!def) return undefined
    const rgba = renderMap16Tile(def, m.vram, { colors: m.colors })
    const ghost = art && ghostOf(rgba, art.off, art.alts, c => c.rgba)
    return { owner: [def.tl, def.tr, def.bl, def.br], escape: !!ghost }
  })
  ;[out.planes.l1Low, out.planes.l1High] = l1.planes
  out.escapes += l1.escapes
  const l2 = m.l2?.ok ? m.l2.l2 : null
  if (l2) {
    const period = l2.kind === 'image' || !m.isVertical ? 512 : Infinity
    const r = gridPlanes(m, ts, screen, l2.grid.length, l2.dy, period, (x, y) => {
      const id = l2.grid[y]?.[x]
      const def = id == null ? undefined : l2.tiles[id]
      return def && { owner: [def.tl, def.tr, def.bl, def.br], escape: false }
    })
    ;[out.planes.l2Low, out.planes.l2High] = r.planes
  }
  const l3 = m.l3?.l3
  if (l3) [out.planes.l3Low, out.planes.l3High] = l3Planes(l3, ts, screen)
  return out
}

function l3Planes(
  l3: NonNullable<NonNullable<MapInputs['l3']>['l3']>,
  ts: TileSet,
  screen: number,
) {
  const { w, h } = screenTiles(false)
  const [width, height, xOff] = [w * 16, h * 16, l3.xPx ?? 0]
  const b = new Builder(width, height, ts, -(xOff & 7), norm8(l3.camYPx - l3.yPx), 1)
  const cols = l3.tide ? 32 : L3_TILEMAP_COLS
  const cell = (r: number, c: number) => l3.tilemap[r * L3_TILEMAP_COLS + c] ?? 0
  const row = (r: number) => Array.from({ length: L3_TILEMAP_COLS }, (_, c) => cell(r, c))
  let first = L3_HUD_ROW_CUTOFF
  while (first < L3_TILEMAP_ROWS - 1 && row(first).every(v => v === 0)) first++
  const same = (a: number[], c: number[]) => a.every((v, i) => (v === 0) === (c[i] === 0) && (v & 0x3ff) === (c[i]! & 0x3ff)) // prettier-ignore
  let end = L3_TILEMAP_ROWS
  for (let r = first + 1; l3.tide && r < L3_TILEMAP_ROWS; r++) if (same(row(r), row(first))) { end = r; break } // prettier-ignore
  for (let r = L3_HUD_ROW_CUTOFF; r < end; r++) {
    const y = r * 8 - l3.yPx + l3.camYPx
    if (y < 0 || y >= height) continue
    for (let sx = -(xOff & 7); sx < width; sx += 8) {
      const wd = cell(
        r,
        ((((screen * width + sx + xOff) % (cols * 8)) + cols * 8) % (cols * 8)) >> 3,
      )
      const px = l3.chars[(wd & 0x3ff) >> 7]?.[wd & 0x7f]
      if (!wd || !px) continue
      b.put(wd & 0x2000 ? 1 : 0, sx, y, 0x10000 + (wd & 0x3ff), px, (wd >> 10) & 7, (wd >> 14) & 1, (wd >> 15) & 1) // prettier-ignore
    }
  }
  return b.done()
}

/** Reference decode of one indexed plane to RGBA (palette tables are RGBA, 4 bytes an entry): the oracle's right-hand side. */
export function decodePlane(
  pl: IPlane,
  tiles: Uint8Array[],
  pals: [Uint8Array, Uint8Array],
  w: number,
  h: number,
  plant: '' | 'row' | 'flipX' = '',
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4)
  const [stride, pal] = pl.pal ? [4, pals[1]] : [16, pals[0]]
  for (let r = 0; r < pl.rows; r++)
    for (let c = 0; c < pl.cols; c++) {
      const wd = pl.cells[r * pl.cols + c]!
      if (!wd) continue
      const px = tiles[(wd & 0x7ff) - 1]!
      const row = ((wd >> 11) & 7) + (plant === 'row' ? 1 : 0) // planted defect: wrong palette row
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const [dx, dy] = [pl.ox + c * 8 + x, pl.oy + r * 8 + y]
          if (dx < 0 || dx >= w || dy < 0 || dy >= h) continue
          const flipX = (wd & 0x4000 ? 7 - x : x) ^ (plant === 'flipX' ? 7 : 0) // planted defect: dropped/flipped X
          const v = px[((wd & 0x8000 ? 7 - y : y) << 3) | flipX]!
          const at = (row * stride + v) * 4
          if (v) out.set(pal.subarray(at, at + 4), (dy * w + dx) * 4)
        }
    }
  return out
}
