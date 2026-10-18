/**
 * The level loader holds no ROM bytes and no fingerprints: it checks single instructions (LOADER_SITES,
 * an opcode and the operand it is bound to) and then runs the ROM's own routines on the 65816 core
 * (rom-interpretation.md stock-code exception, #1030). Vanilla: the loader result is unchanged from the
 * byte-literal version it replaces. Hacks: every store hack develop's loader accepted still loads.
 * Synthetic: a changed site is refused by name.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loaderShapeProblem,
  loadLevelState,
  LOADER_SITES,
} from '../../../../src/rom/sprites/interp/LevelLoader'
import { RomFile } from '../../../../src/rom/RomFile'
import { freshRom, hasRom, TOOLS_ROOT, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

/** SHA-256 over every level number's (steps, WRAM), measured on the byte-literal loader at develop 7848539b. */
const VANILLA_ALL_LEVELS = '4b36f5feb7d21b5827a3f7b55a83274aea0f27edda616542da8609bc7a89648a'

/**
 * The store hacks (hackbench-tools/hacks/roms, 146 on 2026-10-18) whose loader develop a990aaac accepted by
 * shape, measured by running develop's byte-literal shape list over all 146 (one machine). Of them all but
 * RUN_REFUSED load level $105; those five are accepted by the shape check and then refused while running,
 * with a reason (the pointer loader never returns for four, one leaves ROM code), as on develop.
 */
// prettier-ignore
const DEVELOP_ACCEPTED = [10009, 10020, 10186, 10188, 10907, 16058, 16059, 4987, 5559, 5609, 6161, 6267, 6416, 6593, 6764, 9535, 9717, 9756, 9794, 9795, 9874, 9888]
const RUN_REFUSED = [10186, 6161, 6764, 9535, 9756]
const HACKS_DIR = join(TOOLS_ROOT, 'hacks', 'roms')
const hackRom = (id: number): RomFile => RomFile.load(join(HACKS_DIR, `${id}.sfc`))

/** The ids among `ids` (after `mutate`) the loader accepts by shape, and those of them that load level $105. */
function loadsOf(ids: readonly number[], mutate?: (rom: RomFile) => void) {
  const accepted: number[] = []
  const loaded: number[] = []
  for (const id of ids) {
    const rom = hackRom(id)
    mutate?.(rom)
    if (loaderShapeProblem(rom)) continue
    accepted.push(id)
    if (loadLevelState(rom, 0x105).ok) loaded.push(id)
  }
  return { accepted, loaded }
}

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
    expect(LOADER_SITES.length).toBeGreaterThan(0)
    for (const s of LOADER_SITES) expect(s.operand?.size ?? 0, s.name).toBeLessThanOrEqual(2)
  })
})

/** Every byte of every site on `make()`'s ROM: changed, the loader refuses by the site's name. */
function expectSitesGuarded(make: () => RomFile): void {
  expect(loaderShapeProblem(make())).toBeNull()
  for (const s of LOADER_SITES) {
    const n = 1 + (s.operand?.size ?? 0) + (s.bank === undefined ? 0 : 1)
    for (let i = 0; i < n; i++) {
      const rom = make()
      rom.writeAt(s.at + i, [rom.readAt(s.at + i, 1)![0]! ^ 0x01])
      expect(loaderShapeProblem(rom), `${s.name} +${i}`).toBe(
        `${s.name} is not the vanilla shape; the loader will not run it`,
      )
    }
  }
}

describe.skipIf(!hasRom(VANILLA))(
  'vanilla: the structural loader gives the same result as the byte-literal one',
  () => {
    it('all 512 level numbers: one digest over steps and WRAM', () => {
      const rom = freshRom()
      const h = createHash('sha256')
      for (let level = 0; level < 512; level++) {
        const l = loadLevelState(rom, level)
        if (!l.ok) throw new Error(`level ${level}: ${l.reason}`)
        h.update(`${level}:${l.steps}:`).update(l.wram)
      }
      expect(h.digest('hex')).toBe(VANILLA_ALL_LEVELS)
    }, 120_000)
    it('the vanilla ROM has no problem; each site refuses when any of its bytes changes', () => {
      expectSitesGuarded(() => freshRom())
    })
  },
)

describe.skipIf(!existsSync(HACKS_DIR) || readdirSync(HACKS_DIR).length < 146)(
  'store hacks: every one develop accepted still loads',
  () => {
    it('all 22 are accepted by shape; 17 load level $105 and the other 5 are refused while running', () => {
      const { accepted, loaded } = loadsOf(DEVELOP_ACCEPTED)
      expect(accepted).toEqual(DEVELOP_ACCEPTED)
      expect(loaded).toEqual(DEVELOP_ACCEPTED.filter(id => !RUN_REFUSED.includes(id)))
    }, 300_000)
    it('goes red when one of them stops loading: a planted change to its data loader entry', () => {
      const victim = 4987
      const planted = loadsOf([victim], rom =>
        rom.writeAt(0x05801e, [rom.readAt(0x05801e, 1)![0]! ^ 0x01]),
      )
      expect(planted).toEqual({ accepted: [], loaded: [] })
      expect(loadsOf([victim]).loaded).toEqual([victim])
    })
  },
)

describe('synthetic: the loader runs hand-written code under its structural checks', () => {
  it('accepts the cart; each byte of each checked instruction is refused by the site name', () => {
    expectSitesGuarded(() => buildSyntheticRom())
    expect(loadLevelState(buildSyntheticRom(), 0x105).ok).toBe(true)
  })
  it('bytes between the sites are not compared: a changed A796 body is not refused by name', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(0x00a79a, [0x00])
    expect(loaderShapeProblem(rom)).toBeNull()
  })
  it('the jump into the pointer loader is checked by its target: the opcode and each operand byte', () => {
    const msg =
      'jump into the pointer loader at $05:D83B is not the vanilla shape; the loader will not run it'
    for (const [i, v] of [
      [0, 0x6c],
      [1, 0xb8],
      [2, 0xd9],
    ] as const) {
      const rom = buildSyntheticRom()
      rom.writeAt(0x05d83b + i, [v])
      expect(loaderShapeProblem(rom), `offset ${i}`).toBe(msg)
    }
  })
  it('a long call to the right address in another bank is refused; the $80 mirror of bank 5 is not', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(0x0096f7, [0x06])
    expect(loaderShapeProblem(rom)).toMatch(/GM11 call JSL CODE_05D796/)
    rom.writeAt(0x0096f7, [0x85])
    expect(loaderShapeProblem(rom)).toBeNull()
  })
})
