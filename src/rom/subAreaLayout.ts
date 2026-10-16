/**
 * SPIKE (#946, not for merge): where each sub area of an entry map sits when
 * the map and its sub areas are drawn on one canvas, offsets in pixels from the
 * entry map's top-left.
 *
 * Route entrance (D66 call 1, #945, NOT built): computed here as "the first
 * screen exit, in screen order, that reaches the slot". Depth 1 only.
 *
 * Exit point: a screen exit belongs to a whole screen, so the pipe or door is
 * found by scanning that screen's Layer 1 for enterable tiles. Tile ids, all
 * Map16 page 1 unless noted:
 *  - $137/$138 pipe cap. The player test is `tile - $37 < 2` (bank_00.asm:
 *    13205-13216). bank_0D.asm:2118-2186 lays them down: pipe type 1 starts
 *    with the $37/$38 cap and continues in $35/$36 body tiles, so the cap
 *    sits ABOVE its body (a down pipe); type 4 ends with the cap, so the cap
 *    sits BELOW its body (an up pipe). Direction is read from which side the
 *    body is on.
 *  - $13F side pipe cap (bank_00.asm:13177, `CPY #$3F`). Which side it opens
 *    to is not decoded; placed to the right.
 *  - $20 (page 0) door; its top half is $1F (bank_00.asm:12100-12118).
 * With none of them on the screen the landing entrance's action type picks the
 * side instead (DATA_05FE00 & 7, or DATA_05F200 bits 3-5 for a main entrance;
 * bank_05.asm:7155-7161, :7309-7322): 3 = emerges upward (a down pipe above),
 * 4 = emerges downward (an up pipe), 1/2 = out of a side pipe, 0 = walks out
 * (bank_00.asm:4987-5044). That placement is marked heuristic.
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
/** Pixels between the entry map and a sub area on the side it sits. */
export const GAP_PX = 32

export type SubAreaKind = 'below' | 'above' | 'beside'
export interface Point {
  x: number
  y: number
}

export interface SubAreaDto {
  slot: number
  fromScreen: number
  kind: SubAreaKind
  /** How the kind was chosen: the tile found, or a guess from the entrance action. */
  basis: 'tile' | 'heuristic'
  offsetX: number
  offsetY: number
  /** In the entry map's pixels: the pipe or door the player goes in by. */
  exitPx: Point
  /** In the sub area's own pixels: where the player lands. */
  landingPx: Point
  widthPx: number
  heightPx: number
  notes: string[]
}

export interface SubAreaLayout {
  entry: { slot: number; widthPx: number; heightPx: number }
  subAreas: SubAreaDto[]
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

interface Placed {
  kind: SubAreaKind
  exit: Point
  landing: Point
  w: number
  h: number
}

/**
 * The offset arithmetic, pure. below/above line the landing column up with the
 * exit column; beside lines the landing row up with the exit row. A sub area on
 * the same side that would overlap an earlier one is pushed further out.
 */
export function placeSubAreas(
  main: { w: number; h: number },
  subs: Placed[],
): Array<{ x: number; y: number; shifted: boolean }> {
  const out: Array<{ x: number; y: number; shifted: boolean }> = []
  const rects: Array<{ kind: SubAreaKind; x: number; y: number; w: number; h: number }> = []
  for (const s of subs) {
    let x = s.exit.x - s.landing.x
    let y = s.exit.y - s.landing.y
    if (s.kind === 'below') y = main.h + GAP_PX
    else if (s.kind === 'above') y = -(s.h + GAP_PX)
    else x = main.w + GAP_PX
    let shifted = false
    const hit = () =>
      rects.find(r => r.kind === s.kind && x < r.x + r.w && r.x < x + s.w && y < r.y + r.h && r.y < y + s.h) // prettier-ignore
    for (let r = hit(); r; r = hit()) {
      shifted = true
      if (s.kind === 'below') y = r.y + r.h + GAP_PX
      else if (s.kind === 'above') y = r.y - s.h - GAP_PX
      else x = r.x + r.w + GAP_PX
    }
    rects.push({ kind: s.kind, x, y, w: s.w, h: s.h })
    out.push({ x, y, shifted })
  }
  return out
}

interface Found {
  kind: SubAreaKind
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

const ACTION_KIND: Record<number, SubAreaKind> = { 0: 'beside', 1: 'beside', 2: 'beside', 3: 'below', 4: 'above' } // prettier-ignore

export function buildSubAreaLayout(rom: SmwRom, entry: number): SubAreaResult {
  const gate = startGate(rom.rom)
  if (gate) return fail(gate)
  if (!Number.isInteger(entry) || entry < 0 || entry >= LEVEL_COUNT) return fail('That map number does not exist.') // prettier-ignore
  const catalog = buildLevelCatalog(rom)
  if (!catalog.entries[entry]?.isReal) return fail('No map is stored in this slot.')
  const raw = rom.getLevelRawData(entry)
  if (!raw) return fail('The level data of this map cannot be read.')
  const l1 = buildL1Inputs(rom, entry, SWITCH_FLAGS_UNCLEARED)
  if (!l1.ok) return fail(l1.reason)
  const model = l1.inputs
  const main = mapSizePx(model.isVertical, model.screenCount)

  const parsed = parseLevelObjects(raw, [])
  if (!parsed.terminated) return fail('The exit list of this map runs off its data, so it is not followed.') // prettier-ignore
  const exits = parsed.objects
    .filter(o => o.screenExitDest !== undefined)
    .sort((a, b) => a.screen - b.screen)
  const secondary = mapUsesSecondaryExits(exits)
  const screenHigh = readSubmapHigh(rom.rom, SCREEN_EXIT_HIGH_AT)
  if (typeof screenHigh === 'string') return fail(screenHigh)
  // The exit graph's own flag: bit 8 of the entry slot under the stock loader (SmwRom.buildLevelExitGraph).
  const high = entry >= 0x100 ? screenHigh << 8 : 0

  const notes: string[] = []
  const roots = deriveOverworldEntrances(rom).roots
  const parents = new Map<number, number[]>()
  if (roots) {
    const g = rom.buildLevelExitGraph(roots, STOCK_OVERWORLD_FINGERPRINTS.entry)
    if (g.unavailable) notes.push('Other levels that share a sub area could not be listed.')
    for (const [from, tos] of g.graph) for (const to of tos) parents.set(to, [...(parents.get(to) ?? []), from]) // prettier-ignore
  } else notes.push('Other levels that share a sub area could not be listed.')

  const seen = new Set<number>()
  const found: Array<Placed & { dto: Omit<SubAreaDto, 'offsetX' | 'offsetY'> }> = []
  for (const o of exits) {
    const rawByte = o.screenExitDest! & 0xff
    let dest: number
    let index: number | null = null
    if (secondary) {
      index = high | rawByte
      const low = rom.rom.readByte(DATA_05F800_ADDR + index)
      if (low === null) continue
      dest = high | low
    } else dest = high | rawByte
    if (dest === entry) {
      if (!notes.some(n => n.startsWith('An exit leads back'))) notes.push(`An exit leads back into this map (screen ${hex(o.screen)}); it is not drawn again.`) // prettier-ignore
      continue
    }
    if (seen.has(dest) || !catalog.entries[dest]?.isReal || isOverworldLevel(dest, roots)) continue
    seen.add(dest)
    const landing = index !== null ? readSecondaryEntrance(rom.rom, index, dest) : readMainEntrance(rom.rom, dest) // prettier-ignore
    const sub = buildL1Inputs(rom, dest, SWITCH_FLAGS_UNCLEARED)
    if (!landing || !sub.ok) {
      notes.push(`Sub area ${hex(dest, 3)} could not be read, so it is left out.`)
      continue
    }
    const size = mapSizePx(sub.inputs.isVertical, sub.inputs.screenCount)
    const dn: string[] = []
    const hit = findEnterable(model.grid, model.isVertical, o.screen)
    const act = actionType(rom.rom, index, dest)
    let kind: SubAreaKind
    let basis: SubAreaDto['basis'] = 'tile'
    let exit: Point
    if (hit) {
      kind = hit.kind
      exit = hit.at
      if (hit.count > 1) dn.push(`${hit.count} pipes or doors on screen ${hex(o.screen)}, aligned to the first.`) // prettier-ignore
      const want = act === null ? undefined : ACTION_KIND[act]
      if (want && want !== kind) dn.push(`The ${hit.tile} suggests ${kind} but the landing's action suggests ${want}.`) // prettier-ignore
    } else {
      basis = 'heuristic'
      kind = (act !== null && ACTION_KIND[act]) || 'below'
      const [sw, sh] = model.isVertical ? [SCREEN_W_VERT * 16, SCREEN_H_VERT * 16] : [SCREEN_W * 16, SCREEN_H * 16] // prettier-ignore
      exit = model.isVertical ? { x: sw / 2, y: o.screen * sh + sh / 2 } : { x: o.screen * sw + sw / 2, y: sh / 2 } // prettier-ignore
      dn.push(`No pipe or door tile on screen ${hex(o.screen)}; placed from the entrance action (${act ?? 'unknown'}) and aligned to the screen centre.`) // prettier-ignore
    }
    const sameScreen = exits.filter(e => e.screen === o.screen).length
    if (sameScreen > 1) dn.push(`${sameScreen} exits on screen ${hex(o.screen)} share one pipe or door here.`) // prettier-ignore
    const others = (parents.get(dest) ?? []).filter(p => p !== entry)
    if (others.length > 0) dn.push(`Also entered from ${others.map(p => hex(p, 3)).join(', ')}.`)
    const lp = { x: landing.x + 8, y: landing.y + 16 } // Mario's centre column and feet, from the entrance's top-left
    found.push({
      kind,
      exit,
      landing: lp,
      w: size.w,
      h: size.h,
      dto: { slot: dest, fromScreen: o.screen, kind, basis, exitPx: exit, landingPx: lp, widthPx: size.w, heightPx: size.h, notes: dn }, // prettier-ignore
    })
  }
  const spots = placeSubAreas(main, found)
  const subAreas = found.map((f, i) => {
    const s = spots[i]!
    const dto = { ...f.dto, offsetX: s.x, offsetY: s.y }
    if (s.shifted) dto.notes = [...dto.notes, 'Overlapped another sub area on the same side, so it was moved further out.'] // prettier-ignore
    return dto
  })
  return { ok: true, entry: { slot: entry, widthPx: main.w, heightPx: main.h }, subAreas, notes }
}
