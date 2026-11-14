/**
 * The saved Objects found on a map (#1237), read-only.
 *
 * Pure, so it is unit tested in CI; `ProjectServiceImpl` only resolves the working copy and delegates.
 * Separate from `mapScreen`, so a map's cold open pays nothing for it. The expensive part (the map
 * expanded with its owner grid and per-piece footprint) is kept per working-copy bytes, which an edit
 * replaces; recognition itself reruns on every call, so a definition changed on disk is seen at once.
 */
import { SWITCH_FLAGS_UNCLEARED } from '../../../../src/rom/ObjectExpander'
import { TILESET_COUNT, map16TileCapacity } from '../../../../src/rom/Map16'
import { describeObjects } from '../../../../src/rom/objects/Describe'
import {
  objectsRefusal,
  readObjectInputs,
  slopeClassOf,
  type ObjectInputs,
} from '../../../../src/rom/objects/ObjectInputs'
import { recognizeObjects } from '../../../../src/rom/objects/Recognize'
import { readObjectDefinitions } from '../../../../src/project/ObjectDefinitionsStandIn'
import type { MapObjectsResult } from '../common/project-protocol'
import { L1ModelCache, unreadable } from './map-screen'

const NO_FLAGS = { yellow: false, green: false, red: false, blue: false }
const NOT_FOUND = "Objects can't be found on this map: its data could not be read."
/** Expanded maps kept per working-copy bytes: a whole ROM's maps are not. */
const MAPS_PER_BYTES = 4

/**
 * Values kept per working-copy bytes and map slot. The key is the array itself: the working copy hands out a new
 * array for every change (an edit, its undo, a redo), so a value for old bytes is never served for new ones; a
 * map slot has at most `MAPS_PER_BYTES` values kept for one array.
 */
export class PerBytes<T> {
  private readonly byBytes = new WeakMap<Uint8Array, Map<number, T>>()

  /** The value for this array and slot, built (and kept) on first ask. */
  get(bytes: Uint8Array, index: number, build: () => T): T {
    let maps = this.byBytes.get(bytes)
    if (!maps) this.byBytes.set(bytes, (maps = new Map()))
    if (maps.has(index)) return maps.get(index)!
    const value = build()
    if (maps.size >= MAPS_PER_BYTES) maps.delete(maps.keys().next().value!)
    maps.set(index, value)
    return value
  }
}

const kept = new PerBytes<ObjectInputs>()

/** Finds the project's Objects on one map of the working copy. */
export function mapObjects(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  manifestPath: string,
  index: number,
): MapObjectsResult {
  try {
    const rom = cache.romOf(bytes, romPath)
    // First, so a hack with its own Map16 per map is told why, not that its data could not be read.
    const why = objectsRefusal(rom.rom)
    if (why) return { status: 'unavailable', reason: why }
    // The map must be one the view can draw: its refusals (boss arenas, unreadable data) are ours too.
    const built = cache.get(bytes, romPath, index, NO_FLAGS)
    if (!built.ok) return unreadable(built.detail ?? built.reason, NOT_FOUND)
    const inputs = kept.get(bytes, index, () =>
      readObjectInputs(rom, index, SWITCH_FLAGS_UNCLEARED),
    )
    // The refusal is already plain words and says why Objects cannot be found here.
    if (!inputs.ok) return { status: 'unavailable', reason: inputs.reason }
    const capacity = map16TileCapacity(rom.rom)
    const { definitions, skipped } = readObjectDefinitions(manifestPath, {
      tilesetCount: TILESET_COUNT,
      tileCount: 'count' in capacity ? capacity.count : null,
    })
    const slopeOf = slopeClassOf(rom.rom, inputs.tileset)
    const objects = describeObjects(recognizeObjects(inputs, definitions), slopeOf)
    return { status: 'ok', objects, skipped }
  } catch (err) {
    return unreadable((err as Error).message, NOT_FOUND)
  }
}
