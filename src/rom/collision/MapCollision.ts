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
import { compose, type CollisionLine } from './Compose'
import {
  calibrate,
  measureTile,
  probeAir,
  PROBE_STATE,
  Probe,
  type AirRuns,
  type Calibration,
  type TileProbe,
} from './TileProbe'

/** Probe results for one ROM image, by tileset, state and tile id. */
export class ProbeCache {
  private readonly tiles = new Map<string, TileProbe>()
  private readonly preps = new Map<string, { cal: Calibration; air: AirRuns }>()
  private static key = (tileset: number, id: number) => `${tileset}:${PROBE_STATE}:${id}`

  get(tileset: number, id: number): TileProbe | undefined {
    return this.tiles.get(ProbeCache.key(tileset, id))
  }
  set(tileset: number, id: number, t: TileProbe): void {
    this.tiles.set(ProbeCache.key(tileset, id), t)
  }
  /** The calibration and the level-of-air runs that every tile of this tileset shares. */
  prep(tileset: number): { cal: Calibration; air: AirRuns } | undefined {
    return this.preps.get(`${tileset}:${PROBE_STATE}`)
  }
  setPrep(tileset: number, p: { cal: Calibration; air: AirRuns }): void {
    this.preps.set(`${tileset}:${PROBE_STATE}`, p)
  }
}

/** The reason of a run stopped by `cancelled`: not a refusal, only an answer nobody wants any more. */
export const SUPERSEDED = 'superseded'

export type CollisionLayer =
  | { ok: true; lines: CollisionLine[]; probed: number; steps: number }
  | { ok: false; reason: string }

export interface CollisionOptions {
  /** Awaited between tiles, so a long probe does not hold the event loop. */
  yieldTurn?: () => Promise<void>
  /** Checked between tiles; true abandons the run (the reply would be dropped anyway). */
  cancelled?: () => boolean
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
  const ids = [...new Set(grid.flat())].sort((a, b) => a - b)
  const todo = ids.filter(id => !cache.get(tileset, id))
  let probed = 0
  let steps = 0
  if (todo.length > 0) {
    let probe: Probe
    try {
      probe = new Probe(rom, level)
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
    if (probe.tileset !== tileset) {
      return { ok: false, reason: `the loaded level's tileset ${probe.tileset} differs from its header's ${tileset}` } // prettier-ignore
    }
    try {
      let prep = cache.prep(tileset)
      if (!prep) cache.setPrep(tileset, (prep = { cal: calibrate(probe), air: probeAir(probe) }))
      for (const id of todo) {
        if (opts.cancelled?.()) return { ok: false, reason: SUPERSEDED }
        cache.set(tileset, id, measureTile(probe, id, prep.cal, prep.air))
        probed++
        await opts.yieldTurn?.()
      }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
    steps = probe.steps
  }
  return { ok: true, lines: compose(grid, id => cache.get(tileset, id)), probed, steps }
}
