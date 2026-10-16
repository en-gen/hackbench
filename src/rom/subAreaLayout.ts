/**
 * SPIKE (#946, not for merge): the neighbours of the selected map as fixed-size
 * thumbnail cards. Outbound ones are where its screen exits lead; inbound ones are
 * the maps whose exits lead into it, on the reversed side. A map that is both (a
 * room with a return) is one card with two links.
 *
 * Route entrance (D66 call 1, #945, NOT built): the first screen exit that reaches the slot.
 *
 * Exit point: the pipe or door is found by scanning the exit's screen for the tiles the
 * player code tests ($137/$138 pipe cap, bank_00.asm:13205-13216; $13F side pipe,
 * bank_00.asm:13177; $20 door, bank_00.asm:12100-12118; cap above its $135 body is a
 * down pipe, below it an up pipe, bank_0D.asm:2118-2186). With none on the screen the
 * landing's action type picks the side (bank_05.asm:7155-7161, :7309-7322), marked
 * heuristic. Derivations: docs/spikes/946-subarea-layout.md.
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

export interface LinkDto {
  /** In the selected map's pixels: the pipe or door (outbound) or the landing (inbound). */
  main: Point
  /** In the card map's own pixels: the other end. */
  card: Point
}

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

interface Found {
  kind: Side
  at: Point
  tile: string
  count: number
}

/** The enterable tile on a screen (first in reading order), its centre and the side it implies; null when none. */
export function findEnterable(
  grid: ReadonlyArray<ArrayLike<number>>,
  isVertical: boolean,
  screen: number,
): Found | null {
  const [x0, x1, y0, y1] = isVertical
    ? [0, SCREEN_W_VERT, screen * SCREEN_H_VERT, (screen + 1) * SCREEN_H_VERT]
    : [screen * SCREEN_W, (screen + 1) * SCREEN_W, 0, SCREEN_H]
  const at = (x: number, y: number) => grid[y]?.[x] ?? 0
  const hits: Found[] = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = at(x, y)
      if (t === 0x137) {
        // Down pipe: body ($135) under the cap. Up pipe: body above it.
        const body = (yy: number) => at(x, yy) === 0x135
        const kind = body(y + 1) ? 'below' : body(y - 1) ? 'above' : 'below'
        hits.push({ kind, at: { x: x * 16 + 16, y: y * 16 + (kind === 'above' ? 16 : 0) }, tile: 'pipe', count: 0 }) // prettier-ignore
      } else if (t === 0x13f) {
        hits.push({ kind: 'beside', at: { x: x * 16 + 8, y: y * 16 + 16 }, tile: 'side pipe', count: 0 }) // prettier-ignore
      } else if (t === 0x20) {
        hits.push({ kind: 'beside', at: { x: x * 16 + 8, y: y * 16 + 16 }, tile: 'door', count: 0 }) // prettier-ignore
      }
    }
  }
  return hits.length > 0 ? { ...hits[0]!, count: hits.length } : null
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
  screen: number
  dest: number
  index: number | null
}

/** A map's screen exits in screen order with destinations resolved; null when the list runs off its data. */
function exitsFrom(rom: SmwRom, slot: number, screenHigh: number): ExitTo[] | null {
  const raw = rom.getLevelRawData(slot)
  if (!raw) return null
  const parsed = parseLevelObjects(raw, [])
  if (!parsed.terminated) return null
  const exits = parsed.objects
    .filter(o => o.screenExitDest !== undefined)
    .sort((a, b) => a.screen - b.screen)
  const secondary = mapUsesSecondaryExits(exits)
  // The exit graph's own flag: bit 8 of the slot under the stock loader (SmwRom.buildLevelExitGraph).
  const high = slot >= 0x100 ? screenHigh << 8 : 0
  const out: ExitTo[] = []
  for (const o of exits) {
    const rawByte = o.screenExitDest! & 0xff
    if (!secondary) {
      out.push({ screen: o.screen, dest: high | rawByte, index: null })
      continue
    }
    const low = rom.rom.readByte(DATA_05F800_ADDR + (high | rawByte))
    if (low !== null) out.push({ screen: o.screen, dest: high | low, index: high | rawByte })
  }
  return out
}

type L1 = Extract<ReturnType<typeof buildL1Inputs>, { ok: true }>['inputs']

interface Edge {
  side: Side
  basis: 'tile' | 'heuristic'
  exit: Point
  land: Point
  notes: string[]
}

/** One exit as geometry: where the player goes in, which side that implies, and where they land. */
function edgeOf(rom: SmwRom, from: L1, ex: ExitTo): Edge | null {
  const landing = ex.index !== null ? readSecondaryEntrance(rom.rom, ex.index, ex.dest) : readMainEntrance(rom.rom, ex.dest) // prettier-ignore
  if (!landing) return null
  const notes: string[] = []
  const hit = findEnterable(from.grid, from.isVertical, ex.screen)
  const act = actionType(rom.rom, ex.index, ex.dest)
  const want = act === null ? undefined : ACTION_KIND[act]
  let side: Side
  let basis: Edge['basis'] = 'tile'
  let exit: Point
  if (hit) {
    side = hit.kind
    exit = hit.at
    if (hit.count > 1) notes.push(`${hit.count} pipes or doors on screen ${hex(ex.screen)}, aligned to the first.`) // prettier-ignore
    if (want && want !== side) notes.push(`The ${hit.tile} suggests ${side} but the landing's action suggests ${want}.`) // prettier-ignore
  } else {
    basis = 'heuristic'
    side = want ?? 'below'
    const [sw, sh] = from.isVertical ? [SCREEN_W_VERT * 16, SCREEN_H_VERT * 16] : [SCREEN_W * 16, SCREEN_H * 16] // prettier-ignore
    exit = from.isVertical ? { x: sw / 2, y: ex.screen * sh + sh / 2 } : { x: ex.screen * sw + sw / 2, y: sh / 2 } // prettier-ignore
    notes.push(`No pipe or door tile on screen ${hex(ex.screen)}; placed from the entrance action (${act ?? 'unknown'}) and aligned to the screen centre.`) // prettier-ignore
  }
  // Mario's centre column and feet, from the entrance's top-left
  return { side, basis, exit, land: { x: landing.x + 8, y: landing.y + 16 }, notes }
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
  const exits = exitsFrom(rom, entry, screenHigh)
  if (!exits) return fail('The exit list of this map runs off its data, so it is not followed.')

  const notes: string[] = []
  const roots = deriveOverworldEntrances(rom).roots
  const origins: number[] = []
  if (roots) {
    const g = rom.buildLevelExitGraph(roots, STOCK_OVERWORLD_FINGERPRINTS.entry)
    if (g.unavailable) notes.push('Maps that lead into this one could not be listed.')
    for (const [from, tos] of g.graph) if (tos.includes(entry)) origins.push(from)
  } else notes.push('Maps that lead into this one could not be listed.')

  const real = (slot: number) => slot !== entry && !!catalog.entries[slot]?.isReal
  const cards = new Map<number, CardDto>()
  /** A tile-based side beats a guessed one; between equals the first link wins. */
  const add = (slot: number, nb: L1, e: Edge, side: Side, link: LinkDto, inbound: boolean) => {
    const size = mapSizePx(nb.isVertical, nb.screenCount)
    const c = cards.get(slot) ?? { slot, side, basis: e.basis, inbound: false, outbound: false, widthPx: size.w, heightPx: size.h, screens: nb.screenCount, links: [], notes: [] } // prettier-ignore
    if (c.links.length > 0 && c.basis === 'heuristic' && e.basis === 'tile') [c.side, c.basis] = [side, e.basis] // prettier-ignore
    c.links.push(link)
    c.notes.push(...e.notes)
    if (inbound) c.inbound = true
    else c.outbound = true
    cards.set(slot, c)
  }

  const seen = new Set<number>()
  for (const ex of exits) {
    // An exit into a level the overworld enters is a way out of the area, not a sub area.
    if (!real(ex.dest) || isOverworldLevel(ex.dest, roots) || seen.has(ex.dest)) continue
    seen.add(ex.dest)
    const nb = buildL1Inputs(rom, ex.dest, SWITCH_FLAGS_UNCLEARED)
    const e = nb.ok ? edgeOf(rom, model, ex) : null
    if (!nb.ok || !e) {
      notes.push(`Neighbour ${hex(ex.dest, 3)} could not be read, so it is left out.`)
      continue
    }
    add(ex.dest, nb.inputs, e, e.side, { main: e.exit, card: e.land }, false)
  }
  for (const origin of origins) {
    const ex = real(origin) ? exitsFrom(rom, origin, screenHigh)?.find(x => x.dest === entry) : undefined // prettier-ignore
    const nb = ex ? buildL1Inputs(rom, origin, SWITCH_FLAGS_UNCLEARED) : undefined
    const e = nb?.ok ? edgeOf(rom, nb.inputs, ex!) : null
    if (!nb?.ok || !e) continue
    add(origin, nb.inputs, e, reverseSide(e.side), { main: e.land, card: e.exit }, true)
  }
  return { ok: true, entry: { slot: entry, widthPx: main.w, heightPx: main.h }, cards: [...cards.values()], notes } // prettier-ignore
}
