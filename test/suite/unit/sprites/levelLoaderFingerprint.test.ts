/**
 * The level loader's fixed spans are fingerprinted, not copied (docs/testing.md "Legal position").
 * Vanilla: the loader result is unchanged from the byte-literal version it replaces. Synthetic:
 * a span with one opcode changed is refused per span, by name, and a cart that was never the
 * vanilla build runs only under its own injected fingerprints.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loaderShapeProblem,
  loadLevelState,
  LOADER_SPANS,
} from '../../../../src/rom/sprites/interp/LevelLoader'
import { RomFile } from '../../../../src/rom/RomFile'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'
import { syntheticLoaderSpans } from '../../support/syntheticLoaderSpans'

const slash = (p: string): string => p.split(sep).join('/')

/** `.ts` files under `roots`, skipping node_modules and build output. */
function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(e =>
    e.name === 'node_modules' || e.name === 'lib' || e.name === 'dist'
      ? []
      : e.isDirectory()
        ? sourceFiles(join(root, e.name))
        : e.name.endsWith('.ts')
          ? [join(root, e.name)]
          : [],
  )
}

/** Number of top-level arguments in the call whose `(` is at `open`; brackets nest, strings are not parsed. */
function argCount(text: string, open: number): number {
  let depth = 0
  let args = 0
  let any = false
  for (let i = open; i < text.length; i++) {
    const c = text[i]!
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) {
      if (--depth === 0) return any ? args + 1 : 0
    } else if (c === ',' && depth === 1) args++
    else if (depth === 1 && !/\s/.test(c)) any = true
  }
  return args
}

/**
 * Callers under `roots` that would let a shipped build run a synthetic cart: a registration, or the
 * `spans` argument (third) of loaderShapeProblem / loadLevelState. LevelLoader.ts itself (the definitions) is exempt.
 */
function loaderCallerProblems(roots: string[]): string[] {
  const out: string[] = []
  for (const f of roots.flatMap(sourceFiles)) {
    if (slash(f).endsWith('sprites/interp/LevelLoader.ts')) continue
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/\b(acceptLoaderSpans|loaderShapeProblem|loadLevelState)\(/g)) {
      const name = m[1]!
      if (name === 'acceptLoaderSpans') out.push(`${f}: acceptLoaderSpans(`)
      else if (!/function\s+$/.test(text.slice(0, m.index))) {
        const n = argCount(text, m.index! + m[0].length - 1)
        if (n >= (name === 'loadLevelState' ? 3 : 2)) out.push(`${f}: ${name}( with ${n} arguments`)
      }
    }
  }
  return out
}

/** SHA-256 over every level number's (steps, WRAM), measured on the byte-literal loader at develop 7848539b. */
const VANILLA_ALL_LEVELS = '4b36f5feb7d21b5827a3f7b55a83274aea0f27edda616542da8609bc7a89648a'

describe.skipIf(!hasRom(VANILLA))(
  'vanilla: the fingerprinted loader gives the same result as the byte-literal one',
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
    it('the vanilla ROM has no problem; each span flips red when its first byte changes', () => {
      expect(loaderShapeProblem(freshRom())).toBeNull()
      for (const s of LOADER_SPANS) {
        const rom = freshRom()
        rom.writeAt(s.at, [rom.readAt(s.at, 1)![0]! ^ 0x01])
        expect(loaderShapeProblem(rom), s.name).toBe(
          `${s.name} is not the vanilla shape; the loader will not run it`,
        )
      }
    })
  },
)

describe('synthetic: the loader runs hand-written code under injected fingerprints', () => {
  it('accepts the cart under its own fingerprints, refuses it under the vanilla ones', () => {
    const rom = buildSyntheticRom()
    expect(loaderShapeProblem(rom, syntheticLoaderSpans())).toBeNull()
    expect(loaderShapeProblem(rom, LOADER_SPANS)).toMatch(/is not the vanilla shape/)
    expect(loadLevelState(rom, 0x105, syntheticLoaderSpans()).ok).toBe(true)
    expect(loadLevelState(rom, 0x105, LOADER_SPANS)).toMatchObject({ ok: false })
  })
  it('the built cart is accepted by default, also as a patched copy; a changed span in the copy is not', () => {
    const rom = buildSyntheticRom()
    expect(loaderShapeProblem(rom)).toBeNull()
    const copy = RomFile.fromBytes('copy.sfc', Uint8Array.from(rom.buffer))
    expect(loaderShapeProblem(copy)).toBeNull()
    copy.writeAt(0x05d8b7, [0xea])
    expect(loaderShapeProblem(copy)).toMatch(/pointer loader at \$05:D8B7 is not the vanilla shape/)
  })
  it('the A796 stand-in masks its operand: a changed masked byte passes, a changed unmasked byte is refused', () => {
    const s = syntheticLoaderSpans().find(t => t.at === 0x00a796)!
    expect(s.mask).toEqual([3, 4])
    for (const [i, ok] of [
      [3, true],
      [4, true],
      [2, false],
      [5, false],
      [7, false],
    ] as const) {
      const rom = buildSyntheticRom()
      rom.writeAt(s.at + i, [rom.readAt(s.at + i, 1)![0]! ^ 0x10])
      const problem = loaderShapeProblem(rom, syntheticLoaderSpans())
      if (ok) expect(problem, `offset ${i}`).toBeNull()
      else
        expect(problem, `offset ${i}`).toMatch(
          /Layer 2 scroll setup at \$00:A796 is not the vanilla shape/,
        )
    }
  })
  it('nothing under src/ or theia/ registers fingerprints or passes the spans argument', () => {
    expect(loaderCallerProblems(['src', 'theia'])).toEqual([])
  })
  it('the caller scan goes red on a planted registration and a planted third argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llfp-'))
    try {
      mkdirSync(join(dir, 'node_modules'))
      const put = (f: string, text: string) => writeFileSync(join(dir, f), text)
      put('node_modules/skipped.ts', 'acceptLoaderSpans(x)')
      put('a.ts', 'acceptLoaderSpans(spans)')
      put('b.ts', 'const l = loadLevelState(rom, f(1, 2), [x])')
      put(
        'c.ts',
        [
          'loaderShapeProblem(rom,',
          '  LOADER_SPANS)',
          'loadLevelState(rom, 1)',
          'loaderShapeProblem(rom)',
        ].join('\n'),
      )
      const norm = (p: string) => slash(p).replace(slash(dir), '.')
      expect(loaderCallerProblems([dir]).map(norm).sort()).toEqual([
        './a.ts: acceptLoaderSpans(',
        './b.ts: loadLevelState( with 3 arguments',
        './c.ts: loaderShapeProblem( with 2 arguments',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it.each(syntheticLoaderSpans().map(s => [s.name, s] as const))(
    '%s: one opcode changed is refused by name',
    (_n, s) => {
      for (let i = 0; i < s.length; i++) {
        const rom = buildSyntheticRom()
        const b = rom.readAt(s.at + i, 1)![0]!
        rom.writeAt(s.at + i, [b ^ 0x10])
        // A zeroed operand byte is not part of the hash: only the masked offsets may pass.
        const problem = loaderShapeProblem(rom, syntheticLoaderSpans())
        if (s.mask.includes(i)) expect(problem).toBeNull()
        else expect(problem).toBe(`${s.name} is not the vanilla shape; the loader will not run it`)
      }
    },
  )
})
