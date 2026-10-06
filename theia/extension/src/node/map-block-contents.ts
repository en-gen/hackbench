/**
 * The map tab's block content indicators (#566, PR B): which item blocks a map
 * holds, and the 16 x 16 art of what each gives. Resolution is the core's
 * (`resolveBlockContents`, docs/rom/block-contents.md); this file places and draws.
 *
 * Item art is the sprite RUN on the 65816 core, the path the map's sprite layer
 * uses (#585, `interpDrawer`), seeded as the block spawn leaves it:
 * GenSpriteFromBlk (SMWDisX bank_02.asm:1122-1160) writes the status from
 * StatusOfSprInBlk and the number, then calls InitSpriteTables, so the
 * sprite's INIT never runs and its status handler draws it (a status-9 egg or
 * shell goes through the stunned handler). Then the spawn writes its own cells
 * (bank_02.asm:1199-1278): the rise speed and timers, read from the ROM below,
 * and the P-switch colour (bank_02.asm:1280-1292, from the resolver). Not
 * modelled: the balloon's direction and C2 bump (:1218, :1256), the egg's
 * contents cell (:1250), the tweaker turn timer (:1274). The coin is not a
 * sprite: its chars are the immediates of the coin draw (bank_02.asm:3432-3441).
 * A refused or empty run draws no indicator and the map says why; no table fallback.
 *
 * The theia map view never used the old `renderOverlay` of
 * StarOneUpVineBlockBehavior and KeyCoinBalloonKoopaBlockBehavior (the
 * reference webview model's), so nothing there is replaced.
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
  type BlockContentTables,
  type TablesUnavailable,
} from '../../../../src/rom/BlockContents'
import { findExactlyOneSite, WILD } from '../../../../src/rom/BytePattern'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { runOnce, type SpawnState } from '../../../../src/rom/sprites/interp/SpriteRunner'
import type { EnginePart } from '../../../../src/rom/model/sprites/generic/SpriteDrawEngine'
import { BLOCK as TILE, bakePlus, fitArt, splitDiagonal } from '../common/block-indicator'
import type { BlockIndicatorDto, MapBlockContentsResult } from '../common/project-protocol'
import { drawSprites, interpDrawer, type SpriteDrawer } from './map-sprites'
import { base64, screenTiles, type L1ModelCache, type MapInputs } from './map-screen'

const NO_FLAGS = { yellow: false, green: false, red: false, blue: false }
/** Replies kept per working-copy bytes: each holds every item's art, so a whole ROM's maps are not. */
const REPLIES_PER_BYTES = 8
/** Slot-0 offsets of the cells the spawn writes (rammap.asm). */
const CELL = { ySpeed: 0xaa, c2: 0xc2, timer1540: 0x1540, rise154C: 0x154c, dir157C: 0x157c, objAttr: 0x15f6 } as const // prettier-ignore
const SPRITE_KOOPA = 0x04
const SPRITE_PSWITCH = 0x3e
const SPRITE_YOSHI_EGG = 0x2c
const SPRITE_BALLOON = 0x7d
const SPRITE_RED_COIN = 0x7e

type Item = Exclude<BlockContent, { kind: 'none' }>
type SpriteItem = Extract<BlockContent, { kind: 'sprite' }>

export type Spec =
  | { kind: 'item'; content: Item }
  | { kind: 'split'; small: Item; big: Item }
  | { kind: 'undrawn'; why: string }

/**
 * THE one place that chooses what a block draws (owner rulings on #566, #623).
 * Progressive blocks (#607) split mushroom (bottom-left) and item (top-right).
 * A block with two outcomes that are not progressive but include a coin ($11A
 * column 0 of 3, $122: star or coin; $12D: coin or 1-up) splits the same way, coin
 * bottom-left. A block with one possible content draws it; an empty branch
 * (`none`) is no item. Null: an empty block. Any other pair (the Yoshi-loose
 * variants) is undrawn, with a plain-words reason.
 */
export function pickIndicator(c: BlockContents): Spec | null {
  const items = c.alternatives.flatMap(a => (a.content.kind === 'none' ? [] : [a.content]))
  if (items.length === 1) return { kind: 'item', content: items[0]! }
  if (c.progressive && items.length === 2 && c.alternatives.length === 2) {
    return { kind: 'split', small: items[0]!, big: items[1]! }
  }
  if (c.alternatives.length === 0) return null
  const yoshi = c.alternatives.some(a => a.when?.startsWith('Yoshi is loose'))
  const coin = items.findIndex(i => i.kind === 'coin')
  if (!yoshi && items.length === 2 && c.alternatives.length === 2 && coin >= 0) {
    return { kind: 'split', small: items[coin]!, big: items[1 - coin]! }
  }
  return {
    kind: 'undrawn',
    why: yoshi
      ? 'whose item changes when Yoshi is loose'
      : 'whose item depends on game state in a way that is not drawn',
  }
}

const keyOf = (c: Item): string =>
  c.kind === 'sprite' ? `s${c.sprite.toString(16)}:${c.status}:${c.attribute ?? ''}` : c.kind
const specKey = (s: Exclude<Spec, { kind: 'undrawn' }>): string =>
  s.kind === 'item' ? keyOf(s.content) : `${keyOf(s.small)}/${keyOf(s.big)}`

export type Drawn = { art: Uint8ClampedArray } | { why: string }

/** How each kind of item is drawn; the real one runs the ROM, tests inject one. */
export interface ItemArt {
  coin(multi: boolean): Drawn
  sprite(c: SpriteItem, col: number, row: number): Drawn
}

/** The model parts the indicators need, so tests can build one without a ROM. */
export type IndicatorModel = Pick<MapInputs, 'grid' | 'map16' | 'l2' | 'isVertical' | 'screenCount'>

/** A refusal in the interpreter's or the placeholder's words, as plain words for the note. */
export function plainWhy(reason: string): string {
  if (reason === 'charsNotLoaded') return 'whose graphics are not loaded in this level'
  if (reason === 'noParts' || reason.startsWith('drew no') || reason.startsWith('INIT erased'))
    return 'whose item draws nothing in its first frames'
  if (reason.startsWith('refused')) return `whose sprite code was refused (${reason.slice(9)})`
  return `whose item could not be drawn (${reason})`
}

const inRange = (id: number | null | undefined): id is number =>
  id != null && id >= FIRST_ITEM_BLOCK && id <= LAST_ITEM_BLOCK

export function blockIndicators(
  model: IndicatorModel,
  t: BlockContentTables | TablesUnavailable,
  art: ItemArt,
): Extract<MapBlockContentsResult, { status: 'ok' | 'unavailable' }> {
  if (isUnavailable(t)) return { status: 'unavailable', reason: t.unavailable }
  const cache = new Map<string, Drawn>()
  const missed = new Map<string, number>()
  const miss = (why: string) => missed.set(why, (missed.get(why) ?? 0) + 1)
  const drawItem = (c: Item, col: number, row: number): Drawn =>
    c.kind === 'sprite' ? art.sprite(c, col, row) : art.coin(c.kind === 'multiCoin')
  const artFor = (
    spec: Exclude<Spec, { kind: 'undrawn' }>,
    col: number,
    row: number,
  ): string | null => {
    // prettier-ignore
    const key = specKey(spec)
    let d = cache.get(key)
    if (!d) {
      if (spec.kind === 'item') d = drawItem(spec.content, col, row)
      else {
        const [a, b] = [drawItem(spec.small, col, row), drawItem(spec.big, col, row)]
        d = 'art' in a && 'art' in b ? { art: splitDiagonal(a.art, b.art) } : 'why' in a ? a : b
      }
      cache.set(key, d)
    }
    if ('why' in d) {
      miss(plainWhy(d.why))
      return null
    }
    return key
  }

  const indicators: BlockIndicatorDto[] = []
  const place = (
    plane: BlockIndicatorDto['plane'],
    id: number,
    col: number,
    x: number,
    y: number,
  ) => {
    // prettier-ignore
    const c = resolveBlockContents(id, col, t)
    if (!c) return
    if (isUnavailable(c)) return miss(c.unavailable)
    const spec = pickIndicator(c)
    if (!spec) return
    if (spec.kind === 'undrawn') return miss(spec.why)
    const key = artFor(spec, col, Math.max(0, Math.floor(y / TILE)))
    if (key) indicators.push({ plane, x, y, art: key })
  }

  // L1: the plane is the one its bottom-right subtile priority picks, where the indicator sits.
  model.grid.forEach((row, y) =>
    row.forEach((id, x) => {
      if (!inRange(id)) return
      const br = model.map16.tiles[id]?.br
      if (br) place(br.priority ? 'l1High' : 'l1Low', id, x, x * TILE, y * TILE)
    }),
  )
  const { w, h } = screenTiles(model.isVertical)
  const l2 = model.l2 && model.l2.ok ? model.l2.l2 : undefined
  // An L2 image is background art, never a block.
  if (l2 && l2.kind === 'objects') {
    // BG2 wraps vertically in 512 px unless it is a streamed vertical object map (drawL2Planes).
    const period = model.isVertical ? Infinity : 512
    const mapH = (model.isVertical ? model.screenCount : 1) * h * TILE
    l2.grid.forEach((row, y) =>
      row.forEach((id, x) => {
        if (!inRange(id)) return
        const br = l2.tiles[id]?.br
        if (!br) return
        const plane = br.priority ? 'l2High' : 'l2Low'
        const base = y * TILE + l2.dy
        const first = Number.isFinite(period) ? ((base % period) + period) % period : base
        for (let at = first; at > -TILE; at -= period)
          if (at < mapH) place(plane, id, x, x * TILE, at)
        for (let at = first + period; at < mapH; at += period) place(plane, id, x, x * TILE, at)
      }),
    )
  }
  const arts: Record<string, string> = {}
  for (const [k, d] of cache) if ('art' in d) arts[k] = base64(d.art)
  const notes = [...missed].map(([why, n]) => `${n} ${n === 1 ? 'block' : 'blocks'} ${why}`)
  return {
    status: 'ok',
    orientation: model.isVertical ? 'vertical' : 'horizontal',
    screenCount: model.screenCount,
    width: w * TILE,
    height: h * TILE,
    arts,
    indicators,
    ...(notes.length ? { note: `Block contents not shown: ${notes.join('; ')}.` } : {}),
  }
}

// -- reading the code the art depends on ---------------------------------------------------

type Read<T> = ({ ok: true } & T) | { ok: false; reason: string }

/**
 * The coin draw (bank_02.asm:3432-3441): LDA #tile / STA OAMTileNo,Y /
 * LDA #attr / ORA SpriteProperties / STA OAMTileAttr,Y / TYA / LSR / LSR / TAY / LDA #$02
 * (a 16 x 16 entry) / STA OAMTileSize,Y. The pattern is the gate; the operands are the answer.
 */
export function readCoinParts(rom: RomFile): Read<{ parts: EnginePart[] }> {
  const what = 'the coin sprite draw (bank_02.asm:3432-3441)'
  const site = findExactlyOneSite(rom, [0xa9, WILD, 0x99, WILD, WILD, 0xa9, WILD, 0x05, 0x64, 0x99, WILD, WILD, 0x98, 0x4a, 0x4a, 0xa8, 0xa9, 0x02, 0x99], what) // prettier-ignore
  if (!site.ok) return { ok: false, reason: site.reason }
  const b = rom.readAtFileOffset(site.offset, 19)
  if (!b) return { ok: false, reason: `${what} is past the end of this ROM` }
  const [tile, attr] = [b[1]!, b[6]!]
  const [page, row] = [(attr & 1) << 8, 8 + ((attr >> 1) & 7)]
  const parts = [[0, 0, 0], [1, 8, 0], [0x10, 0, 8], [0x11, 8, 8]].map(([n, dx, dy]) => ({ charNum: 0x400 + page + tile + n!, palette: row, flipX: false, flipY: false, dx: dx!, dy: dy! })) // prettier-ignore
  return { ok: true, parts }
}

/** What the spawn writes into the new sprite's cells besides status and colour (bank_02.asm:1260-1278). */
export interface SpawnTimers {
  shellTimer: number
  ySpeed: number
  otherTimer: number
  rise: number
}

/**
 * ADDR_028A08 .. CODE_028A11 (bank_02.asm:1260-1273): LDA #t / STA SpriteMisc1540,X /
 * LDA #speed / BRA / LDA #t2 / STA SpriteMisc1540,X / LDA #speed / STA SpriteYSpeed,X /
 * LDA #rise / STA SpriteMisc154C,X.
 */
export function readSpawnTimers(rom: RomFile): Read<{ timers: SpawnTimers }> {
  const what = 'the item block spawn timers (bank_02.asm:1260-1273)'
  const P = [0xa9, WILD, 0x9d, 0x40, 0x15, 0xa9, WILD, 0x80, WILD, 0xa9, WILD, 0x9d, 0x40, 0x15, 0xa9, WILD, 0x95, WILD, 0xa9, WILD, 0x9d, 0x4c, 0x15] // prettier-ignore
  const site = findExactlyOneSite(rom, P, what)
  if (!site.ok) return { ok: false, reason: site.reason }
  const b = rom.readAtFileOffset(site.offset, P.length)
  if (!b) return { ok: false, reason: `${what} is past the end of this ROM` }
  return {
    ok: true,
    timers: { shellTimer: b[1]!, ySpeed: b[6]!, otherTimer: b[10]!, rise: b[19]! },
  }
}

/**
 * The spawn state of an item sprite: its status from the resolver and the cells the
 * spawn wrote after InitSpriteTables (bank_02.asm:1199-1292). A balloon-family
 * rewrite (`position` set) returns early at :1219 / :1258 or takes :1253.
 */
export function spawnState(c: SpriteItem, tm: SpawnTimers): SpawnState {
  const ram: Record<number, number> = {}
  const rise = () => Object.assign(ram, { [CELL.ySpeed]: tm.ySpeed, [CELL.rise154C]: tm.rise })
  if (c.position !== undefined && c.sprite === SPRITE_BALLOON) ram[CELL.dir157C] = 1
  else if (c.position !== undefined && c.sprite === SPRITE_RED_COIN) ram[CELL.c2] = 2
  else if (c.position !== undefined) rise()
  else if (c.sprite === SPRITE_KOOPA) Object.assign(rise(), { [CELL.timer1540]: tm.shellTimer })
  else if (c.sprite === SPRITE_PSWITCH) {
    rise()
    if (c.attribute !== undefined) ram[CELL.objAttr] = c.attribute
  } else if (c.sprite === SPRITE_YOSHI_EGG) rise()
  else Object.assign(rise(), { [CELL.timer1540]: tm.otherTimer })
  return { status: c.status, ram }
}

const fake = (spriteId: number, x: number, y: number) =>
  ({ screen: 0, x, y, spriteId, extraBit: false, raw: [0, 0, 0], index: 0 }) as LevelSprite

/** The ROM-backed art: sprites run on the core, the coin from its draw immediates. */
export function romArt(rom: RomFile, index: number, model: MapInputs): ItemArt {
  const level = { vram: model.vram, colors: model.colors }
  const render = (draw: SpriteDrawer, id: number, col: number, row: number): Drawn => {
    const [d] = drawSprites([fake(id, col, row)], level, draw)
    if (d!.status !== 'drawn') return { why: d!.reason ?? 'not drawn' }
    const rgba = new Uint8ClampedArray(Buffer.from(d!.rgba, 'base64'))
    return { art: fitArt(rgba, d!.box.x1 - d!.box.x0, d!.box.y1 - d!.box.y0) }
  }
  const coin = readCoinParts(rom)
  const timers = readSpawnTimers(rom)
  let spawn: SpawnState | undefined
  // The level loader runs once, on the first sprite item; a coin-only map never starts it.
  let drawer: SpriteDrawer | undefined
  return {
    coin: multi => {
      if (!coin.ok) return { why: coin.reason }
      const identity = { spriteId: 0, mainHandler: 0, initHandler: 0, status: 'vanilla' as const }
      const d = render(() => ({ ok: true, parts: coin.parts, identity }), 0, 0, 0)
      return 'art' in d && multi ? { art: bakePlus(d.art) } : d
    },
    sprite: (c, col, row) => {
      if (!timers.ok) return { why: timers.reason }
      spawn = spawnState(c, timers.timers)
      drawer ??= interpDrawer(rom, index, model, (r, id, seed) => runOnce(r, id, seed, { spawn })) // prettier-ignore
      return render(drawer, c.sprite, col, row)
    },
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
    const rom = RomFile.fromBytes(romPath, Buffer.from(bytes))
    r = blockIndicators(built.inputs, readBlockContentTables(rom), romArt(rom, index, built.inputs))
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message }
  }
  if (byMap.size >= REPLIES_PER_BYTES) byMap.delete(byMap.keys().next().value!)
  byMap.set(index, r)
  return r
}
