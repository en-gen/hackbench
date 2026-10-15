import type { MapEntrances, SmwRom } from './SmwRom'
import { deriveOverworldEntrances, type OverworldFingerprints } from './OverworldEntrances'

/**
 * How the game enters each map, from the exit graph; undefined when the graph is unavailable or
 * throws, so the callers read the main entrance, never a secondary one, instead of refusing the map.
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
