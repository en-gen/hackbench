/**
 * Where the player first enters a map: its screen and pixel position, read
 * from the level-header entrance tables, for the Maps view to open on.
 *
 * Main entrance: CODE_05D8B7 reads DATA_05F000/F200/F400/F600 by slot
 * (bank_05.asm:7300-7395). Secondary entrance: DATA_05F800/FA00/FC00 by
 * `(submapFlag << 8) | byte` (bank_05.asm:7103-7161). The START is the first
 * entrance in play order: the main entrance of an entry map, else the entrance
 * the fewest screen-exit hops from an overworld tile reach. The reading ports
 * smw-mcp `get_level_entrances` (`initial_start`), whose entrance decode is
 * transcribed below, not called.
 *
 * Gate: the whole table reading assumes the stock loader. Lunar Magic JSLs
 * out of `$05D8B1` (99 of 99 corpus hacks, #543); the stock byte there is the
 * `BEQ` `$F0` (bank_05.asm:7224). Anything else is unavailable, never the
 * vanilla tables read as if they still applied.
 */
import type { RomFile } from './RomFile'
import { isOverworldLevel, type SmwRom } from './SmwRom'
import { parseLevelObjects } from './LevelParser'
import {
  deriveOverworldEntrances,
  STOCK_OVERWORLD_FINGERPRINTS,
  type OverworldFingerprints,
} from './OverworldEntrances'

const ENTRY_BEQ = 0x05d8b1
const BEQ = 0xf0

const F000 = 0x05f000 // Y index (low nibble)
const F200 = 0x05f200 // X index (low 3 bits)
const F600 = 0x05f600 // screen (low 5 bits) and ScreenMode (bits 5-6)
const F800 = 0x05f800 // secondary entrance: destination slot, low byte
const FA00 = 0x05fa00 // secondary entrance: Y index (low nibble)
const FC00 = 0x05fc00 // secondary entrance: X index (top 3 bits), screen (low 5)
const Y_LO = 0x05d730
const Y_HI = 0x05d740
const X_LO = 0x05d750
const X_HI = 0x05d758
const SLOTS = 0x200

/** A player position and the screen it falls on. */
export interface Entrance {
  screen: number
  x: number
  y: number
  vertical: boolean
}

export type LevelStart =
  | (Entrance & { ok: true; kind: 'main' | 'secondary'; hops: number })
  | { ok: false; reason: string }

const hex = (n: number): string => `$${n.toString(16).toUpperCase().padStart(6, '0')}`
const byte = (rom: RomFile, at: number): number => rom.readByte(at) ?? 0

/** The loader's tail for either entrance kind (bank_05.asm:7313-7316, 7382-7387). */
function position(
  rom: RomFile,
  vertical: boolean,
  yIdx: number,
  xIdx: number,
  scr: number,
): Entrance {
  const x = ((vertical ? byte(rom, X_HI + xIdx) : scr) << 8) | byte(rom, X_LO + xIdx)
  const y = ((vertical ? scr : byte(rom, Y_HI + yIdx)) << 8) | byte(rom, Y_LO + yIdx)
  return { x, y, screen: vertical ? y >> 8 : x >> 8, vertical }
}

/** ScreenMode bit 0 = vertical, from F600 bits 5-6 (bank_05.asm:7292-7299). */
const isVertical = (rom: RomFile, slot: number): boolean =>
  ((byte(rom, F600 + slot) >> 5) & 1) === 1

/** CODE_05D8B7 with UseSecondaryExit clear (bank_05.asm:7300-7395). */
export function readMainEntrance(rom: RomFile, slot: number): Entrance {
  return position(
    rom,
    isVertical(rom, slot),
    byte(rom, F000 + slot) & 0x0f,
    byte(rom, F200 + slot) & 0x07,
    byte(rom, F600 + slot) & 0x1f,
  )
}

/** Secondary entrance `index` arriving in `dest` (bank_05.asm:7113-7161, then 7338-7395). */
export function readSecondaryEntrance(rom: RomFile, index: number, dest: number): Entrance {
  const c = byte(rom, FC00 + index)
  return position(rom, isVertical(rom, dest), byte(rom, FA00 + index) & 0x0f, c >> 5, c & 0x1f)
}

/** The stock-opcode gate; null when the loader is the one these tables belong to. */
export function startGate(rom: RomFile): string | null {
  const b = rom.readByte(ENTRY_BEQ)
  if (b === BEQ) return null
  const got = (b ?? 0).toString(16).toUpperCase().padStart(2, '0')
  return `${hex(ENTRY_BEQ)} holds $${got}, not the stock BEQ $F0, so this ROM's entrance loader is not the one the entrance tables belong to (bank_05.asm:7224).`
}

interface Found {
  key: number[]
  kind: 'main' | 'secondary'
  hops: number
  at: () => Entrance
}

/**
 * Where Mario first enters `mapIndex` in play, or why that is not known.
 * @param fingerprints Replaces the stock overworld fingerprints; for a synthetic ROM.
 */
export function readLevelStart(
  rom: SmwRom,
  mapIndex: number,
  fingerprints: OverworldFingerprints = STOCK_OVERWORLD_FINGERPRINTS,
): LevelStart {
  const gate = startGate(rom.rom)
  if (gate) return { ok: false, reason: gate }
  if (!Number.isInteger(mapIndex) || mapIndex < 0 || mapIndex >= SLOTS) {
    return { ok: false, reason: `Slot ${mapIndex} is outside the pointer table.` }
  }

  const entrances = deriveOverworldEntrances(rom, undefined, fingerprints)
  const { roots } = entrances
  if (!roots) return { ok: false, reason: entrances.notes[0] ?? 'The overworld could not be read.' }
  if (isOverworldLevel(mapIndex, roots)) {
    return { ...readMainEntrance(rom.rom, mapIndex), ok: true, kind: 'main', hops: 0 }
  }

  const { graph, unavailable } = rom.buildLevelExitGraph(roots, fingerprints.entry)
  if (unavailable) return { ok: false, reason: unavailable }

  // Screen-exit hops from an overworld tile, breadth first over the exit graph.
  const hops = new Map<number, number>()
  const queue = [...graph.keys()].filter(s => isOverworldLevel(s, roots))
  for (const s of queue) hops.set(s, 0)
  for (let i = 0; i < queue.length; i++) {
    for (const d of graph.get(queue[i]!) ?? []) {
      if (hops.has(d)) continue
      hops.set(d, hops.get(queue[i]!)! + 1)
      queue.push(d)
    }
  }

  // Every exit object that lands here, as the entrance it indexes. A primary
  // exit's byte is the destination's low byte, so it enters the MAIN
  // entrance; a secondary exit's byte indexes DATA_05F800 with the submap
  // flag, which is bit 8 of the destination (bank_05.asm:7103-7118).
  const found: Found[] = []
  for (const [from, dests] of graph) {
    const h = hops.get(from)
    const raw = h === undefined || !dests.includes(mapIndex) ? null : rom.getLevelRawData(from)
    if (h === undefined || !raw) continue
    for (const o of parseLevelObjects(raw, []).objects) {
      if (o.screenExitDest === undefined) continue
      const low = o.screenExitDest & 0xff
      if (o.screenExitIsSecondary) {
        const index = (mapIndex & 0x100) | low
        if (byte(rom.rom, F800 + index) !== (mapIndex & 0xff)) continue
        const at = (): Entrance => readSecondaryEntrance(rom.rom, index, mapIndex)
        found.push({ key: [h + 1, from, 1, index], kind: 'secondary', hops: h + 1, at })
      } else if (low === (mapIndex & 0xff)) {
        const at = (): Entrance => readMainEntrance(rom.rom, mapIndex)
        found.push({ key: [h + 1, from, 0, 0], kind: 'main', hops: h + 1, at })
      }
    }
  }
  if (found.length === 0) {
    return { ok: false, reason: 'No overworld tile or screen exit leads into this map.' }
  }
  // Ties: the nearer parent, a main entrance before a secondary one, then the lower index.
  const cmp = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!).find(d => d !== 0) ?? 0
  const first = found.sort((a, b) => cmp(a.key, b.key))[0]!
  return { ...first.at(), ok: true, kind: first.kind, hops: first.hops }
}
