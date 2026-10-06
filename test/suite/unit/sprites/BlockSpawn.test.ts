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
import { flip } from '../../support/syntheticRom'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const seed = withSeed({ slot: 3, sprite: { x: 0x80, y: 0x80 } }, SPRITE_SEED)
const spawn = (content: number): SpawnRun => ({ inputs: { 0x05: content } })

/** The cells after the spawn and the first frame: status, $1540, $C2, sprite number, $1610 (INIT call count of id 13). */
function cells(content: number, o: SyntheticOptions = {}, s = seed) {
  const seen: number[] = []
  const m = runOnce(buildSyntheticRom(o), 0, s, {
    spawn: spawn(content),
    probe: (pass, w) => {
      // Wherever the game put the sprite: the one slot with a status.
      const slot = Array.from({ length: 12 }, (_, i) => i).find(i => w[RAM.status + i])!
      if (pass === -1) seen.push(w[RAM.status + slot]!, w[0x1540 + slot]!, w[0xc2 + slot]!, w[RAM.spriteNumber + slot]!, w[0x1610 + slot]!, slot) // prettier-ignore
    },
  })
  return { m, seen }
}

describe('the item block spawn', () => {
  it('takes the status, sprite number, 1540 and C2 from the routine, not from constants', () => {
    expect(cells(1).seen).toEqual([8, 0x37, 1, 5, 0, 11])
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
      expect(m.refusal, bad).toMatch(/item block spawn does not/)
      expect(resolveBlockSpawn(buildSyntheticRom({ badSpawn: bad })).ok).toBe(false)
    }
    expect(resolveBlockSpawn(buildSyntheticRom())).toEqual({ ok: true, entry: 0x0288dc })
  })

  it('refuses a spawn routine that exceeds the step budget', () => {
    expect(cells(1, { spawnLoop: true }).m.refusal).toMatch(/step budget/)
  })

  it('lets the game pick the slot: the dispatcher takes FindFreeSprSlot for the egg-like index and the countdown otherwise', () => {
    expect(cells(12).seen.slice(3)).toEqual([13, 0, 7]) // content 12: FindFreeSprSlot answered slot 7
    expect(cells(1).seen[5]).toBe(11) // any other: the first free slot from $0B
    // And the run follows it: the sprite is drawn from slot 7's OAM entries, not the seed's slot 3.
    expect(cells(12).m.refusal).toBeUndefined()
  })

  it('refuses a dispatcher that is not the shape it knows', () => {
    expect(cells(1, { badSpawn: 'dispatch' }).m.refusal).toMatch(/dispatcher is not the shape/)
  })

  it('refuses when the game spawns nothing', () => {
    // Content 0 has status 0 in the table, so the routine leaves every slot empty.
    expect(cells(0).m.refusal).toMatch(/found no free slot and spawned nothing/)
  })
})

describe('the dispatcher gate refuses a single changed byte', () => {
  const ENTRY = 0x0288dc

  it('refuses a flipped first opcode, with the reason', () => {
    const rom = buildSyntheticRom()
    flip(rom, ENTRY) // LDY _5 becomes another instruction
    const r = resolveBlockSpawn(rom)
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.reason).toMatch(/dispatcher is not the shape/)
    expect(runOnce(rom, 0, seed, { spawn: spawn(1) }).refusal).toMatch(
      /dispatcher is not the shape/,
    )
  })

  it('refuses a branch displacement that lands somewhere else, at offsets 13 and 39 and every other branch', () => {
    for (const at of [5, 13, 17, 21, 26, 28, 32, 39]) {
      const rom = buildSyntheticRom()
      flip(rom, ENTRY + at)
      const r = resolveBlockSpawn(rom)
      expect(r.ok, `displacement at ${at}`).toBe(false)
      expect(!r.ok && r.reason).toMatch(/branches somewhere/)
    }
  })

  it('refuses a call that does not reach FindFreeSprSlot, or a FindFreeSprSlot that is not the one the game has', () => {
    for (const at of [34, 35, 36]) {
      const rom = buildSyntheticRom()
      flip(rom, ENTRY + at)
      const r = resolveBlockSpawn(rom)
      expect(!r.ok && r.reason, `JSL operand byte ${at - 34}`).toMatch(/FindFreeSprSlot/)
    }
    const rom = buildSyntheticRom()
    flip(rom, 0x02a9e4) // its own first opcode
    expect(resolveBlockSpawn(rom)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/FindFreeSprSlot/),
    })
  })

  it('refuses a change to any one of the 41 bytes', () => {
    for (let i = 0; i < 41; i++) {
      const rom = buildSyntheticRom()
      flip(rom, ENTRY + i)
      expect(resolveBlockSpawn(rom).ok, `byte ${i}`).toBe(false)
    }
    expect(resolveBlockSpawn(buildSyntheticRom()).ok).toBe(true)
  })
})
