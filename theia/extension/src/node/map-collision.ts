/**
 * The map tab's collision overlay (#435): floors, ceilings, slopes and walls
 * from SMW's own block code, run on the 65816 core (src/rom/collision/).
 *
 * Pure, so it is unit tested in CI; `ProjectServiceImpl` only resolves the
 * working copy and delegates here. Collision is a property of the Map16 tile
 * (id, tileset, game state), so the probe results are cached per working-copy
 * bytes and shared by every map of that tileset; the composed reply is cached
 * per map. An edit hands out new bytes, which is the whole invalidation (a
 * patched block routine changes every result).
 *
 * A map the probe cannot run is `unavailable` with the reason (the ROM's level
 * loader refused it, a vertical level): never an empty layer. Horizontal
 * levels only, vanilla block code only (#435's settled scope).
 */
import { RomFile } from '../../../../src/rom/RomFile'
import { collisionLayer, ProbeCache, SUPERSEDED } from '../../../../src/rom/collision/MapCollision'
import type { MapCollisionResult } from '../common/project-protocol'
import { L1ModelCache } from './map-screen'

type Reply = Exclude<MapCollisionResult, { status: 'rom-not-located' }>
const TILE = 16
const NO_FLAGS = { yellow: false, green: false, red: false, blue: false }
/** Replies kept per working-copy bytes: a whole ROM's maps are not. */
const REPLIES_PER_BYTES = 8

interface PerBytes {
  probes: ProbeCache
  /** A map's reply, or the promise of it while it is being probed (a second request shares it). */
  replies: Map<number, Reply | Promise<Reply>>
}
const byBytes = new WeakMap<Uint8Array, PerBytes>()

const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve))

/**
 * A map's collision from the working copy's bytes, over the same model as its
 * screens. `cancelled` says the bytes are no longer the working copy's: the
 * probe stops between tiles and its answer is dropped.
 */
export async function mapCollision(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
  cancelled: () => boolean = () => false,
): Promise<Reply> {
  let entry = byBytes.get(bytes)
  if (!entry) byBytes.set(bytes, (entry = { probes: new ProbeCache(), replies: new Map() }))
  const kept = entry.replies.get(index)
  if (kept) {
    // LRU: a hit moves the map to the newest end.
    entry.replies.delete(index)
    entry.replies.set(index, kept)
    return kept
  }
  const pending = compute(cache, entry.probes, bytes, romPath, index, cancelled)
  if (entry.replies.size >= REPLIES_PER_BYTES) {
    entry.replies.delete(entry.replies.keys().next().value!)
  }
  entry.replies.set(index, pending)
  const r = await pending
  // Only a computed answer is kept; an unavailable one may be a hiccup worth retrying.
  if (r.status !== 'ok' && entry.replies.get(index) === pending) entry.replies.delete(index)
  else if (entry.replies.get(index) === pending) entry.replies.set(index, r)
  return r
}

async function compute(
  cache: L1ModelCache,
  probes: ProbeCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
  cancelled: () => boolean,
): Promise<Reply> {
  // Collision does not depend on the palaces; any flags give the same grid.
  const built = cache.get(bytes, romPath, index, NO_FLAGS)
  if (!built.ok) return { status: 'unavailable', reason: built.reason }
  const m = built.inputs
  if (m.isVertical) {
    return { status: 'unavailable', reason: 'Collision is not shown for vertical levels yet' }
  }
  try {
    // A copy, as the model cache makes: the working copy's array is shared.
    const rom = RomFile.fromBytes(romPath, Buffer.from(bytes))
    const r = await collisionLayer(rom, index, m.header.objectTileset, m.grid, probes, {
      yieldTurn,
      cancelled,
    })
    if (!r.ok) {
      return r.reason === SUPERSEDED
        ? { status: 'stale' }
        : { status: 'unavailable', reason: r.reason }
    }
    return {
      status: 'ok',
      width: (m.grid[0]?.length ?? 0) * TILE,
      height: m.grid.length * TILE,
      lines: r.lines,
    }
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message }
  }
}
