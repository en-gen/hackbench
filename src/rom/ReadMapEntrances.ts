import type { MapEntrances, SmwRom } from './SmwRom'
import { deriveOverworldEntrances, type OverworldFingerprints } from './OverworldEntrances'

/**
 * How the game enters each map, from the exit graph; undefined when the graph is unavailable or
 * throws, so the callers read the primary entrance, never a secondary one, instead of refusing the map.
 * `fingerprints` replaces the stock ones; for a synthetic ROM.
 */
export function readMapEntrances(
  rom: SmwRom,
  fingerprints?: OverworldFingerprints,
): ReadonlyMap<number, MapEntrances> | undefined {
  try {
    const roots = deriveOverworldEntrances(rom, undefined, fingerprints).roots
    return rom.buildLevelExitGraph(roots, fingerprints?.entry).entrances
  } catch {
    return undefined
  }
}

/**
 * One map's entrances from the graph. A graph that exists but never reached the map gives an
 * empty record with no route, so the chooser falls back and says so (#945); no graph at all
 * (undefined, a hooked hack) stays undefined: primary, with its own reason elsewhere.
 */
export function entrancesOfMap(
  graph: ReadonlyMap<number, MapEntrances> | undefined,
  index: number,
): MapEntrances | undefined {
  return graph && (graph.get(index) ?? { overworld: false, primary: false, secondary: [] })
}
