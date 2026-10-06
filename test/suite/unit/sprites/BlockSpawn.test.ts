/**
 * The item block spawn on the core (#566): the game's own GenSpriteFromBlk runs in place of the
 * loader's INIT, so the sprite's status, timers and cells come from the ROM's routine. Synthetic cart only:
 * its routine is ours (shape bytes of the real one, our own body), so CI proves the runner's seeding,
 * its refusals and that nothing here is a constant.
 */
import { describe, expect, it } from 'vitest'
import { runOnce, RAM, type SpawnRun } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { resolveBlockSpawn } from '../../../../src/rom/sprites/interp/SpriteDispatch'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const SLOT = 11
const seed = withSeed({ slot: SLOT, sprite: { x: 0x80, y: 0x80 } }, SPRITE_SEED)
const spawn = (content: number): SpawnRun => ({ inputs: { 0x05: content } })

/** The cells after the spawn and the first frame: status, $1540, $C2, sprite number, $1610 (INIT call count of id 13). */
function cells(content: number, o: SyntheticOptions = {}, s = seed) {
  const seen: number[] = []
  const m = runOnce(buildSyntheticRom(o), 0, s, {
    spawn: spawn(content),
    probe: (pass, w) => {
      if (pass === -1) seen.push(w[RAM.status + SLOT]!, w[0x1540 + SLOT]!, w[0xc2 + SLOT]!, w[RAM.spriteNumber + SLOT]!, w[0x1610 + SLOT]!) // prettier-ignore
    },
  })
  return { m, seen }
}

describe('the item block spawn', () => {
  it('takes the status, sprite number, 1540 and C2 from the routine, not from constants', () => {
    expect(cells(1).seen).toEqual([8, 0x37, 1, 5, 0])
    expect(cells(2).seen.slice(0, 4)).toEqual([9, 0x37, 1, 13])
    // Change what the routine writes and the cells follow: the timer is its own immediate.
    expect(cells(1, { spawnTimer: 0x5c }).seen[1]).toBe(0x5c)
  })

  it('does not run the sprite INIT: a status-9 sprite whose INIT counts its calls ran none', () => {
    const { m, seen } = cells(2)
    expect(m.refusal).toBeUndefined()
    expect(seen[4]).toBe(0) // id 13's INIT would have left 1 here
    expect(seen[0]).toBe(9) // and the egg-like status survives instead of becoming 8
  })

  it('draws the spawned sprite through its status handler, at its own position', () => {
    const { m } = cells(3)
    expect(m.refusal).toBeUndefined()
    expect(m.chosen).toBeDefined()
    expect(m.passes[m.chosen!]!.parts).toHaveLength(1)
  })

  it('reads its inputs from the seeded cells: another content index spawns another sprite', () => {
    expect(cells(3).seen.slice(0, 4)).toEqual([8, 0x37, 1, 0])
    expect(cells(1).seen[3]).not.toBe(cells(3).seen[3])
  })

  it('refuses a spawn routine that is not the shape it knows, with the reason', () => {
    for (const bad of ['head', 'status'] as const) {
      const m = cells(1, { badSpawn: bad }).m
      expect(m.refusal, bad).toMatch(/item block spawn routine does not/)
      expect(resolveBlockSpawn(buildSyntheticRom({ badSpawn: bad })).ok).toBe(false)
    }
    expect(resolveBlockSpawn(buildSyntheticRom())).toEqual({ ok: true, entry: 0x028905 })
  })

  it('refuses a spawn routine that exceeds the step budget', () => {
    expect(cells(1, { spawnLoop: true }).m.refusal).toMatch(/step budget/)
  })

  it('refuses when the routine puts the sprite in another slot than the seed names', () => {
    const m = runOnce(buildSyntheticRom(), 0, withSeed({ slot: 3 }, seed), { spawn: spawn(1) })
    // The routine takes slot 11, the seed's slot 3 stays empty after being emptied.
    expect(m.refusal).toMatch(/did not put the sprite in slot 3/)
  })
})
