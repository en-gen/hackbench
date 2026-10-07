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
  type AirRuns,
  type Calibration,
  type Deps,
  type ProbeState,
  type TileProbe,
} from './TileProbe'

/**
 * What a probed tile depends on, besides its tileset and id: the blue P-switch, not the palaces. On vanilla
 * the block code reads SwitchBlockFlags only in the big palace switch (SMWDisX bank_00.asm:12508), whose two
 * branches give the same collision, so a palace toggle changes the GRID (and so the composed reply, which
 * keys on the full state) but no tile's result. A hack whose own blocks read $1F27-$1F2A needs the palace
 * bits back in this key. The probe's WRAM still gets them either way.
 */
const probeKey = (s: ProbeState): string => String(+s.bluePs)

type Prep = { cal: Calibration; air: AirRuns; deps?: Deps }
type Entry = { t: TileProbe; deps?: Deps }

/** True when two sorted flat `[start, end)` range lists share a byte. */
export function rangesIntersect(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i + 1]! <= b[j]!) i += 2
    else if (b[j + 1]! <= a[i]!) j += 2
    else return true
  }
  return false
}

/** The byte ranges (flat `[start, end)`) where two images differ; a length change is everything. */
export function changedRanges(a: Uint8Array, b: Uint8Array): number[] {
  if (a.length !== b.length) return [0, Math.max(a.length, b.length)]
  const out: number[] = []
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if (out.length && out[out.length - 1] === i) out[out.length - 1] = i + 1
    else out.push(i, i + 1)
  }
  return out
}

/**
 * Probe results for one ROM image, by tileset, P-switch and tile id, each with what it read (`Deps`). An edit
 * does not empty it: `migrate` carries the entries to the new bytes marked for checking, and `validate` drops
 * only those whose ROM reads meet the changed ranges, or whose seed-WRAM reads see another value in the seed
 * now loaded. Tiles are checked lazily, per tileset, when a map of that tileset is next asked for.
 */
export class ProbeCache {
  private readonly tiles = new Map<string, Entry>()
  private readonly preps = new Map<string, Prep>()
  /** Changed ranges not yet checked against a tileset's entries. */
  private pending = new Map<number, number[]>()
  private static key = (tileset: number, id: number, s: ProbeState) =>
    `${tileset}:${probeKey(s)}:${id}`

  get(tileset: number, id: number, s: ProbeState = NEUTRAL): TileProbe | undefined {
    return this.tiles.get(ProbeCache.key(tileset, id, s))?.t
  }
  set(tileset: number, id: number, t: TileProbe, s: ProbeState = NEUTRAL, deps?: Deps): void {
    this.tiles.set(ProbeCache.key(tileset, id, s), { t, deps })
  }
  /** The calibration and the level-of-air runs that every tile of this tileset shares. */
  prep(tileset: number, s: ProbeState = NEUTRAL): Prep | undefined {
    return this.preps.get(`${tileset}:${probeKey(s)}`)
  }
  setPrep(tileset: number, p: Prep, s: ProbeState = NEUTRAL): void {
    this.preps.set(`${tileset}:${probeKey(s)}`, p)
  }

  /** A cache for the edited bytes: every entry kept, the changed ranges owed to each tileset's check. */
  migrate(changed: readonly number[]): ProbeCache {
    const next = new ProbeCache()
    for (const [k, v] of this.tiles) next.tiles.set(k, v)
    for (const [k, v] of this.preps) next.preps.set(k, v)
    const tilesets = new Set([...this.preps.keys()].map(k => Number(k.split(':')[0])))
    for (const t of tilesets) {
      const owed = [...(this.pending.get(t) ?? []), ...changed]
      // Merge by sorting the pairs: owed lists are short.
      const pairs: [number, number][] = []
      for (let i = 0; i < owed.length; i += 2) pairs.push([owed[i]!, owed[i + 1]!])
      pairs.sort((a, b) => a[0] - b[0])
      const flat: number[] = []
      for (const [a, b] of pairs) {
        if (flat.length && a <= flat[flat.length - 1]!)
          flat[flat.length - 1] = Math.max(flat[flat.length - 1]!, b) // prettier-ignore
        else flat.push(a, b)
      }
      next.pending.set(t, flat)
    }
    return next
  }

  stale(tileset: number): boolean {
    return (this.pending.get(tileset)?.length ?? 0) > 0
  }

  /** Drops the tileset's entries the edits touched; `probe` is the seed now loaded. Returns how many tiles went. */
  validate(tileset: number, probe: Probe): number {
    const owed = this.pending.get(tileset) ?? []
    this.pending.delete(tileset)
    const changed = (d: Deps | undefined) =>
      !!d && (rangesIntersect(d.rom, owed) || d.wram.some(([o, v]) => probe.seed(o) !== v))
    let dropped = 0
    for (const [k, p] of [...this.preps]) {
      if (!k.startsWith(`${tileset}:`)) continue
      const bad = changed(p.deps)
      if (bad) this.preps.delete(k)
      for (const [tk, e] of [...this.tiles]) {
        if (!tk.startsWith(`${k}:`)) continue
        if (bad || changed(e.deps)) {
          this.tiles.delete(tk)
          dropped++
        }
      }
    }
    return dropped
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
  | { ok: true; lines: CollisionLine[]; probed: number; dropped: number; steps: number }
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
  const open = (): Probe | string => {
    try {
      const p = new Probe(rom, level, opts.wram)
      p.state = state
      return p.tileset === tileset ? p : `the loaded level's tileset ${p.tileset} differs from its header's ${tileset}` // prettier-ignore
    } catch (err) {
      return (err as Error).message
    }
  }
  let probe: Probe | undefined
  let dropped = 0
  if (cache.stale(tileset)) {
    const p = open()
    if (typeof p === 'string') return { ok: false, reason: p }
    dropped = cache.validate(tileset, (probe = p))
  }
  const ids = [...new Set(grid.flat())].sort((a, b) => a - b)
  const todo = ids.filter(id => !cache.get(tileset, id, state))
  let probed = 0
  let steps = 0
  if (todo.length > 0) {
    if (!probe) {
      const p = open()
      if (typeof p === 'string') return { ok: false, reason: p }
      probe = p
    }
    try {
      let prep = cache.prep(tileset, state)
      if (!prep) {
        probe.startDeps()
        const cal = calibrate(probe)
        const air = probeAir(probe)
        cache.setPrep(tileset, (prep = { cal, air, deps: probe.takeDeps() }), state)
      }
      for (const id of todo) {
        if (opts.cancelled?.()) return { ok: false, reason: SUPERSEDED }
        probe.startDeps()
        const t = measureTile(probe, id, prep.cal, prep.air)
        cache.set(tileset, id, t, state, probe.takeDeps())
        probed++
        await opts.yieldTurn?.()
      }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
    steps = probe.steps
  }
  return {
    ok: true,
    lines: compose(grid, id => cache.get(tileset, id, state)),
    probed,
    dropped,
    steps,
  }
}
