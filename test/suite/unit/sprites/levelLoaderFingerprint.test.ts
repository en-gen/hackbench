/**
 * The level loader holds no ROM bytes and no fingerprints: it checks single instructions (loaderSites,
 * an opcode and, where bound, the operand) and then runs the ROM's own routines on the 65816 core
 * (per .claude/rules/rom-interpretation.md stock-code exception, added in #1030). Vanilla: the loaded work RAM
 * is unchanged from the byte-literal version it replaces. Hacks: every one of the 146 store hacks gets the
 * outcome it got on develop. Synthetic: a changed site is refused by name, and CODE_05D796's prologue is run.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loaderShapeProblem,
  loadLevelState,
  loaderSites,
  type Site,
} from '../../../../src/rom/sprites/interp/LevelLoader'
import { RomFile } from '../../../../src/rom/RomFile'
import { freshRom, hasRom, TOOLS_ROOT, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

/**
 * SHA-256 over every level number's (steps, WRAM). WRAM alone is 46135805aad6cc6af578d77c8f9e169b767fba2b3caf37ef858e07977da9c4bb,
 * measured on the loader without the prologue run (156dfff9) and with it (this value's version), one machine, 2026-10-19:
 * the prologue run adds 11 steps per level and changes no cell. Before that, 4b36f5fe... on the byte-literal loader at develop 7848539b.
 */
const VANILLA_ALL_LEVELS = '0346ff5b7acd6e432b040061dec17df4b7a79a49fe2850131e07409d03108a9c'
const VANILLA_ALL_WRAM = '46135805aad6cc6af578d77c8f9e169b767fba2b3caf37ef858e07977da9c4bb'

/**
 * The store hacks (hackbench-tools/hacks/roms, 146 on 2026-10-19) whose loader develop a990aaac accepted by
 * shape, measured by running develop's byte-literal shape list over all 146 (one machine). Of them all but
 * RUN_REFUSED load level $105; those five are accepted by the shape check and then refused while running,
 * with a reason (the pointer loader never returns for four, one leaves ROM code), as on develop.
 */
// prettier-ignore
const DEVELOP_ACCEPTED = [10009, 10020, 10186, 10188, 10907, 16058, 16059, 4987, 5559, 5609, 6161, 6267, 6416, 6593, 6764, 9535, 9717, 9756, 9794, 9795, 9874, 9888]
const RUN_REFUSED = [10186, 6161, 6764, 9535, 9756]
const HACKS_DIR = join(TOOLS_ROOT, 'hacks', 'roms')
/** Where the synthetic cart keeps its entrance setup: off the vanilla address, so a hard-coded entry fails. */
const ENTRANCE = 0x00a6a0
/** The store hack `id` as a fresh ROM. */
const hackRom = (id: number): RomFile => RomFile.load(join(HACKS_DIR, `${id}.sfc`))

type Outcome = 'loads' | 'refused while running' | 'refused by shape'

/** What the loader does with `rom` (level $105): refuse it by shape, accept it and fail while running, or load it. */
function outcomeOf(rom: RomFile): Outcome {
  if (loaderShapeProblem(rom)) return 'refused by shape'
  return loadLevelState(rom, 0x105).ok ? 'loads' : 'refused while running'
}

/** Expected outcome of store hack `id` (develop a990aaac, measured): every hack not listed is refused by shape. */
const expectedOutcome = (id: number): Outcome =>
  !DEVELOP_ACCEPTED.includes(id)
    ? 'refused by shape'
    : RUN_REFUSED.includes(id)
      ? 'refused while running'
      : 'loads'

/** Hacks whose outcome in `got` differs from develop's, as "id: got (want)". */
const parityProblems = (got: ReadonlyMap<number, Outcome>): string[] =>
  [...got].flatMap(([id, o]) =>
    o === expectedOutcome(id) ? [] : [`${id}: ${o} (${expectedOutcome(id)})`],
  )

/** What a fingerprint or a copied byte run in source text looks like. */
const printsIn = (text: string): string[] => [
  ...(text.match(/\b[0-9a-f]{64}\b/g) ?? []),
  ...(text.match(/want\s*:\s*\[/g) ?? []),
  ...(text.match(/(?:0x[0-9a-fA-F]{2},\s*){4,}/g) ?? []),
]

describe('the loader holds no fingerprint and no byte run', () => {
  it('LevelLoader.ts has none, and the scan goes red on each planted form', () => {
    const src = readFileSync(
      join(__dirname, '../../../../src/rom/sprites/interp/LevelLoader.ts'),
      'utf8',
    )
    expect(printsIn(src)).toEqual([])
    expect(printsIn(`const x = '${'ab'.repeat(32)}'`)).toHaveLength(1)
    expect(printsIn('{ want: [0xa9, null] }')).toHaveLength(1)
    expect(printsIn('const b = [0x22, 0x96, 0xd7, 0x05, 0x01]')).toHaveLength(1)
  })
  it('every site is one instruction: an opcode, at most a 16-bit operand and a bank', () => {
    const sites = loaderSites(buildSyntheticRom())
    expect(sites.length).toBeGreaterThan(10)
    for (const s of sites) expect(s.operand?.size ?? 0, s.name).toBeLessThanOrEqual(2)
  })
})

/** Offsets within a site whose change must be refused by the site's own name: the opcode, a compared operand, the branch distance, the bank. */
function guardedOffsets(s: Site): number[] {
  return [
    0,
    ...(s.operand ? Array.from({ length: s.operand.size }, (_, i) => i + 1) : []),
    ...(s.lands === undefined ? [] : [1]),
    ...(s.bank === undefined ? [] : [3]),
  ]
}

/** Every guarded byte of every site on `make()`'s ROM: changed, the loader refuses by the site's name; a followed operand moves the entry and is refused too. */
function expectSitesGuarded(make: () => RomFile): void {
  expect(loaderShapeProblem(make())).toBeNull()
  for (const s of loaderSites(make())) {
    for (const i of guardedOffsets(s)) {
      const rom = make()
      rom.writeAt(s.at + i, [rom.readAt(s.at + i, 1)![0]! ^ 0x01])
      expect(loaderShapeProblem(rom), `${s.name} +${i}`).toBe(
        `${s.name} is not the vanilla shape; the loader will not run it`,
      )
    }
    // A call or jump whose operand is followed, not compared: changing it moves the entry, which is refused.
    if (s.operand === undefined && !s.bankExact && [0x20, 0x22, 0x4c].includes(s.op)) {
      const rom = make()
      rom.writeAt(s.at + 1, [rom.readAt(s.at + 1, 1)![0]! ^ 0x01])
      expect(loaderShapeProblem(rom), `${s.name} operand`).not.toBeNull()
    }
  }
}

describe.skipIf(!hasRom(VANILLA))(
  'vanilla: the structural loader gives the same result as the byte-literal one',
  () => {
    it('all 512 level numbers: one digest over steps and WRAM, one over WRAM alone', () => {
      const rom = freshRom()
      const h = createHash('sha256')
      const hw = createHash('sha256')
      for (let level = 0; level < 512; level++) {
        const l = loadLevelState(rom, level)
        if (!l.ok) throw new Error(`level ${level}: ${l.reason}`)
        h.update(`${level}:${l.steps}:`).update(l.wram)
        hw.update(l.wram)
      }
      expect(hw.digest('hex')).toBe(VANILLA_ALL_WRAM)
      expect(h.digest('hex')).toBe(VANILLA_ALL_LEVELS)
    }, 120_000)
    it('the vanilla ROM has no problem; each site refuses when any guarded byte changes', () => {
      expectSitesGuarded(() => freshRom())
    })
    it('witness: a JSL hook inside the CODE_05D796 prologue ($05:D79E) is refused, with a reason', () => {
      const rom = freshRom()
      rom.writeAt(0x05d79e, [0x22, 0x00, 0x80, 0x05])
      expect(loaderShapeProblem(rom)).toBeNull()
      expect(loadLevelState(rom, 0x105)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/CODE_05D796's prologue left its routine/),
      })
    })
    it('witness: the prologue SEP replaced by NOPs ($05:D799) is refused, with a reason', () => {
      const rom = freshRom()
      rom.writeAt(0x05d799, [0xea, 0xea])
      expect(loaderShapeProblem(rom)).toBeNull()
      expect(loadLevelState(rom, 0x105)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/did not narrow the registers/),
      })
    })
  },
)

/** Ids of the store hacks on this machine (empty when the hacks directory is absent). */
const hackIds = (): number[] =>
  existsSync(HACKS_DIR)
    ? readdirSync(HACKS_DIR)
        .filter(f => /^\d+\.sfc$/.test(f))
        .map(f => parseInt(f, 10))
        .sort((x, y) => x - y)
    : []

describe.skipIf(hackIds().length < 146)(
  'store hacks: all 146 load, or are refused, exactly as on develop',
  () => {
    it('the per-hack outcome equals the one on develop for every hack: 17 load, 5 fail while running, 124 refused by shape', () => {
      const ids = hackIds()
      expect(ids).toHaveLength(146)
      const got = new Map(ids.map(id => [id, outcomeOf(hackRom(id))] as const))
      expect(parityProblems(got)).toEqual([])
      const count = (o: Outcome) => [...got.values()].filter(v => v === o).length
      expect([count('loads'), count('refused while running'), count('refused by shape')]).toEqual([
        17, 5, 124,
      ])
    }, 600_000)
    it('goes red when one hack changes: one that stops loading, and one that is newly accepted', () => {
      const stopped = hackRom(4987)
      stopped.writeAt(0x05801e, [stopped.readAt(0x05801e, 1)![0]! ^ 0x01])
      // 4990 is refused by shape only because its call to UpdateScreenPosition names bank $80; make it bank 0.
      const widened = hackRom(4990)
      widened.writeAt(0x009715, [0x00])
      expect(
        parityProblems(
          new Map([
            [4987, outcomeOf(stopped)],
            [4990, outcomeOf(widened)],
            [9871, outcomeOf(hackRom(9871))],
          ]),
        ),
      ).toEqual(['4987: refused by shape (loads)', expect.stringMatching(/^4990: /)])
    })
  },
)

describe('synthetic: the loader runs hand-written code under its structural checks', () => {
  it('accepts the cart; each guarded byte of each checked instruction is refused by the site name', () => {
    expectSitesGuarded(() => buildSyntheticRom())
    expect(loadLevelState(buildSyntheticRom(), 0x105).ok).toBe(true)
  })
  it('bytes between the sites are not compared: a changed A796 body is not refused by name', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(0x00a79a, [0x00])
    expect(loaderShapeProblem(rom)).toBeNull()
  })
  it('the jump into the pointer loader is checked by its opcode, and its operand is followed to the entry', () => {
    const msg =
      'jump into the pointer loader at $05:D83B is not the vanilla shape; the loader will not run it'
    const rom = buildSyntheticRom()
    rom.writeAt(0x05d83b, [0x6c])
    expect(loaderShapeProblem(rom)).toBe(msg)
    for (const i of [1, 2]) {
      const moved = buildSyntheticRom()
      moved.writeAt(0x05d83b + i, [moved.readAt(0x05d83b + i, 1)![0]! ^ 0x01])
      expect(loaderShapeProblem(moved), `operand ${i}`).toMatch(/pointer loader at \$05:D8B7/)
    }
  })
  it('a long call to the right address in another bank is refused; the $80 mirror of bank 5 is not', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(0x0096f7, [0x06])
    expect(loaderShapeProblem(rom)).toMatch(/GM11 call JSL CODE_05D796/)
    rom.writeAt(0x0096f7, [0x85])
    expect(loaderShapeProblem(rom)).toBeNull()
  })
  it('the call to UpdateScreenPosition must name bank 0 exactly: the $80 mirror is refused', () => {
    const rom = buildSyntheticRom()
    expect(loaderShapeProblem(rom)).toBeNull()
    rom.writeAt(0x009715, [0x80])
    expect(loaderShapeProblem(rom)).toMatch(/GM11 code between the entrance setup/)
    rom.writeAt(0x009715, [0x00])
    expect(loaderShapeProblem(rom)).toBeNull()
  })
  it('the entrance setup branch must land on a load: a landing on anything else is refused', () => {
    const msg =
      'Mario entrance setup at $00:A635 is not the vanilla shape; the loader will not run it'
    const rom = buildSyntheticRom()
    rom.writeAt(ENTRANCE + 11, [0xea]) // the load the branch reaches
    expect(loaderShapeProblem(rom)).toBe(msg)
    const far = buildSyntheticRom()
    far.writeAt(ENTRANCE + 10, [0x02]) // the distance: now reaches an operand byte
    expect(loaderShapeProblem(far)).toBe(msg)
  })
  it('the entry addresses and cells are followed from the ROM: the cart moves the entrance setup and the level cell', () => {
    const l = loadLevelState(buildSyntheticRom(), 0x105)
    if (!l.ok) throw new Error(l.reason)
    expect(l.wram[0x71]).toBe(6) // the entrance stand-in at ENTRANCE ran
    expect([l.wram[0x10], l.wram[0x11], l.wram[0x0e]]).toEqual([0x05, 0x01, 0])
  })
  it('a flag cell or level cell outside work RAM is refused, naming the site', () => {
    const flag = buildSyntheticRom()
    flag.writeAt(0x05d796 + 22, [0x00, 0x20]) // LDA $2000: not work RAM
    expect(loaderShapeProblem(flag)).toMatch(/sublevel flag cell \(outside work RAM\)/)
    expect(loadLevelState(flag, 0x105)).toMatchObject({ ok: false })
    const ok = buildSyntheticRom()
    ok.writeAt(0x05d796 + 22, [0xff, 0x1f]) // the last cell: still work RAM
    expect(loaderShapeProblem(ok)).toBeNull()
  })
  it('witness: a JSL hook inside the CODE_05D796 prologue (offset 8) leaves the routine and is refused', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(0x05d796 + 8, [0x22, 0x00, 0x80, 0x05])
    expect(loaderShapeProblem(rom)).toBeNull()
    expect(loadLevelState(rom, 0x105)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/CODE_05D796's prologue left its routine/),
    })
  })
  it('witness: the prologue SEP replaced by NOPs leaves 16-bit registers and is refused', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(0x05d796 + 1, [0xea, 0xea])
    expect(loaderShapeProblem(rom)).toBeNull()
    expect(loadLevelState(rom, 0x105)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/did not narrow the registers/),
    })
  })
})
