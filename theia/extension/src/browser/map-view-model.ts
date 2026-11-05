/**
 * The map tab's per-tab state as a cache key: which switch palaces are
 * pressed and which char switches are on both change the picture, so both
 * key a cached screen. Pure, so it is unit tested without a DOM.
 */
import type {
  BlockIndicatorDto,
  MapSpriteDto,
  SwitchFlagsDto,
  SwitchStateDto,
} from '../common/project-protocol'
import { BLOCK, indicatorBox, paintIndicator, type Box } from '../common/block-indicator'
import {
  composeScreen,
  doorFlips,
  type SourceKey,
  type ScreenInput,
} from '../../../../src/rom/model/ColorMath'
import { SPRITE_KEYS, type FlameKey, type SpriteKey } from '../../../../src/rom/model/ScreenPlanes'
import { decodeBase64Bytes, decodeRgba } from './map16-pixels'
import { SWITCH_ORDER } from './map16-view-model'

export const PALACES: readonly (keyof SwitchFlagsDto)[] = ['yellow', 'green', 'red', 'blue']

const bits = <K extends string>(keys: readonly K[], on: Record<K, boolean>) =>
  keys.map(k => (on[k] ? '1' : '0')).join('')

/** `<palaces>:<switches>:<screen>`, palaces yellow green red blue, switches blue silver ON/OFF. */
export function screenKey(flags: SwitchFlagsDto, switches: SwitchStateDto, screen: number): string {
  return `${bits(PALACES, flags)}:${bits(SWITCH_ORDER, switches)}:${screen}`
}

/** What a screen is, for cutting sprites: its pixels and which way the map's screens run. */
export interface ScreenGeometry {
  orientation: 'horizontal' | 'vertical'
  width: number
  height: number
}

const decoded = new WeakMap<MapSpriteDto, { rgba: Uint8ClampedArray; prio: Uint8Array | null }>()

/** One screen's sprite pixels and each pixel's OAM priority (#795). */
interface SpriteLayer {
  rgba: Uint8ClampedArray
  prio: Uint8Array
  /** Per pixel, 0 or ((winning sprite's place in the stack + 1) << 1 | its local (x + y) parity), for the screen door. */
  door: Uint32Array
}

/** The draw order, back to front: column order on a horizontal map, row order on a vertical one, stream index breaking ties. */
function stackOrder(
  sprites: readonly MapSpriteDto[],
  g: ScreenGeometry,
  onLayer2: boolean,
): MapSpriteDto[] {
  const vertical = g.orientation === 'vertical'
  return sprites
    .filter(s => !!s.fixedTo === onLayer2)
    .sort((a, b) => (vertical ? a.y - b.y : a.x - b.x) || a.index - b.index)
}

/** A sprite's decoded bitmap, cached per DTO. */
function bitmapOf(s: MapSpriteDto): { rgba: Uint8ClampedArray; prio: Uint8Array | null } {
  let bmp = decoded.get(s)
  if (!bmp) decoded.set(s, (bmp = { rgba: decodeRgba(s.rgba), prio: s.priority ? decodeBase64Bytes(s.priority) : null })) // prettier-ignore
  return bmp
}

/** Whether `s` has an opaque pixel at map pixel (px, py). */
function opaqueAt(s: MapSpriteDto, px: number, py: number): boolean {
  const { x0, y0, x1, y1 } = s.box
  if (px < x0 || px >= x1 || py < y0 || py >= y1) return false
  return bitmapOf(s).rgba[((py - y0) * (x1 - x0) + (px - x0)) * 4 + 3] !== 0
}

/**
 * The sprite that owns the map pixel (x, y), in map pixels: the topmost of the `stackOrder` `spriteLayer` draws
 * with an opaque pixel there. Transparent pixels and Layer 2 flames hit nothing (#981). A sprite its parent drew
 * (`drawnBy`) takes the hit over that parent wherever it has a pixel, whichever sorts on top, because the parent's
 * bitmap holds the same pixels (D52).
 */
export function spriteAt(
  sprites: readonly MapSpriteDto[],
  g: ScreenGeometry,
  x: number,
  y: number,
): MapSpriteDto | undefined {
  const [px, py] = [Math.floor(x), Math.floor(y)]
  const order = stackOrder(sprites, g, false)
  for (let n = order.length - 1; n >= 0; n--) {
    const s = order[n]!
    if (!opaqueAt(s, px, py)) continue
    // A sprite its parent drew is inside the parent's bitmap, which wins here when it sorts on top: the child takes the hit (D52).
    return order.find(c => c.drawnBy === s.index && opaqueAt(c, px, py)) ?? s
  }
  return undefined
}

/** Where a hover anchor was placed: zoom and the strip's origin on screen, so a layout shift (not only a zoom) re-places it. */
export const hoverPlacementKey = (zoom: number, rect: { left: number; top: number }): string =>
  `${zoom}:${Math.round(rect.left)}:${Math.round(rect.top)}`

/** What the hover shows for a sprite (#981): its plain name only, or nothing when the name table has none. */
export function spriteName(s: Pick<MapSpriteDto, 'name'>): string | undefined {
  return s.name || undefined
}

/**
 * One screen's sprites, or null when no sprite reaches it. A sprite is one
 * bitmap in map pixels, so one that crosses a screen edge is cut into every screen
 * it overlaps. What spills past the map is clipped here; off-map-extent.ts draws it in the
 * canvas pad around the map (#1004). Sprites stack in column order on a horizontal map and
 * row order on a vertical one (the stream's order breaks ties), later ones on top; a pixel
 * keeps the priority of the sprite that wins it.
 */
function spriteLayer(
  sprites: readonly MapSpriteDto[],
  screen: number,
  g: ScreenGeometry,
  onLayer2 = false,
): SpriteLayer | null {
  const vertical = g.orientation === 'vertical'
  const [left, top] = vertical ? [0, screen * g.height] : [screen * g.width, 0]
  const order = stackOrder(sprites, g, onLayer2)
  let out: SpriteLayer | null = null
  for (const [n, s] of order.entries()) {
    // A sprite its parent drew is in the parent's bitmap already (#1049).
    if (s.drawnBy !== undefined) continue
    const { x0, y0, x1, y1 } = s.box
    const [cx0, cx1] = [Math.max(x0, left), Math.min(x1, left + g.width)]
    const [cy0, cy1] = [Math.max(y0, top), Math.min(y1, top + g.height)]
    if (cx0 >= cx1 || cy0 >= cy1) continue
    const bmp = bitmapOf(s)
    out ??= { rgba: new Uint8ClampedArray(g.width * g.height * 4), prio: new Uint8Array(g.width * g.height), door: new Uint32Array(g.width * g.height) } // prettier-ignore
    for (let y = cy0; y < cy1; y++) {
      for (let x = cx0; x < cx1; x++) {
        const from = (y - y0) * (x1 - x0) + (x - x0)
        if (bmp.rgba[from * 4 + 3] === 0) continue
        const to = (y - top) * g.width + (x - left)
        out.rgba.set(bmp.rgba.subarray(from * 4, from * 4 + 4), to * 4)
        // No priority: a placeholder, at the pre-#795 slot.
        out.prio[to] = bmp.prio ? bmp.prio[from]! : 2
        out.door[to] = ((n + 1) << 1) | ((x - x0 + (y - y0)) & 1)
      }
    }
  }
  return out
}

/** One screen's sprite canvas (every priority together), or null when no sprite reaches it. */
export function compositeSpriteScreen(
  sprites: readonly MapSpriteDto[],
  screen: number,
  g: ScreenGeometry,
): Uint8ClampedArray | null {
  return spriteLayer(sprites, screen, g)?.rgba ?? null
}

/** One screen's sprites split by OAM priority, the four sources `screenPlanes` places; null where none (or none read). */
export function spritePlanes(
  sp: (ScreenGeometry & { sprites: readonly MapSpriteDto[] }) | undefined,
  screen: number,
): Record<SpriteKey, Uint8ClampedArray | null> {
  const planes: Record<SpriteKey, Uint8ClampedArray | null> = { sprites0: null, sprites1: null, sprites2: null, sprites3: null } // prettier-ignore
  const layer = sp && spriteLayer(sp.sprites, screen, sp)
  if (!layer) return planes
  layer.prio.forEach((p, i) => {
    if (layer.rgba[i * 4 + 3] === 0) return
    const plane = (planes[SPRITE_KEYS[p]!] ??= new Uint8ClampedArray(layer.rgba.length))
    plane.set(layer.rgba.subarray(i * 4, i * 4 + 4), i * 4)
  })
  return planes
}

/**
 * One screen's Layer 2 sprites (the castle flames, #894) in two planes: a flame pixel goes to the plane of the
 * Layer 2 pixel it covers (`l2High` opaque there: high), so Layer 1 stays over it whichever way Layer 2 is
 * routed. `l2High` is the screen's Layer 2 priority plane, kept even while Layer 2 is hidden. Null planes where none.
 */
export function flamePlanes(
  sp: (ScreenGeometry & { sprites: readonly MapSpriteDto[] }) | undefined,
  screen: number,
  l2High: Uint8ClampedArray | null | undefined,
): Record<FlameKey, Uint8ClampedArray | null> {
  const planes: Record<FlameKey, Uint8ClampedArray | null> = {
    spritesL2Low: null,
    spritesL2High: null,
  }
  const layer = sp && spriteLayer(sp.sprites, screen, sp, true)
  if (!layer) return planes
  for (let i = 0; i < layer.rgba.length; i += 4) {
    if (layer.rgba[i + 3] === 0) continue
    const key = l2High && l2High[i + 3]! > 0 ? 'spritesL2High' : 'spritesL2Low'
    const plane = (planes[key] ??= new Uint8ClampedArray(layer.rgba.length))
    plane.set(layer.rgba.subarray(i, i + 4), i)
  }
  return planes
}

/**
 * A screen's plane lists with the flame planes placed, on the list that shows sprites (OBJ designated); a list
 * without sprites is unchanged. Lists run back to front. A flame plane goes right above its Layer 2 plane when that
 * plane is in the same list. Otherwise (the common SMW routing, shared by 464 of the 481 maps without flames and by the 7 castle maps: OBJ on
 * the main screen and Layer 2 on the sub screen, main `l3Low sprites0 l3High sprites1 l1Low sprites2 l1High sprites3`,
 * sub `l2Low l2High`; vanilla ROM, one count) it goes right
 * under the list's first Layer 1 plane: over the sub screen's Layer 2 the flame belongs to, under Layer 1 (owner ruling).
 */
export function withFlameKeys<L extends { main: readonly SourceKey[]; sub: readonly SourceKey[] }>(
  lists: L,
): L {
  const put = (list: readonly SourceKey[]): SourceKey[] => {
    if (!list.some(k => k.startsWith('sprites'))) return [...list]
    const own = (k: SourceKey): SourceKey[] => k === 'l2Low' ? [k, 'spritesL2Low'] : k === 'l2High' ? [k, 'spritesL2High'] : [k] // prettier-ignore
    const out = list.flatMap(own)
    const missing = (['spritesL2Low', 'spritesL2High'] as const).filter(k => !out.includes(k))
    const l1 = out.findIndex(k => k === 'l1Low' || k === 'l1High')
    out.splice(l1 < 0 ? out.length : l1, 0, ...missing)
    return out
  }
  return { ...lists, main: put(lists.main), sub: put(lists.sub) }
}

/**
 * One screen's sprite door map for `composeScreen` (D52): which sprite owns each pixel and its
 * parity on the sprite's own pixel grid, so a covered sprite pixel draws through the tile at the
 * hidden-tile screen door's strength. Null where no sprite reaches the screen.
 */
export function spriteDoors(
  sp: (ScreenGeometry & { sprites: readonly MapSpriteDto[] }) | undefined,
  screen: number,
): Uint32Array | null {
  return (sp && spriteLayer(sp.sprites, screen, sp)?.door) ?? null
}

/**
 * The sprite under a native pixel of one screen's door map (its door id), or 0 for none. The id is n+1
 * in the map-wide x-sorted order `spriteLayer` assigns, so the topmost sprite at the pixel wins (#879).
 */
export function doorIdAt(doors: Uint32Array | null, width: number, x: number, y: number): number {
  if (!doors || x < 0 || y < 0 || x >= width) return 0
  return (doors[Math.floor(y) * width + Math.floor(x)] ?? 0) >> 1
}

/** S3: a sprite lifts only when some painted screen's tiles cover it; otherwise there is nothing to repaint. */
export function liftIfCovered(
  id: number,
  covered: Iterable<ReadonlySet<number>>,
): number | undefined {
  if (!id) return undefined
  for (const c of covered) if (c.has(id)) return id
  return undefined
}

/** The canvas surface the sprite painter needs: a subset of HTMLCanvasElement. */
interface SpriteCanvas {
  width: number
  height: number
  dataset: DOMStringMap
  getContext(id: '2d'): {
    clearRect(x: number, y: number, w: number, h: number): void
    putImageData?(data: ImageData, x: number, y: number): void
  } | null
}

/** Blanks a sprite canvas that still shows an earlier fetch's sprites. */
export function clearSpriteCanvas(canvas: SpriteCanvas): void {
  if (canvas.dataset.drawn === undefined) return
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  delete canvas.dataset.drawn
}

/**
 * Brings one screen's sprite canvas to `want`: the sprites cut to the screen, or, with
 * no sprites (a failed or older map's fetch), blank, never the stale picture.
 */
export function paintSpriteCanvas(
  canvas: SpriteCanvas,
  sp: (ScreenGeometry & { sprites: readonly MapSpriteDto[] }) | undefined,
  screen: number,
  want: string,
): void {
  if (!sp) return clearSpriteCanvas(canvas)
  if (canvas.dataset.drawn === want) return
  if (canvas.width !== sp.width) canvas.width = sp.width
  if (canvas.height !== sp.height) canvas.height = sp.height
  const ctx = canvas.getContext('2d')
  ctx?.clearRect(0, 0, canvas.width, canvas.height)
  const rgba = compositeSpriteScreen(sp.sprites, screen, sp)
  if (rgba) ctx?.putImageData?.(new ImageData(rgba, sp.width, sp.height), 0, 0)
  canvas.dataset.drawn = want
}

/** Decodes a reply's arts (16 x 16 RGBA) once. */
export function decodeArts(arts: Record<string, string>): Map<string, Uint8ClampedArray> {
  return new Map(Object.entries(arts).map(([k, v]) => [k, decodeRgba(v)]))
}

/** A block-content indicator with its plane, as `mapBlockContents` replies. */
export type Indicator = BlockIndicatorDto

const blockRect = (i: Indicator) => ({ x0: i.x, y0: i.y, x1: i.x + BLOCK, y1: i.y + BLOCK })

/** One indicator's identity, for hover and for the painted record. */
export const indicatorId = (i: Indicator): string => `${i.plane}:${i.x}:${i.y}`

/**
 * The indicator the pointer is over: the block under (x, y), among the planes
 * `shown` reports visible, topmost by `rank` (a plane's place in the stacking
 * order, higher is nearer). Null over no block.
 */
export function hoverTarget(
  list: readonly Indicator[],
  x: number,
  y: number,
  shown: (plane: Indicator['plane']) => boolean,
  rank: (plane: Indicator['plane']) => number,
): Indicator | null {
  let best: Indicator | null = null
  for (const i of list) {
    const r = blockRect(i)
    if (x < r.x0 || x >= r.x1 || y < r.y0 || y >= r.y1 || !shown(i.plane)) continue
    if (!best || rank(i.plane) > rank(best.plane)) best = i
  }
  return best
}

export interface PaintedIndicator {
  id: string
  hover: boolean
  /** The item box in the screen canvas's pixels, x1 and y1 exclusive. */
  box: Box
}

/** A native-resolution RGBA image scaled to `dw` x `dh` by nearest sampling. */
export function scaleNearest(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  // prettier-ignore
  if (dw === w && dh === h) return src.slice()
  const out = new Uint8ClampedArray(dw * dh * 4)
  // 32-bit pixels, and each source row is sampled once: its repeats are whole-row copies.
  const [s32, o32] = [
    new Uint32Array(src.buffer, src.byteOffset, w * h),
    new Uint32Array(out.buffer),
  ]
  const cols = Uint32Array.from({ length: dw }, (_, x) => Math.min(w - 1, Math.floor((x * w) / dw)))
  let last = -1
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / dh))
    const at = y * dw
    if (sy === last) o32.copyWithin(at, at - dw, at)
    else for (let x = 0; x < dw; x++) o32[at + x] = s32[sy * w + cols[x]!]!
    last = sy
  }
  return out
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** One region of the display to put back on its canvas after a hover change. */
export interface Region {
  x: number
  y: number
  width: number
  height: number
  rgba: Uint8ClampedArray
}

export interface DisplaySource {
  /** Native size of a screen. */
  width: number
  height: number
  zoom: number
  screen: number
  geometry: ScreenGeometry
  /** The native planes that are shown (a hidden layer's is omitted; a shown, empty one is null). */
  planes: Partial<Record<SourceKey, Uint8ClampedArray | null>>
  lists: ScreenInput['lists']
  math: ScreenInput['math']
  /** The native composite of those same planes: every pixel outside an indicator is its scaled copy. */
  base: Uint8ClampedArray
  /** The native sprite door map of `spriteDoors`: scaled with the cell, its parity stays on native sprite pixels. */
  doors?: Uint32Array | null
  /** The hovered sprite's door id (#879), passed on to every cell's compose. */
  lift?: number
  indicators: readonly Indicator[]
  arts: ReadonlyMap<string, Uint8ClampedArray>
}

const NO_ART = new Uint8ClampedArray(BLOCK * BLOCK * 4)

/**
 * The screen at screen resolution with its indicators IN their planes (#566, owner ruling
 * 2026-10-06), shown over the native composite, which stays as it is. Per-pixel operations commute with
 * nearest scaling, so the picture is the native composite scaled up (cheap), with each indicator's block
 * cell recomposed at the zoom: its planes' pixels scaled, its plane's indicators painted into the
 * plane's copy, then stacked and put through color math. A nearer plane or a sprite therefore covers an
 * indicator exactly as it covers its block. A hover change recomposes only the cells it touches.
 */
export class IndicatorDisplay {
  readonly width: number
  readonly height: number
  /** The picture, screen resolution RGBA. */
  readonly image: Uint8ClampedArray
  private hoverId: string | undefined
  private readonly mine: readonly Indicator[]
  private readonly left: number
  private readonly top: number
  /** The swap decisions of the native screen, which a cell's own pixels would miscount. */
  private readonly flips: Map<number, boolean> | undefined

  constructor(
    private readonly src: DisplaySource,
    hoverId?: string,
  ) {
    const g = src.geometry
    ;[this.left, this.top] =
      g.orientation === 'vertical' ? [0, src.screen * g.height] : [src.screen * g.width, 0]
    this.width = Math.round(src.width * src.zoom)
    this.height = Math.round(src.height * src.zoom)
    this.mine = src.indicators.filter(
      q =>
        this.composed(q.plane) &&
        q.x + BLOCK > this.left &&
        q.x < this.left + g.width &&
        q.y + BLOCK > this.top &&
        q.y < this.top + g.height,
    )
    this.hoverId = hoverId
    const { doors, planes, lists } = src
    this.flips = doors ? doorFlips({ width: src.width, height: src.height, planes, lists, math: null, doors }) : undefined // prettier-ignore
    this.image = scaleNearest(src.base, src.width, src.height, this.width, this.height)
    for (const r of this.mine.map(q => this.rect(q))) this.put(r, this.compose(r))
  }

  /** A plane the lists compose and the view shows: only these have indicators on screen. */
  private composed(p: Indicator['plane']): boolean {
    const { planes, lists } = this.src
    return planes[p] !== undefined && (lists.main.includes(p) || lists.sub.includes(p))
  }

  /** Whether any indicator is on this screen to be shown. */
  get touches(): boolean {
    return this.mine.length > 0
  }

  /** The block cell of an indicator in screen pixels, clipped to the screen. */
  private rect(q: Indicator): Rect {
    const [x, y, z] = [q.x - this.left, q.y - this.top, this.src.zoom]
    const r = (v: number) => Math.round(v * z)
    return {
      x0: Math.max(0, r(x)),
      y0: Math.max(0, r(y)),
      x1: Math.min(this.width, r(x + BLOCK)),
      y1: Math.min(this.height, r(y + BLOCK)),
    }
  }

  /** What was painted: each indicator's item box in screen pixels. */
  records(): PaintedIndicator[] {
    return this.mine.map(q => {
      const hover = indicatorId(q) === this.hoverId
      const box = indicatorBox(q.x - this.left, q.y - this.top, this.src.zoom, hover)
      return { id: indicatorId(q), hover, box }
    })
  }

  /** The cell `r` recomposed at the zoom, with the current hover. */
  private compose(r: Rect): Uint8ClampedArray {
    const s = this.src
    const [rw, rh] = [r.x1 - r.x0, r.y1 - r.y0]
    const planes: Partial<Record<SourceKey, Uint8ClampedArray | null>> = {}
    for (const [k, data] of Object.entries(s.planes) as [SourceKey, Uint8ClampedArray | null][]) {
      const own = this.mine.filter(q => q.plane === k && this.meets(q, r))
      if (!data && own.length === 0) {
        planes[k] = null
        continue
      }
      const cell = data
        ? scaleRegion(data, s.width, s.height, this.width, this.height, r)
        : new Uint8ClampedArray(rw * rh * 4)
      for (const q of own) {
        const art = s.arts.get(q.art) ?? NO_ART
        const [x, y] = [q.x - this.left, q.y - this.top]
        paintIndicator(cell, rw, rh, x, y, art, s.zoom, indicatorId(q) === this.hoverId, [
          r.x0,
          r.y0,
        ])
      }
      planes[k] = cell
    }
    // The door map scales like a plane (nearest), so a cell pixel keeps its native sprite pixel's parity.
    const doors = s.doors && new Uint32Array(scaleRegion(new Uint8ClampedArray(s.doors.buffer, s.doors.byteOffset, s.doors.byteLength), s.width, s.height, this.width, this.height, r).buffer) // prettier-ignore
    return composeScreen({ width: rw, height: rh, planes, lists: s.lists, math: s.math, doors, flips: this.flips, lift: s.lift }) // prettier-ignore
  }

  /** The item box lies inside its block cell, so the cells meeting is enough. */
  private meets(q: Indicator, r: Rect): boolean {
    const b = this.rect(q)
    return b.x0 < r.x1 && b.x1 > r.x0 && b.y0 < r.y1 && b.y1 > r.y0
  }

  private put(r: Rect, rgba: Uint8ClampedArray): void {
    const rw = r.x1 - r.x0
    for (let y = r.y0; y < r.y1; y++) {
      const row = rgba.subarray((y - r.y0) * rw * 4, (y - r.y0 + 1) * rw * 4)
      this.image.set(row, (y * this.width + r.x0) * 4)
    }
  }

  /** Moves the hover; returns the cells that changed (the old one's and the new one's), recomposed. */
  setHover(next: string | undefined): Region[] {
    const prev = this.hoverId
    if (prev === next) return []
    this.hoverId = next
    const out: Region[] = []
    const seen = new Set<string>()
    for (const q of this.mine.filter(i => [prev, next].includes(indicatorId(i)))) {
      const r = this.rect(q)
      if (seen.has(`${r.x0},${r.y0}`)) continue
      seen.add(`${r.x0},${r.y0}`)
      const rgba = this.compose(r)
      this.put(r, rgba)
      out.push({ x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, rgba })
    }
    return out
  }
}

/** The region `r` (screen pixels) of a native image scaled to `dw` x `dh`, by nearest sampling. */
export function scaleRegion(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  dw: number,
  dh: number,
  r: Rect,
): Uint8ClampedArray {
  const [rw, rh] = [r.x1 - r.x0, r.y1 - r.y0]
  const out = new Uint8ClampedArray(rw * rh * 4)
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h)
  const o32 = new Uint32Array(out.buffer)
  for (let y = 0; y < rh; y++) {
    const sy = Math.min(h - 1, Math.floor(((r.y0 + y) * h) / dh))
    for (let x = 0; x < rw; x++) {
      o32[y * rw + x] = s32[sy * w + Math.min(w - 1, Math.floor(((r.x0 + x) * w) / dw))]!
    }
  }
  return out
}
