/**
 * SpawnedChildren.ts -- what FiveEeries.ts ($DE) and ThreePlatforms.ts ($E0) share: a run-once loader command whose
 * ROM spawner makes N children, each drawn by the ordinary sprite runner (the $E0 issue, #1015). Only the constants
 * (spawner, child sprite, count) and the per-sprite gate differ, so they stay in the two files with their citations.
 */
import type { RomFile } from '../../RomFile'
import { bytesAt } from './Guards'
import { SPAWN_SHORT, type RunOptions, type SpriteModel, type SpritePart } from './SpriteRunner'
import type { SpriteSeed } from './SpriteSeed'

/** The spawner a loader's `JSR` names (bank 2), so a repointed call runs the routine it names; `vanilla` when there is no JSR. */
export function jsrTarget(rom: RomFile, callAt: number, vanilla: number): number {
  const call = bytesAt(rom, callAt, 3)
  return call?.[0] === 0x20 ? 0x020000 | call[1]! | (call[2]! << 8) : vanilla
}

/** The entry as the loader hands it over: X in $00/$01, list index in $02, offset of its first byte in $03. */
export interface SpawnerEntry {
  x: number
  y: number
  index: number
  streamOffset: number
}

export interface SpawnedChild {
  /** The child's map position at the drawn pass, in px. */
  x: number
  y: number
  /** Relative to the entry. */
  parts: SpritePart[]
}

export interface SpawnedChildren {
  children: SpawnedChild[]
  /** Calls that found no free slot (the game's own shortfall). */
  missing: number
  /** First reason a spawned child did not draw; empty when all drew. */
  why: string
}

/**
 * Each child is its own run of the spawner (a fresh machine) with the nth spawned sprite drawn alone, so the children
 * do not add to each other's OAM. `passes` is how many MAIN passes each child runs; the first drawing one is shown.
 */
export function runSpawnedChildren(
  rom: RomFile,
  seed: SpriteSeed,
  e: SpawnerEntry,
  spec: { sprite: number; count: number; routine: number },
  passes: number,
  run: (rom: RomFile, id: number, seed: SpriteSeed, opts?: RunOptions) => SpriteModel,
): SpawnedChildren {
  const inputs = { 0x00: e.x & 0xff, 0x01: (e.x >> 8) & 0xff, 0x02: e.index, 0x03: e.streamOffset }
  const children: SpawnedChild[] = []
  let [missing, why] = [0, '']
  for (let n = 0; n < spec.count; n++) {
    const m = run(rom, spec.sprite, { ...seed, mainPasses: passes }, { spawn: { inputs, routine: spec.routine, nth: n } }) // prettier-ignore
    if (m.refusal?.startsWith(SPAWN_SHORT)) {
      missing++
      continue
    }
    const pass = m.chosen === undefined ? undefined : m.passes[m.chosen]
    if (!m.anchor || !pass) {
      why ||= m.refusal ?? m.emptyReason ?? 'drew no tile'
      continue
    }
    // The run's parts are relative to the child's own position when its passes began; re-anchor them to the entry.
    const [ox, oy] = [m.anchor.x - e.x, m.anchor.y - e.y]
    children.push({
      x: pass.pos.x,
      y: pass.pos.y,
      parts: pass.parts.map(p => ({ ...p, dx: p.dx + ox, dy: p.dy + oy })),
    })
  }
  return { children, missing, why }
}
