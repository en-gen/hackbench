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
  type LoaderSpan,
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

/**
 * FINGERPRINT MINIMUM (BA ruling 2026-10-18): a stock-code print needs 24 or more UNKNOWN bytes, that is
 * bytes neither masked nor stated anywhere else in the repo (literals, constants, mnemonic comments, docs).
 * Per span (key: SNES address), the bytes the repo states elsewhere, counted generously (prose that
 * describes an instruction counts as stating all of it), with where:
 *  - $96F4: SubmapFlagGate REACH states the JSL and its target (3); docs/ideas/sprite-gfx-interpreter.md
 *    names the $1404 increment (3).
 *  - $A796: scrollSim.ts describes the Layer 2 offset arithmetic in prose (4).
 *  - $F6DB: scrollSim.ts and parallaxDerivation.ts give the +$18 camera buffer constant (2) and describe the
 *    position copies in prose (4).
 *  - $D796: SubmapFlagGate states the JMP at $D7B0 (3).
 *  - $D8B7: SmwRom.ts describes the pointer indexing in prose (5).
 *  - $A635: the entrance-setup prose in MarioStartPos.ts and the docs cites only line numbers (5).
 *  - $801E: L2Loader.ts states the $25 fill and the $FF compare (2).
 */
const STATED_ELSEWHERE: Record<number, number> = {
  0x0096f4: 6,
  0x00a796: 4,
  0x00f6db: 6,
  0x05d796: 3,
  0x05d8b7: 5,
  0x00a635: 5,
  0x05801e: 2,
}
const UNKNOWN_FLOOR = 24

/** Spans with fewer than UNKNOWN_FLOOR unknown bytes, or with no stated-elsewhere count at all. */
function floorProblems(spans: readonly LoaderSpan[], stated: Record<number, number>): string[] {
  return spans.flatMap(s => {
    const known = stated[s.at]
    if (known === undefined) return [`${s.name}: no stated-elsewhere count`]
    const unknown = s.length - new Set(s.mask).size - known
    return unknown >= UNKNOWN_FLOOR ? [] : [`${s.name}: ${unknown} unknown bytes`]
  })
}

describe('fingerprint minimum: every loader span hides at least 24 unknown bytes', () => {
  it('the real spans clear the floor, and every span has a stated-elsewhere count', () => {
    expect(floorProblems(LOADER_SPANS, STATED_ELSEWHERE)).toEqual([])
    expect(Object.keys(STATED_ELSEWHERE).map(Number).sort()).toEqual(
      LOADER_SPANS.map(s => s.at).sort(),
    )
  })
  it('the check goes red on a short span, a span emptied by its mask, and a span with no count', () => {
    const base = { name: 'planted', at: 0x96f8, sha: '' }
    expect(floorProblems([{ ...base, length: 10, mask: [] }], { 0x96f8: 0 })).toEqual([
      'planted: 10 unknown bytes',
    ])
    expect(
      floorProblems([{ ...base, length: 30, mask: [0, 1, 2, 3, 4, 5, 6] }], { 0x96f8: 0 }),
    ).toEqual(['planted: 23 unknown bytes'])
    expect(floorProblems([{ ...base, length: 30, mask: [] }], { 0x96f8: 7 })).toEqual([
      'planted: 23 unknown bytes',
    ])
    expect(floorProblems([{ ...base, length: 30, mask: [] }], {})).toEqual([
      'planted: no stated-elsewhere count',
    ])
    expect(floorProblems([{ ...base, length: 30, mask: [] }], { 0x96f8: 0 })).toEqual([])
  })
})

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
    it('every byte of every span: a masked one may change, an unmasked one is refused by name', () => {
      for (const s of LOADER_SPANS)
        for (let i = 0; i < s.length; i++) {
          const rom = freshRom()
          rom.writeAt(s.at + i, [rom.readAt(s.at + i, 1)![0]! ^ 0x01])
          const problem = loaderShapeProblem(rom)
          if (s.mask.includes(i)) expect(problem, `${s.name} +${i}`).toBeNull()
          else
            expect(problem, `${s.name} +${i}`).toBe(
              `${s.name} is not the vanilla shape; the loader will not run it`,
            )
        }
    })
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
  it('the jump into the pointer loader is checked by its target, not by bytes: each operand byte and the opcode', () => {
    const msg =
      'jump into the pointer loader at $05:D83B is not the vanilla shape; the loader will not run it'
    for (const [i, v] of [
      [0, 0x6c], // JMP (abs) instead of JMP abs
      [1, 0xb8], // low byte of the target
      [2, 0xd9], // high byte of the target
    ] as const) {
      const rom = buildSyntheticRom()
      rom.writeAt(0x05d83b + i, [v])
      expect(loaderShapeProblem(rom, syntheticLoaderSpans()), `offset ${i}`).toBe(msg)
    }
    expect(loaderShapeProblem(buildSyntheticRom(), syntheticLoaderSpans())).toBeNull()
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
