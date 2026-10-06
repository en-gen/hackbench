/**
 * MapCollision.ts -- a map's collision lines from SMW's own block code
 * (en-gen/hackbench#435). Probes only the Map16 ids the map uses, once each per
 * tileset and game state, and composes them into lines. No shell imports.
 *
 * Collision is a property of the tile (id, tileset, game state), not of the
 * map, so results are cached by those three; the CALLER scopes the cache to
 * one working copy's bytes, which is the invalidation (an edit hands out new
 * bytes, and a patched block routine changes every result).
 */
import type { RomFile } from '../RomFile'
import { loadLevelState } from '../sprites/interp/LevelLoader'
import { compose, type CollisionLine } from './Compose'
import {
  calibrate,
  measureTile,
  probeAir,
  NEUTRAL,
  Probe,
  stateKey,
  type AirRuns,
  type Calibration,
  type ProbeState,
  type TileProbe,
} from './TileProbe'

/** Probe results for one ROM image, by tileset, state and tile id. */
export class ProbeCache {
  private readonly tiles = new Map<string, TileProbe>()
  private readonly preps = new Map<string, { cal: Calibration; air: AirRuns }>()
  private static key = (tileset: number, id: number, s: ProbeState) =>
    `${tileset}:${stateKey(s)}:${id}`

  get(tileset: number, id: number, s: ProbeState = NEUTRAL): TileProbe | undefined {
    return this.tiles.get(ProbeCache.key(tileset, id, s))
  }
  set(tileset: number, id: number, t: TileProbe, s: ProbeState = NEUTRAL): void {
    this.tiles.set(ProbeCache.key(tileset, id, s), t)
  }
  /** The calibration and the level-of-air runs that every tile of this tileset shares. */
  prep(tileset: number, s: ProbeState = NEUTRAL): { cal: Calibration; air: AirRuns } | undefined {
    return this.preps.get(`${tileset}:${stateKey(s)}`)
  }
  setPrep(tileset: number, p: { cal: Calibration; air: AirRuns }, s: ProbeState = NEUTRAL): void {
    this.preps.set(`${tileset}:${stateKey(s)}`, p)
  }
}

/** The reason of a run stopped by `cancelled`: not a refusal, only an answer nobody wants any more. */
export const SUPERSEDED = 'superseded'

/**
 * Why the probe cannot run on this ROM for `level`, or null: the ROM's own level loader refusing is the
 * only ROM-dependent refusal, and it is found without probing a single tile.
 */
export function collisionRefusal(rom: RomFile, level: number): string | null {
  const l = loadLevelState(rom, level)
  return l.ok ? null : l.reason
}

export type CollisionLayer =
  | { ok: true; lines: CollisionLine[]; probed: number; steps: number }
  | { ok: false; reason: string }

export interface CollisionOptions {
  /** Awaited between tiles, so a long probe does not hold the event loop. */
  yieldTurn?: () => Promise<void>
  /** Checked between tiles; true abandons the run (the reply would be dropped anyway). */
  cancelled?: () => boolean
  /** A WRAM image already made, in place of the level loader's (a test seam). */
  wram?: Uint8Array
  /** The palaces and blue P-switch the map was drawn with; the probe runs in the same state. */
  state?: ProbeState
}

/**
 * The lines for `grid` (the map's Map16 ids, `grid[row][col]`) of `level`,
 * whose header says it is `tileset`. Refuses, with a reason, when the ROM's
 * level loader does; never returns an empty layer for a map it could not probe.
 */
export async function collisionLayer(
  rom: RomFile,
  level: number,
  tileset: number,
  grid: readonly (readonly number[])[],
  cache: ProbeCache,
  opts: CollisionOptions = {},
): Promise<CollisionLayer> {
  const state = opts.state ?? NEUTRAL
  const ids = [...new Set(grid.flat())].sort((a, b) => a - b)
  const todo = ids.filter(id => !cache.get(tileset, id, state))
  let probed = 0
  let steps = 0
  if (todo.length > 0) {
    let probe: Probe
    try {
      probe = new Probe(rom, level, opts.wram)
      probe.state = state
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
    if (probe.tileset !== tileset) {
      return { ok: false, reason: `the loaded level's tileset ${probe.tileset} differs from its header's ${tileset}` } // prettier-ignore
    }
    try {
      let prep = cache.prep(tileset, state)
      if (!prep)
        cache.setPrep(tileset, (prep = { cal: calibrate(probe), air: probeAir(probe) }), state)
      for (const id of todo) {
        if (opts.cancelled?.()) return { ok: false, reason: SUPERSEDED }
        cache.set(tileset, id, measureTile(probe, id, prep.cal, prep.air), state)
        probed++
        await opts.yieldTurn?.()
      }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
    steps = probe.steps
  }
  return { ok: true, lines: compose(grid, id => cache.get(tileset, id, state)), probed, steps }
}
