/**
 * The map tab's block content indicators (#566, PR B): which item blocks a map
 * holds, and the 16 x 16 art of what each gives. Resolution is the core's
 * (`resolveBlockContents`, docs/rom/block-contents.md); this file only places
 * and draws. Item art comes from the sprite table engine's layouts
 * (`buildSpriteLayout`, SpriteTileLoader) drawn by `drawSprites` over the
 * level's own chars and palette; the coin is the coin sprite's four chars.
 * The theia map view never used the old `renderOverlay` of
 * StarOneUpVineBlockBehavior and KeyCoinBalloonKoopaBlockBehavior (they belong
 * to the reference webview model), so nothing there is replaced.
 */
import { RomFile } from '../../../../src/rom/RomFile'
import {
  FIRST_ITEM_BLOCK,
  LAST_ITEM_BLOCK,
  isUnavailable,
  readBlockContentTables,
  resolveBlockContents,
  type BlockContent,
  type BlockContents,
} from '../../../../src/rom/BlockContents'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import {
  buildSpriteLayout,
  buildYoshiEggLayout,
  readSpriteTileTables,
  YOSHI_EGG_ID,
  type SpriteSubtile,
} from '../../../../src/rom/SpriteTileLoader'
import { bakePlus, fitArt, splitDiagonal } from '../common/block-indicator'
import type { BlockIndicatorDto, MapBlockContentsResult } from '../common/project-protocol'
import { drawSprites } from './map-sprites'
import { screenTiles, type L1ModelCache, type MapInputs } from './map-screen'

const NO_FLAGS = { yellow: false, green: false, red: false, blue: false }
const TILE = 16
/** $04 at status 9 is the stunned shell: the layout of id $DA (SpriteTileLoader `resolveShellAlias`). */
const SPRITE_KOOPA = 0x04
const STATUS_STUNNED = 0x09
const SHELL_LAYOUT_ID = 0xda
const SPRITE_PSWITCH = 0x3e
/** The coin sprite's chars $E8/$E9/$F8/$F9 on page 0, OBJ row 10 (bank_02.asm:3432, as spike #605 read it). */
const COIN: SpriteSubtile[] = [
  [0xe8, 0, 0],
  [0xe9, 8, 0],
  [0xf8, 0, 8],
  [0xf9, 8, 8],
].map(([n, dx, dy]) => ({ charNum: 0x400 + n!, palette: 10, flipX: false, flipY: false, dx: dx!, dy: dy! })) // prettier-ignore

export type Spec =
  | { kind: 'item'; content: BlockContent }
  | { kind: 'split'; small: BlockContent; big: BlockContent }

/**
 * THE one place that chooses what a block draws. Progressive blocks (#607)
 * split mushroom and item; a block with one possible content draws it.
 * Blocks whose content depends on other game state ($11A column 0 of 3, $122,
 * $12D: star-or-coin, coin-or-1-up) draw nothing.
 * TODO(#623): their presentation waits on spike #623 (PR #631); the pick
 * becomes a one-line change here.
 */
export function pickIndicator(c: BlockContents): Spec | null {
  const alts = c.alternatives
  if (c.progressive && alts.length === 2) {
    return { kind: 'split', small: alts[0]!.content, big: alts[1]!.content }
  }
  if (alts.length === 1) return { kind: 'item', content: alts[0]!.content }
  return null
}

const keyOf = (c: BlockContent, col: number): string =>
  c.kind === 'sprite'
    ? `s${c.sprite.toString(16)}:${c.status}:${c.attribute ?? ''}:${c.sprite === YOSHI_EGG_ID ? col & 3 : ''}`
    : c.kind
export const specKey = (s: Spec, col: number): string =>
  s.kind === 'item' ? keyOf(s.content, col) : `${keyOf(s.small, col)}/${keyOf(s.big, col)}`

type Drawn = { art: Uint8ClampedArray } | { why: string }

const b64 = (b: Uint8ClampedArray) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64') // prettier-ignore
const unb64 = (s: string) => new Uint8ClampedArray(Buffer.from(s, 'base64'))

export function blockIndicators(
  model: MapInputs,
  rom: RomFile,
): Extract<MapBlockContentsResult, { status: 'ok' | 'unavailable' }> {
  const t = readBlockContentTables(rom)
  if (isUnavailable(t)) return { status: 'unavailable', reason: t.unavailable }
  const tables = readSpriteTileTables(rom)
  if (!tables) return { status: 'unavailable', reason: 'The sprite tile tables could not be read' }
  const level = { vram: model.vram, colors: model.colors }

  const draw = (parts: SpriteSubtile[]): Drawn => {
    const s = { screen: 0, x: 0, y: 0, spriteId: 0, extraBit: false, raw: [0, 0, 0], index: 0 } as LevelSprite // prettier-ignore
    const identity = { spriteId: 0, mainHandler: 0, initHandler: 0, status: 'vanilla' as const }
    const [d] = drawSprites([s], level, () => ({ ok: true, parts, identity }))
    if (d!.status !== 'drawn') return { why: d!.reason ?? 'not drawn' }
    return { art: fitArt(unb64(d!.rgba), d!.box.x1 - d!.box.x0, d!.box.y1 - d!.box.y0) }
  }
  const itemArt = (c: BlockContent, col: number): Drawn => {
    if (c.kind === 'coin') return draw(COIN)
    if (c.kind === 'multiCoin') {
      const coin = draw(COIN)
      return 'art' in coin ? { art: bakePlus(coin.art) } : coin
    }
    const id = c.sprite === SPRITE_KOOPA && c.status === STATUS_STUNNED ? SHELL_LAYOUT_ID : c.sprite
    // The egg's colour follows its own X column (InitYoshiEgg), not the table's.
    const layout = id === YOSHI_EGG_ID ? buildYoshiEggLayout(tables, col * TILE) : buildSpriteLayout(tables, id) // prettier-ignore
    if (!layout) return { why: `no layout for sprite $${c.sprite.toString(16)}` }
    let parts = layout.tiles
    if (c.sprite === SPRITE_PSWITCH && c.attribute !== undefined) {
      // Spawned with DATA_028A42's attribute: colour row and char page.
      const a = c.attribute
      parts = parts.map(p => ({ ...p, palette: 8 + ((a >> 1) & 7), charNum: (p.charNum & ~0x100) | ((a & 1) << 8) })) // prettier-ignore
    }
    return draw(parts)
  }

  const cache = new Map<string, Drawn>()
  const why = new Set<string>()
  const artFor = (spec: Spec, col: number): string | null => {
    const key = specKey(spec, col)
    let d = cache.get(key)
    if (!d) {
      if (spec.kind === 'item') d = itemArt(spec.content, col)
      else {
        const [a, b] = [itemArt(spec.small, col), itemArt(spec.big, col)]
        d = 'art' in a && 'art' in b ? { art: splitDiagonal(a.art, b.art) } : 'why' in a ? a : b
      }
      cache.set(key, d)
      if ('why' in d) why.add(d.why)
    }
    return 'art' in d ? key : null
  }

  const indicators: BlockIndicatorDto[] = []
  const place = (
    plane: BlockIndicatorDto['plane'],
    id: number,
    col: number,
    x: number,
    y: number,
  ) => {
    const c = resolveBlockContents(id, col, t)
    if (!c || 'unavailable' in c) return
    const spec = pickIndicator(c)
    const art = spec && artFor(spec, col)
    if (art) indicators.push({ plane, x, y, art })
  }
  const inRange = (id: number | null | undefined): id is number =>
    id != null && id >= FIRST_ITEM_BLOCK && id <= LAST_ITEM_BLOCK

  const { w, h } = screenTiles(model.isVertical)
  const mapH = (model.isVertical ? model.screenCount : 1) * h * TILE
  model.grid.forEach((row, y) =>
    row.forEach((id, x) => {
      if (!inRange(id)) return
      const br = model.map16.tiles[id]?.br
      if (br) place(br.priority ? 'l1High' : 'l1Low', id, x, x * TILE, y * TILE)
    }),
  )
  const l2 = model.l2 && model.l2.ok ? model.l2.l2 : undefined
  // An L2 image is background art, never a block (docs/rom/block-contents.md).
  if (l2 && l2.kind === 'objects') {
    // BG2 wraps vertically in 512 px unless it is a streamed vertical object map (drawL2Planes).
    const period = model.isVertical ? Infinity : 512
    l2.grid.forEach((row, y) =>
      row.forEach((id, x) => {
        if (!inRange(id)) return
        const br = l2.tiles[id]?.br
        if (!br) return
        const plane = br.priority ? 'l2High' : 'l2Low'
        const base = y * TILE + l2.dy
        const first = Number.isFinite(period) ? ((base % period) + period) % period : base
        for (let at = first; at > -TILE; at -= period) place(plane, id, x, x * TILE, at)
        for (let at = first + period; at < mapH; at += period) place(plane, id, x, x * TILE, at)
      }),
    )
  }
  const arts: Record<string, string> = {}
  for (const [k, d] of cache) if ('art' in d) arts[k] = b64(d.art)
  return {
    status: 'ok',
    orientation: model.isVertical ? 'vertical' : 'horizontal',
    screenCount: model.screenCount,
    width: w * TILE,
    height: h * TILE,
    arts,
    indicators,
    ...(why.size ? { note: `Some block contents are not drawn: ${[...why].join('; ')}.` } : {}),
  }
}

/** Replies per working-copy bytes, as `mapSprites` keeps them. */
const replies = new WeakMap<Uint8Array, Map<number, MapBlockContentsResult>>()

export function mapBlockContents(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
): MapBlockContentsResult {
  let byMap = replies.get(bytes)
  if (!byMap) replies.set(bytes, (byMap = new Map()))
  const hit = byMap.get(index)
  if (hit) return hit
  const built = cache.get(bytes, romPath, index, NO_FLAGS)
  if (!built.ok) return { status: 'unavailable', reason: built.reason }
  let r: MapBlockContentsResult
  try {
    r = blockIndicators(built.inputs, RomFile.fromBytes(romPath, Buffer.from(bytes)))
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message }
  }
  if (byMap.size >= 8) byMap.delete(byMap.keys().next().value!)
  byMap.set(index, r)
  return r
}
