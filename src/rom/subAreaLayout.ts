/**
 * SPIKE (#946, not for merge): the neighbours of the selected map as fixed-size
 * thumbnail cards. Outbound ones are where its screen exits lead; inbound ones are
 * the maps whose exits lead into it, on the reversed side. A map that is both (a
 * room with a return) is one card with two links.
 *
 * Route entrance (D66 call 1, #945, NOT built): the first screen exit that reaches the slot.
 *
 * Exit slot: the game files an exit under its OWN 5-bit field (object byte 0 & $1F), not
 * the screen the object stream is on (CODE_0DA512, bank_0D.asm:1428-1432); a later exit
 * with the same field overwrites the earlier. Mario's X (Y when vertical) high byte then
 * picks the entry (bank_05.asm:7095-7101), so every pipe or door on screen N leads to
 * screen N's exit.
 *
 * Exit point: the enterable tiles on that screen (docs/rom/enterable-pipes-and-doors.md):
 * $137/$138 pipe cap (bank_00.asm:13205-13216), $13F side pipe (13177), doors (12100-12118);
 * cap above its $135 body is a down pipe, below it an up pipe (bank_0D.asm:2118-2186).
 * With none the landing's action type picks the side (bank_05.asm:7155-7161, :7309-7322),
 * marked heuristic. Derivations: docs/spikes/946-subarea-layout.md.
 */
import { LEVEL_COUNT, isOverworldLevel, mapUsesSecondaryExits, type SmwRom } from './SmwRom'
import type { RomFile } from './RomFile'
import { parseLevelObjects, SCREEN_H, SCREEN_H_VERT, SCREEN_W, SCREEN_W_VERT } from './LevelParser'
import { readMainEntrance, readSecondaryEntrance, startGate } from './LevelStart'
import { buildL1Inputs } from './model/L1Model'
import { SWITCH_FLAGS_UNCLEARED } from './ObjectExpander'
import { buildLevelCatalog } from './LevelCatalog'
import { deriveOverworldEntrances, STOCK_OVERWORLD_FINGERPRINTS } from './OverworldEntrances'
import { SCREEN_EXIT_HIGH_AT, readSubmapHigh } from './SubmapFlagGate'
import { DATA_05F200_ADDR, DATA_05F800_ADDR } from './L3Loader'

const DATA_05FE00 = 0x05fe00
/** Card size, the gap to the map, and the gap between cards on one side, in stage pixels. */
export const CARD_W = 160
export const CARD_H = 96
export const EDGE_GAP = 48
export const CARD_GAP = 8

/** Where a card sits. `left` only arises from an inbound door: the origin's door opens beside, so the origin sits to our left. */
export type Side = 'below' | 'above' | 'beside' | 'left'
export interface Point {
  x: number
  y: number
}

/**
 * One directed line. `exit`: from this map's pipe or door (this map's pixels) to the
 * landing in the card map (the card map's pixels). `return`: from the card map's exit
 * (its pixels) to this map's landing (this map's pixels).
 */
export interface LinkDto {
  dir: 'exit' | 'return'
  from: Point
  to: Point
}
/** The end of a link in the selected map's pixels, and the end in the card map's pixels. */
export const mainEnd = (l: LinkDto): Point => (l.dir === 'exit' ? l.from : l.to)
export const cardEnd = (l: LinkDto): Point => (l.dir === 'exit' ? l.to : l.from)

export interface CardDto {
  slot: number
  side: Side
  basis: 'tile' | 'heuristic'
  inbound: boolean
  outbound: boolean
  widthPx: number
  heightPx: number
  screens: number
  links: LinkDto[]
  notes: string[]
}

export interface SubAreaLayout {
  entry: { slot: number; widthPx: number; heightPx: number }
  cards: CardDto[]
  notes: string[]
}
export type SubAreaResult = ({ ok: true } & SubAreaLayout) | { ok: false; reason: string }

const hex = (n: number, w = 2) => `$${n.toString(16).toUpperCase().padStart(w, '0')}`
const fail = (reason: string): SubAreaResult => ({ ok: false, reason })

/** A map's size in pixels: horizontal screens are 16 x 27 tiles side by side, vertical ones 32 x 16 stacked. */
export function mapSizePx(isVertical: boolean, screens: number): { w: number; h: number } {
  return isVertical
    ? { w: SCREEN_W_VERT * 16, h: SCREEN_H_VERT * 16 * screens }
    : { w: SCREEN_W * 16 * screens, h: SCREEN_H * 16 }
}

const REVERSE: Record<Side, Side> = {
  below: 'above',
  above: 'below',
  beside: 'left',
  left: 'beside',
}
export const reverseSide = (s: Side): Side => REVERSE[s]

/**
 * Card top-lefts in stage pixels, the selected map drawn at `scale` with its
 * top-left at 0,0. A card is centred on the mean of its link points along the
 * map edge it sits on (a room with a return: the midpoint of EXIT and RETURN).
 * Cards on one side are sorted along that edge and nudged apart; the size is
 * fixed, so nothing is pushed far away.
 */
export function placeCards(
  main: { w: number; h: number },
  cards: Array<{ side: Side; mains: Point[] }>,
  scale: number,
): Point[] {
  const out: Point[] = new Array(cards.length)
  const fixed: Record<Side, number> = {
    below: main.h * scale + EDGE_GAP,
    above: -(CARD_H + EDGE_GAP),
    beside: main.w * scale + EDGE_GAP,
    left: -(CARD_W + EDGE_GAP),
  }
  for (const side of ['below', 'above', 'beside', 'left'] as Side[]) {
    const alongX = side === 'below' || side === 'above'
    const size = alongX ? CARD_W : CARD_H
    const centre = (m: Point[]) => (m.reduce((a, p) => a + (alongX ? p.x : p.y), 0) / m.length) * scale // prettier-ignore
    const onSide = cards
      .flatMap((c, i) => (c.side === side ? [{ i, at: centre(c.mains) - size / 2 }] : []))
      .sort((a, b) => a.at - b.at)
    let free = -Infinity
    for (const c of onSide) {
      const at = Math.max(c.at, free)
      free = at + size + CARD_GAP
      out[c.i] = alongX ? { x: at, y: fixed[side] } : { x: fixed[side], y: at }
    }
  }
  return out
}

/** A map letterboxed into a card: the scale, and where its top-left lands inside the card. */
export function fitInCard(w: number, h: number): { scale: number; ox: number; oy: number } {
  const scale = Math.min(CARD_W / w, CARD_H / h)
  return { scale, ox: (CARD_W - w * scale) / 2, oy: (CARD_H - h * scale) / 2 }
}

export interface Feature {
  kind: Side
  at: Point
  tile: 'pipe' | 'side pipe' | 'door'
  /** Set when the player code lets only some Marios in (see the doc); such a feature sorts last. */
  conditional?: string
}

/**
 * Every enterable pipe or door on a screen: unconditional ones first, each group in
 * reading order. A $137+$138 cap pair is one pipe, a $1F over a $20 one door. Only the
 * page-1 tiles count for pipes and the page-0 tiles for doors (docs/rom/enterable-pipes-and-doors.md).
 * `$9C` is a door in tileset 1 only (bank_00.asm:12101-12105), so it needs `tileset`.
 */
export function findEnterables(
  grid: ReadonlyArray<ArrayLike<number>>,
  isVertical: boolean,
  screen: number,
  tileset?: number,
): Feature[] {
  const [x0, x1, y0, y1] = isVertical
    ? [0, SCREEN_W_VERT, screen * SCREEN_H_VERT, (screen + 1) * SCREEN_H_VERT]
    : [screen * SCREEN_W, (screen + 1) * SCREEN_W, 0, SCREEN_H]
  const at = (x: number, y: number) => grid[y]?.[x] ?? 0
  const hits: Feature[] = []
  const door = (x: number, y: number, conditional?: string) => hits.push({ kind: 'beside', at: { x: x * 16 + 8, y: y * 16 + 16 }, tile: 'door', conditional }) // prettier-ignore
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = at(x, y)
      if (t === 0x137 || (t === 0x138 && at(x - 1, y) !== 0x137)) {
        const pair = t === 0x137 && at(x + 1, y) === 0x138
        // Down pipe: body ($135) under the cap. Up pipe: body above it.
        const body = (yy: number) => at(x, yy) === 0x135
        const kind = body(y + 1) ? 'below' : body(y - 1) ? 'above' : 'below'
        hits.push({ kind, at: { x: x * 16 + (pair ? 16 : 8), y: y * 16 + (kind === 'above' ? 16 : 0) }, tile: 'pipe' }) // prettier-ignore
      } else if (t === 0x13f) {
        hits.push({ kind: 'beside', at: { x: x * 16 + 8, y: y * 16 + 16 }, tile: 'side pipe' })
      } else if (t === 0x20) door(x, y)
      else if (t === 0x1f && at(x, y + 1) !== 0x20) door(x, y, 'only for small Mario')
      else if (t === 0x27 || t === 0x28) door(x, y, 'only while the blue P-switch runs')
      else if (t === 0x9c && tileset === 1) door(x, y, 'only in tileset 1')
    }
  }
  return [...hits.filter(h => !h.conditional), ...hits.filter(h => h.conditional)]
}

/** The entrance action type of the landing (see the header), or null if the table is cut. */
function actionType(rom: RomFile, secondaryIndex: number | null, slot: number): number | null {
  if (secondaryIndex !== null) {
    const b = rom.readByte(DATA_05FE00 + secondaryIndex)
    return b === null ? null : b & 7
  }
  const b = rom.readByte(DATA_05F200_ADDR + slot)
  return b === null ? null : (b & 0x38) >> 3
}

const ACTION_KIND: Record<number, Side> = { 0: 'beside', 1: 'beside', 2: 'beside', 3: 'below', 4: 'above' } // prettier-ignore

interface ExitTo {
  /** The slot the game files it under: object byte 0 & $1F, not the stream's screen. */
  screen: number
  dest: number
  index: number | null
}
/** An exit object as the stream holds it, before the game's slot rule is applied. */
export type ExitObj = ExitTo

/** One exit per slot, the later object overwriting the earlier as the game's STA does; the dropped ones are named in `notes`. */
export function resolveExitSlots(objs: ReadonlyArray<ExitObj>): {
  exits: ExitTo[]
  notes: string[]
} {
  const bySlot = new Map<number, ExitObj>()
  const notes: string[] = []
  for (const o of objs) {
    const old = bySlot.get(o.screen)
    if (old) notes.push(`Two exits use screen slot ${hex(o.screen)}; the game keeps the later one (to ${hex(o.dest, 3)}) and drops the earlier (to ${hex(old.dest, 3)}).`) // prettier-ignore
    bySlot.set(o.screen, o)
  }
  return { exits: [...bySlot.values()].sort((a, b) => a.screen - b.screen), notes }
}

/** The exits in an L1 stream with destinations resolved; `secondaryLow` reads DATA_05F800. Null when the list runs off its data. */
export function exitsFromStream(
  raw: Uint8Array,
  high: number,
  secondaryLow: (index: number) => number | null,
): { exits: ExitTo[]; notes: string[] } | null {
  const parsed = parseLevelObjects(raw, [])
  if (!parsed.terminated) return null
  const found = parsed.objects.filter(o => o.screenExitDest !== undefined)
  const secondary = mapUsesSecondaryExits(found)
  const objs: ExitObj[] = []
  for (const o of found) {
    // SPIKE WORKAROUND: LevelParser does not expose the exit's own screen field (bank_0D.asm:1428-1432); see PR #947 bug draft.
    const field = raw[o.streamOffset]! & 0x1f
    const rawByte = o.screenExitDest! & 0xff
    if (!secondary) objs.push({ screen: field, dest: high | rawByte, index: null })
    else {
      const low = secondaryLow(high | rawByte)
      if (low !== null) objs.push({ screen: field, dest: high | low, index: high | rawByte })
    }
  }
  return resolveExitSlots(objs)
}

/** A map's screen exits; the exit graph's own flag is bit 8 of the slot under the stock loader (SmwRom.buildLevelExitGraph). */
function exitsFrom(rom: SmwRom, slot: number, screenHigh: number) {
  const raw = rom.getLevelRawData(slot)
  return raw && exitsFromStream(raw, slot >= 0x100 ? screenHigh << 8 : 0, i => rom.rom.readByte(DATA_05F800_ADDR + i)) // prettier-ignore
}

interface Edge {
  side: Side
  basis: 'tile' | 'heuristic'
  /** The first enterable on the exit's screen, in the exit map's pixels. */
  exit: Point
  land: Point
  notes: string[]
}

/** One exit as geometry: the pipe or door to draw from, the side that implies, and the landing. Pure. */
export function edgeOf(
  grid: ReadonlyArray<ArrayLike<number>>,
  isVertical: boolean,
  tileset: number,
  ex: ExitTo,
  landing: Point,
  want: Side | undefined,
  act: number | null,
): Edge {
  const notes: string[] = []
  const hits = findEnterables(grid, isVertical, ex.screen, tileset)
  let side: Side
  let basis: Edge['basis'] = 'tile'
  let exit: Point
  if (hits.length > 0) {
    const hit = hits[0]!
    side = hit.kind
    exit = hit.at
    if (hits.length > 1) notes.push(`${hits.length} pipes or doors on screen ${hex(ex.screen)} all lead to this exit; the line starts at the first.`) // prettier-ignore
    for (const h of hits) if (h.conditional) notes.push(`The ${h.tile} on screen ${hex(ex.screen)} works ${h.conditional}.`) // prettier-ignore
    if (want && want !== side) notes.push(`The ${hit.tile} suggests ${side} but the landing's action suggests ${want}.`) // prettier-ignore
  } else {
    basis = 'heuristic'
    side = want ?? 'below'
    const [sw, sh] = isVertical ? [SCREEN_W_VERT * 16, SCREEN_H_VERT * 16] : [SCREEN_W * 16, SCREEN_H * 16] // prettier-ignore
    exit = isVertical ? { x: sw / 2, y: ex.screen * sh + sh / 2 } : { x: ex.screen * sw + sw / 2, y: sh / 2 } // prettier-ignore
    notes.push(`No pipe or door on screen ${hex(ex.screen)}; placed from the entrance action (${act ?? 'unknown'}) and drawn from the screen centre.`) // prettier-ignore
  }
  return { side, basis, exit, land: landing, notes }
}

/** What outboundCards needs from the ROM, so the rule runs on built bytes in a test. */
export interface CardDeps {
  /** Mario's landing (centre column, feet) for the exit, or null if the entrance cannot be read. */
  landing(ex: ExitTo): Point | null
  /** The destination map's size, or the reason it cannot be read. */
  neighbour(dest: number): { w: number; h: number; screens: number } | string
  action(ex: ExitTo): { side: Side | undefined; act: number | null }
  /** Why an exit is not a card (the overworld, this map, no map stored), or null. */
  refuse(dest: number): string | null
}

/** A tile-based side beats a guessed one; between equals the first link wins. */
function addLink(
  cards: Map<number, CardDto>,
  slot: number,
  size: { w: number; h: number; screens: number },
  e: Edge,
  side: Side,
  link: LinkDto,
) {
  // prettier-ignore
  const c = cards.get(slot) ?? { slot, side, basis: e.basis, inbound: false, outbound: false, widthPx: size.w, heightPx: size.h, screens: size.screens, links: [], notes: [] } // prettier-ignore
  if (c.links.length > 0 && c.basis === 'heuristic' && e.basis === 'tile') [c.side, c.basis] = [side, e.basis] // prettier-ignore
  c.links.push(link)
  for (const n of e.notes) if (!c.notes.includes(n)) c.notes.push(n)
  if (link.dir === 'exit') c.outbound = true
  else c.inbound = true
  cards.set(slot, c)
}

/** One card per destination slot; an exit that is not a card is named in `notes` with its reason. */
export function outboundCards(
  exits: ReadonlyArray<ExitTo>,
  grid: ReadonlyArray<ArrayLike<number>>,
  isVertical: boolean,
  tileset: number,
  deps: CardDeps,
  cards: Map<number, CardDto>,
  notes: string[],
): void {
  for (const ex of exits) {
    const why = deps.refuse(ex.dest)
    if (why) {
      notes.push(`Exit from screen ${hex(ex.screen)} to ${hex(ex.dest, 3)} is not a card: ${why}.`)
      continue
    }
    const size = deps.neighbour(ex.dest)
    const land = deps.landing(ex)
    if (typeof size === 'string' || !land) {
      notes.push(`Exit from screen ${hex(ex.screen)} to ${hex(ex.dest, 3)} is not a card: ${typeof size === 'string' ? size : 'its entrance could not be read'}.`) // prettier-ignore
      continue
    }
    const { side: want, act } = deps.action(ex)
    const e = edgeOf(grid, isVertical, tileset, ex, land, want, act)
    addLink(cards, ex.dest, size, e, e.side, { dir: 'exit', from: e.exit, to: e.land })
  }
}

/** The return line: from the origin's own exit pipe or door (its pixels) to this map's landing. */
export function returnCard(
  cards: Map<number, CardDto>,
  origin: number,
  from: {
    grid: ReadonlyArray<ArrayLike<number>>
    isVertical: boolean
    tileset: number
    screens: number
  },
  ex: ExitTo,
  deps: CardDeps,
): void {
  const land = deps.landing(ex)
  if (!land) return
  const { side: want, act } = deps.action(ex)
  const e = edgeOf(from.grid, from.isVertical, from.tileset, ex, land, want, act)
  const size = mapSizePx(from.isVertical, from.screens)
  addLink(cards, origin, { ...size, screens: from.screens }, e, reverseSide(e.side), { dir: 'return', from: e.exit, to: e.land }) // prettier-ignore
}

export function buildSubAreaLayout(rom: SmwRom, entry: number): SubAreaResult {
  const gate = startGate(rom.rom)
  if (gate) return fail(gate)
  if (!Number.isInteger(entry) || entry < 0 || entry >= LEVEL_COUNT) return fail('That map number does not exist.') // prettier-ignore
  const catalog = buildLevelCatalog(rom)
  if (!catalog.entries[entry]?.isReal) return fail('No map is stored in this slot.')
  const l1 = buildL1Inputs(rom, entry, SWITCH_FLAGS_UNCLEARED)
  if (!l1.ok) return fail(l1.reason)
  const model = l1.inputs
  const main = mapSizePx(model.isVertical, model.screenCount)
  const screenHigh = readSubmapHigh(rom.rom, SCREEN_EXIT_HIGH_AT)
  if (typeof screenHigh === 'string') return fail(screenHigh)
  const own = exitsFrom(rom, entry, screenHigh)
  if (!own) return fail('The exit list of this map runs off its data, so it is not followed.')

  const notes: string[] = [...own.notes]
  const roots = deriveOverworldEntrances(rom).roots
  const origins: number[] = []
  if (roots) {
    const g = rom.buildLevelExitGraph(roots, STOCK_OVERWORLD_FINGERPRINTS.entry)
    if (g.unavailable) notes.push('Maps that lead into this one could not be listed.')
    for (const [from, tos] of g.graph) if (tos.includes(entry)) origins.push(from)
  } else notes.push('Maps that lead into this one could not be listed.')

  const real = (slot: number) => slot !== entry && !!catalog.entries[slot]?.isReal
  const cards = new Map<number, CardDto>()
  const deps: CardDeps = {
    landing: ex => {
      const l = ex.index !== null ? readSecondaryEntrance(rom.rom, ex.index, ex.dest) : readMainEntrance(rom.rom, ex.dest) // prettier-ignore
      // Mario's centre column and feet, from the entrance's top-left
      return l ? { x: l.x + 8, y: l.y + 16 } : null
    },
    neighbour: dest => {
      const nb = buildL1Inputs(rom, dest, SWITCH_FLAGS_UNCLEARED)
      if (!nb.ok) return nb.reason
      const s = mapSizePx(nb.inputs.isVertical, nb.inputs.screenCount)
      return { w: s.w, h: s.h, screens: nb.inputs.screenCount }
    },
    action: ex => {
      const act = actionType(rom.rom, ex.index, ex.dest)
      return { side: act === null ? undefined : ACTION_KIND[act], act }
    },
    refuse: dest => {
      if (dest === entry) return 'it leads back into this map'
      if (!real(dest)) return 'no map is stored in that slot'
      // An exit into a level the overworld enters is a way out of the area, not a sub area.
      if (isOverworldLevel(dest, roots)) return 'the overworld enters that map, so it is a way out, not a sub area' // prettier-ignore
      return null
    },
  }
  outboundCards(own.exits, model.grid, model.isVertical, model.header.objectTileset, deps, cards, notes) // prettier-ignore

  for (const origin of origins) {
    const ex = real(origin) ? exitsFrom(rom, origin, screenHigh)?.exits.find(x => x.dest === entry) : undefined // prettier-ignore
    const nb = ex ? buildL1Inputs(rom, origin, SWITCH_FLAGS_UNCLEARED) : undefined
    if (!nb?.ok || !ex) continue
    const i = nb.inputs
    returnCard(cards, origin, { grid: i.grid, isVertical: i.isVertical, tileset: i.header.objectTileset, screens: i.screenCount }, ex, deps) // prettier-ignore
  }
  return { ok: true, entry: { slot: entry, widthPx: main.w, heightPx: main.h }, cards: [...cards.values()], notes } // prettier-ignore
}
