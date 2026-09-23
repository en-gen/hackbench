/**
 * A case that is absent is not a case that is skipped.
 *
 * Measured on this suite at 830be6f by running it twice, once with
 * `test/roms/` attached and once without, and diffing the TEST COUNTS rather
 * than the skip counts: 154 cases existed with the corpus and did not exist
 * without it. None of them was reported as skipped, because none of them was
 * ever registered. The run was green, the skip count was tidy, and 154
 * assertions had quietly stopped being made. CI has no cartridge and never
 * will, so that was CI's permanent state, not an edge case.
 *
 * Every shape that produced it is banned here. The rule they share: WHICH
 * cases a file registers must not depend on what is on the disk. Register
 * every case, then let `skipIf` turn the ones missing their fixture into
 * honest skips, which a skip count can show and a reviewer can read.
 *
 * The scope of the ban is deliberate. Reading the corpus INSIDE a case body
 * is fine, and several suites do it: the case exists either way, and a
 * tripwire on the listing (Map16.tileCount.test.ts asserts
 * `carts.length > 0`) stops it passing vacuously. What is banned is deciding
 * at module scope, from the filesystem, how many cases there will be.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SUITE_DIR = path.resolve(__dirname, '..')

/**
 * This file quotes every banned shape, in its comments and in the planted
 * defects below, so it cannot scan itself. Nothing else is exempt.
 */
const EXEMPT = new Set([path.join('gates', 'testRegistrationGate.test.ts')])

/** A registration call: `it(`, `test(`, `describe(`, `it.each(`, `describe.for(`. */
const REGISTERS = /(^|[^.\w])(it|test|describe)(\.(each|concurrent|sequential|for)[(<])?\(/

/** `const romFiles = ...`, at column 0, so only module scope is considered. */
const MODULE_SCOPE_BINDING = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/

/**
 * An `if` statement, at ANY indentation. The first version of this rule
 * required leading whitespace, so moving the `if` to column 0 - which is
 * where a module-scope gate naturally sits - made it unreachable.
 */
const IF_LINE = /^\s*if\s*\(/

/** `.filter(f => existsSync(...))`: an existence test inside one filter argument. */
const EXISTS_FILTER = /\.filter\([^)]*existsSync/

interface Offence {
  file: string
  line: number
  rule: string
  text: string
}

/**
 * The four shapes, each one a defect this suite actually carried.
 *
 * `listingIteration`  MapTree.test.ts read `test/roms` with `readdirSync` at
 *                     module scope and looped the cases over the result. An
 *                     empty listing registers zero cases: 36 gone.
 * `existsFilter`      GfxDecode.test.ts filtered a DECLARED corpus by
 *                     `existsSync` before looping, so an absent cart left the
 *                     list instead of being skipped: 6 gone.
 * `ternarySkip`       A `cond ? describe : describe.skip` gate, or a bare
 *                     `.skip` / `.todo`. These do register, but a bare skip
 *                     cannot say why it is skipped, and the ternary is the
 *                     spelling the other shapes grow out of. `skipIf` states
 *                     the condition at the point of the gate.
 * `conditional`       OwnerGrid.test.ts wrapped cases in `if (romPresent)`,
 *                     and elsewhere in `if (!romPresent) { placeholder;
 *                     return }`. The first leaves no trace in any count at
 *                     all: no case, no skip, no number that changes.
 */
export function findRegistrationOffences(relPath: string, source: string): Offence[] {
  const lines = source.split(/\r?\n/)
  const found: Offence[] = []
  const add = (i: number, rule: string): void => {
    found.push({ file: relPath, line: i + 1, rule, text: lines[i].trim() })
  }

  // Names bound at module scope to something read off the filesystem: the
  // listings themselves, and the `const romPresent = existsSync(...)` flags
  // derived from them.
  const fsDerived = new Set<string>()
  const fsFlags = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const m = MODULE_SCOPE_BINDING.exec(lines[i])
    if (!m) continue
    const expr = initialiser(lines, i)
    if (/readdirSync/.test(expr)) fsDerived.add(m[1])
    if (/existsSync/.test(expr)) fsFlags.add(m[1])
    if (EXISTS_FILTER.test(expr)) {
      fsDerived.add(m[1])
      add(i, 'existsFilter')
    }
  }

  /**
   * Does this `if` ask the filesystem a question? Conditions over a DECLARED
   * expectation table are a different thing and stay allowed: they register
   * the same cases on every machine, which is the whole property being
   * protected. MusicData.test.ts and the two SpcBuilder bank suites do this,
   * deliberately, from per-ROM tables committed alongside them.
   */
  const asksTheDisk = (text: string): boolean =>
    /existsSync|readdirSync/.test(text) ||
    [...fsDerived, ...fsFlags].some(n => new RegExp(`\\b${n}\\b`).test(text))

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (/\?\s*(it|test|describe)\s*:\s*(it|test|describe)\.skip/.test(line)) add(i, 'ternarySkip')
    else if (/\?\s*(it|test|describe)\.skip\s*:\s*(it|test|describe)\b/.test(line))
      add(i, 'ternarySkip')
    else if (/(^|[^.\w])(it|test|describe)\.(skip|todo)[(<]/.test(line)) add(i, 'ternarySkip')

    // A module-scope loop over a filesystem-derived list, wrapping cases.
    const loop = /for\s*\(\s*(?:const|let)\s+.*\sof\s+([A-Za-z_$][\w$]*)\b/.exec(line)
    const each = /\b([A-Za-z_$][\w$]*)\.(forEach|map)\(/.exec(line)
    const over = (loop?.[1] ?? '') || (each?.[1] ?? '')
    if (over && fsDerived.has(over) && blockRegisters(lines, i)) add(i, 'listingIteration')

    // A case registered inside an `if` that asks the filesystem. Whichever
    // way the condition falls, the cases on the other side do not exist, and
    // on the machine without the fixture that is every one of them.
    if (IF_LINE.test(line) && asksTheDisk(line) && blockRegisters(lines, i)) add(i, 'conditional')

    // An `if` that asks the filesystem and BAILS OUT. Nothing registers
    // inside it, so `conditional` cannot see it: the cases it kills are the
    // ones AFTER it, and there is no syntax at that point saying so.
    //
    // This is the shape five of the eleven converted files actually used,
    // and it is the worst of them, because the abort is unbounded. It was
    // only ever caught here by the placeholder `it.skip` that usually sat
    // beside the `return` - and `ternarySkip` tells authors to delete that
    // line. Removing the placeholder and keeping the `return` left this gate
    // green on a file registering 1 of 11 cases. Measured, not reasoned.
    if (
      IF_LINE.test(line) &&
      asksTheDisk(line) &&
      blockReturns(lines, i) &&
      registersAfter(lines, i)
    )
      add(i, 'earlyReturn')
  }

  return found
}

/**
 * Does the block opening at `start` bail out with a bare `return`?
 *
 * Only the block's OWN depth counts. A `return` inside a nested arrow or
 * function belongs to that callee and aborts nothing at suite scope, so
 * counting it would flag every legitimate helper.
 */
function blockReturns(lines: string[], start: number): boolean {
  let depth = 0
  let opened = false
  for (let i = start; i < lines.length; i++) {
    const atOwnDepth = !opened || depth === 1
    if (atOwnDepth && /(^|[^.\w])return\s*(;|$|})/.test(lines[i])) return true
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++
        opened = true
      } else if (ch === '}') depth--
    }
    if (opened && depth <= 0) return false
    // A braceless `if (x) return` is one line and has no block to walk.
    if (!opened && i > start) return false
  }
  return false
}

/**
 * Does a registration call follow this `if`, inside the same enclosing block?
 *
 * This is what separates the two early returns. One sits at suite scope with
 * cases after it, and bailing out unregisters every one of them. The other
 * sits INSIDE a case body, where the case has already registered and the
 * return only ends that case early; `docs/testing.md` permits reading the
 * corpus there. Without this check the rule fires on both, and the noise
 * would get it switched off.
 *
 * (An early return inside a case body that then asserts nothing is a real
 * defect, but it is the vacuous-pass defect, not the registration defect
 * this gate is about. It needs its own rule, not a false positive here.)
 */
function registersAfter(lines: string[], start: number): boolean {
  let depth = 0
  let opened = false
  let i = start
  // Step over the if's own block first.
  for (; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++
        opened = true
      } else if (ch === '}') depth--
    }
    if (opened && depth <= 0) break
    if (!opened && i > start) break
  }
  // Now walk the REST of the enclosing block, tracking braces rather than
  // indentation: the first `}` that takes us below the level we resumed at
  // is the enclosing block closing, and a registration after that belongs to
  // somebody else.
  let rel = 0
  for (let j = i + 1; j < lines.length; j++) {
    if (REGISTERS.test(lines[j]) && rel >= 0) return true
    for (const ch of lines[j]) {
      if (ch === '{') rel++
      else if (ch === '}') {
        rel--
        if (rel < 0) return false
      }
    }
  }
  return false
}

/** The text of a binding's initialiser: from its line to the next statement. */
function initialiser(lines: string[], start: number): string {
  const out: string[] = [lines[start]]
  for (let i = start + 1; i < lines.length && i - start < 20; i++) {
    // A continuation is indented, or a line the formatter broke onto `.`/`)`.
    if (/^\S/.test(lines[i]) && !/^\s*[.)\]]/.test(lines[i])) break
    if (lines[i].trim() === '') break
    out.push(lines[i])
  }
  return out.join('\n')
}

/**
 * Does the brace-delimited block opening at or after `start` register a case?
 * Walks braces rather than indentation, so reformatting a file cannot quietly
 * stop it being checked.
 */
function blockRegisters(lines: string[], start: number): boolean {
  let depth = 0
  let opened = false
  for (let i = start; i < lines.length; i++) {
    if (opened && REGISTERS.test(lines[i])) return true
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++
        opened = true
      } else if (ch === '}') depth--
    }
    if (opened && depth <= 0) return false
  }
  return false
}

describe('test registration gate', () => {
  const files = fs.existsSync(SUITE_DIR) ? testFiles(SUITE_DIR) : []

  // Tripwire: a gate that finds nothing to check passes by default. This repo
  // has shipped a determinism check that reported five byte-identical runs
  // having compared zero files.
  it('has test files to check, so a passing verdict means something', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some(f => f.endsWith('MapTree.test.ts'))).toBe(true)
  })

  it('no suite decides from the filesystem how many cases it registers', () => {
    const offences = files
      .map(f => path.relative(SUITE_DIR, f))
      .filter(rel => !EXEMPT.has(rel))
      .flatMap(rel =>
        findRegistrationOffences(rel, fs.readFileSync(path.join(SUITE_DIR, rel), 'utf8')),
      )
    const report = offences.map(o => `${o.file}:${o.line} [${o.rule}] ${o.text}`)
    expect(report, `use describe.skipIf / it.skipIf instead:\n${report.join('\n')}`).toEqual([])
  })
})

/**
 * Proof the gate goes red, one planted defect per rule.
 *
 * Each plant is the shape as it was actually written in this repo, quoted
 * from the commit that removed it, so the gate is proven against the real
 * defect rather than a caricature of it.
 */
describe('the registration gate can fail', () => {
  const PLANTS: Array<{ rule: string; source: string }> = [
    {
      rule: 'earlyReturn',
      // AnimationLoader.test.ts and four others, before this change, with
      // the `it.skip` placeholder removed. The placeholder is the only thing
      // that made the first version of this gate notice the shape, and
      // `ternarySkip` tells authors to delete it. Without this plant, that
      // interaction put the gate back to green on a file dropping 10 of 11
      // cases. Measured on a real probe, not reasoned about.
      source: [
        'const romPresent = existsSync(ROM_PATH)',
        '',
        "describe('AnimationLoader', () => {",
        "  it('needs no cartridge', () => {})",
        '  if (!romPresent) {',
        '    return',
        '  }',
        "  it('reads the animation table', () => {})",
        "  it('reads the tileset bases', () => {})",
        '})',
      ].join('\n'),
    },
    {
      rule: 'listingIteration',
      // MapTree.test.ts, before this change.
      source: [
        'const romFiles = fs.existsSync(ROM_DIR)',
        '  ? fs',
        '      .readdirSync(ROM_DIR)',
        '      .filter(f => /\\.sfc$/i.test(f))',
        '      .sort()',
        '  : []',
        '',
        "describe('buildMapTree', () => {",
        '  for (const file of romFiles) {',
        '    describe(file, () => {',
        "      it('covers every real map the catalog found', () => {})",
        '    })',
        '  }',
        '})',
      ].join('\n'),
    },
    {
      rule: 'existsFilter',
      // GfxDecode.test.ts, before this change.
      source: [
        "const CORPUS = ['Super Mario World (USA).vanilla.sfc']",
        '  .map(name => ({ name, path: resolve(ROM_DIR, name) }))',
        '  .filter(rom => existsSync(rom.path))',
        '',
        "describe('gfx-decode corpus sweep', () => {",
        '  for (const { name, path } of CORPUS) {',
        '    it(`${name}: availability is honest`, () => {})',
        '  }',
        '})',
      ].join('\n'),
    },
    {
      rule: 'ternarySkip',
      // MapTree.test.ts, before this change.
      source: [
        'const withRoms = romFiles.length > 0 ? describe : describe.skip',
        '',
        "withRoms('buildMapTree', () => {",
        "  it('covers every real map', () => {})",
        '})',
      ].join('\n'),
    },
    {
      rule: 'conditional',
      // OwnerGrid.test.ts, before this change. No placeholder, no skip: this
      // case left no trace of its absence anywhere in the run's numbers.
      source: [
        'const romPresent = existsSync(ROM_PATH)',
        '',
        "describe('the oracle can fail', () => {",
        '  if (romPresent) {',
        '    const rom = SmwRom.open(ROM_PATH)',
        "    it('a first-writer owner grid breaks the check', () => {})",
        '  }',
        '})',
      ].join('\n'),
    },
  ]

  for (const { rule, source } of PLANTS) {
    it(`catches the ${rule} shape`, () => {
      const offences = findRegistrationOffences('planted.test.ts', source)
      expect(offences.map(o => o.rule)).toContain(rule)
    })
  }

  // The `earlyReturn` rule's own negative control. An early return INSIDE a
  // case body unregisters nothing: the case has already registered, and the
  // return only ends that one case. `docs/testing.md` permits reading the
  // corpus there. Flagging it would be noise, and noise is how a gate gets
  // switched off.
  it('permits an early return inside a case body, which registers nothing away', () => {
    const inBody = [
      "describe('AnimationLoader', () => {",
      "  it('A/B compare against the Mesen dump', () => {",
      '    const dump = resolve(__dirname, "dump.dmp")',
      '    if (!existsSync(dump)) {',
      '      return',
      '    }',
      '    expect(readFileSync(dump).length).toBeGreaterThan(0)',
      '  })',
      '})',
    ].join('\n')
    expect(findRegistrationOffences('inbody.test.ts', inBody)).toEqual([])
  })

  // The other half of an oracle: it must also be capable of green. A gate
  // that flags everything is as useless as one that flags nothing, and would
  // pass the four cases above without distinguishing anything.
  it('passes the corrected shape, so it is not simply always red', () => {
    const corrected = [
      "const CORPUS = ['Super Mario World (USA).vanilla.sfc']",
      'const present = (f: string): boolean => existsSync(path.join(ROM_DIR, f))',
      '',
      "describe('buildMapTree', () => {",
      '  for (const file of CORPUS) {',
      '    describe.skipIf(!present(file))(file, () => {',
      "      it('covers every real map the catalog found', () => {})",
      '    })',
      '  }',
      '})',
    ].join('\n')
    expect(findRegistrationOffences('corrected.test.ts', corrected)).toEqual([])
  })

  // The narrowing has to hold, or the gate turns into a ban on branching and
  // someone deletes it. A condition over a committed expectation table
  // registers the same cases everywhere, which is the property being
  // protected, so it is allowed: this is SpcBuilderBankSongs.test.ts.
  it('allows a case gated on a declared expectation, not on the disk', () => {
    const declared = [
      "const EXPECTED = { 'Super Mario World (USA).vanilla.sfc': { level: { count: 30 } } }",
      '',
      "describe('bank songs', () => {",
      '  for (const [file, expected] of Object.entries(EXPECTED)) {',
      '    describe.skipIf(!present(file))(file, () => {',
      '      if (expected.level.count > 0) {',
      "        it('song commands are 1-based and sequential', () => {})",
      '      }',
      '    })',
      '  }',
      '})',
    ].join('\n')
    expect(findRegistrationOffences('declared.test.ts', declared)).toEqual([])
  })
})

/** Every `*.test.ts` under test/suite, recursively. */
function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...testFiles(full))
    else if (e.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}
