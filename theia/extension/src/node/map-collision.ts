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
import {
  changedRanges,
  collisionLayer,
  collisionRefusal,
  ProbeCache,
  SUPERSEDED,
} from '../../../../src/rom/collision/MapCollision'
import { stateKey, type ProbeState } from '../../../../src/rom/collision/TileProbe'
import type {
  MapCollisionCheckResult,
  MapCollisionResult,
  SwitchFlagsDto,
  SwitchStateDto,
} from '../common/project-protocol'
import { L1ModelCache } from './map-screen'

type Reply = Exclude<MapCollisionResult, { status: 'rom-not-located' }>
const TILE = 16
const NO_FLAGS = { yellow: false, green: false, red: false, blue: false }
/** Replies kept per working-copy bytes: a whole ROM's maps are not. */
const REPLIES_PER_BYTES = 8

interface PerBytes {
  probes: ProbeCache
  /** Finished ok replies, least recently used first. */
  replies: Map<string, Reply>
  /** Replies being probed (a second request for the same map and state shares one). */
  inflight: Map<string, Promise<Reply>>
  /** The newest state asked for per map: an older probe of that map stops when it is no longer this. */
  latest: Map<number, string>
}

/** The state a probe runs in: the view's palaces and its BLUE P-switch (silver is not modelled). */
export const probeStateOf = (flags: SwitchFlagsDto, switches: SwitchStateDto): ProbeState => ({
  flags,
  bluePs: switches.blue,
})
const byBytes = new WeakMap<Uint8Array, PerBytes>()
/** The working-copy bytes last asked about per ROM path: an edit's new bytes inherit its probe results. */
const lastByPath = new Map<string, Uint8Array>()

const VERTICAL = 'Collision is not shown for vertical levels yet'

/**
 * Whether `mapCollision` can run for this map, without running it: the level's shape and the ROM's own
 * level loader. No tile is probed, so the view can ask on every map open and keep the toggle's state honest.
 */
export function mapCollisionCheck(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
): MapCollisionCheckResult {
  const built = cache.get(bytes, romPath, index, NO_FLAGS)
  if (!built.ok) return { status: 'unavailable', reason: built.reason }
  if (built.inputs.isVertical) return { status: 'unavailable', reason: VERTICAL }
  try {
    const why = collisionRefusal(RomFile.fromBytes(romPath, Buffer.from(bytes)), index)
    return why === null ? { status: 'available' } : { status: 'unavailable', reason: why }
  } catch (err) {
    return { status: 'unavailable', reason: (err as Error).message }
  }
}

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
  state: ProbeState,
  cancelled: () => boolean = () => false,
  layer: typeof collisionLayer = collisionLayer,
): Promise<Reply> {
  const key = `${index}:${stateKey(state)}`
  let entry = byBytes.get(bytes)
  if (!entry) {
    // An edit hands out new bytes, but only what its probes READ matters: carry the cache over, owing the
    // changed ranges, and let the next probe of each tileset drop just the entries those bytes touch.
    const prev = lastByPath.get(romPath)
    const before = prev && prev !== bytes ? byBytes.get(prev) : undefined
    const probes = before ? before.probes.migrate(changedRanges(prev!, bytes)) : new ProbeCache()
    entry = { probes, replies: new Map(), inflight: new Map(), latest: new Map() }
    byBytes.set(bytes, entry)
  }
  lastByPath.set(romPath, bytes)
  const kept = entry.replies.get(key)
  if (kept) {
    // LRU: a hit moves the map to the newest end.
    entry.replies.delete(key)
    entry.replies.set(key, kept)
    return kept
  }
  // The newest state asked for this map wins: an older probe of it stops at its next tile, and is not shared.
  const old = entry.latest.get(index)
  if (old !== undefined && old !== key) entry.inflight.delete(old)
  entry.latest.set(index, key)
  const shared = entry.inflight.get(key)
  if (shared) return shared
  const live = entry
  const pending = compute(cache, live.probes, bytes, romPath, index, state, () => cancelled() || live.latest.get(index) !== key, layer) // prettier-ignore
  live.inflight.set(key, pending)
  const r = await pending
  if (live.inflight.get(key) === pending) live.inflight.delete(key)
  // Only a computed answer is kept; an unavailable one may be a hiccup worth retrying.
  if (r.status === 'ok') {
    if (live.replies.size >= REPLIES_PER_BYTES)
      live.replies.delete(live.replies.keys().next().value!)
    live.replies.set(key, r)
  }
  return r
}

async function compute(
  cache: L1ModelCache,
  probes: ProbeCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
  state: ProbeState,
  cancelled: () => boolean,
  layer: typeof collisionLayer,
): Promise<Reply> {
  // The grid is drawn with the view's palaces, and the probe runs in the same state (silver P-switch is not modelled).
  const built = cache.get(bytes, romPath, index, state.flags)
  if (!built.ok) return { status: 'unavailable', reason: built.reason }
  const m = built.inputs
  if (m.isVertical) {
    return { status: 'unavailable', reason: VERTICAL }
  }
  try {
    // A copy, as the model cache makes: the working copy's array is shared.
    const rom = RomFile.fromBytes(romPath, Buffer.from(bytes))
    const r = await layer(rom, index, m.header.objectTileset, m.grid, probes, {
      yieldTurn,
      cancelled,
      state,
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
