/**
 * User-facing text says "ROM", never "cartridge" or "cart" (nobody in the
 * romhacking community calls it that), and US "color", never "colour"
 * (#273, docs/ui-conventions.md). Comments and identifiers are exempt;
 * only string literals and JSX text can reach a user.
 *
 * Playwright covers each view's settled DOM. This gate covers what it
 * cannot pin down: transient placeholders ("Reading the ROM..."), toast
 * messages, and refusal reasons built in src/rom and src/project that the
 * Theia views display verbatim.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { scan, userText, type Tree } from '../support/userText'

const ROOT = path.resolve(__dirname, '../../..')
// US spelling in UI text (#273). Also catches "colours" and "recolour".
const UK_COLOR = /colour/i
const SCANNED = ['theia/extension/src', 'src/rom', 'src/project']
const BANNED = /cartridge|\bcarts?\b/i
/** One row per rule: the real-tree test and the planted-tree test share it. */
const RULES = { cart: BANNED, color: UK_COLOR }

// Parsed once: ~320 files per gate test is slow enough to hit the 5 s default under load.
const REAL = scan(ROOT, SCANNED)

/** `path: "text"` for every scanned user-facing literal matching `re`. */
function offending(re: RegExp, tree: Tree = REAL): string[] {
  // Tripwire: a moved or dropped root must not pass by scanning nothing.
  for (const [root, n] of Object.entries(tree.counts)) {
    if (n === 0) throw new Error(`gate scanned no files under ${root}`)
  }
  return tree.literals.filter(l => re.test(l.text)).map(l => `${l.file}: ${JSON.stringify(l.text)}`)
}

describe('ROM terminology gate', () => {
  it.each(Object.entries(RULES))('no user-facing string breaks the %s rule', (_name, re) => {
    expect(offending(re)).toEqual([])
  })

  it('flags every literal shape, and never a comment or identifier', () => {
    const planted = [
      '// the cartridge in a comment',
      '/* the cart in a block comment */',
      'const cart = 1',
      "const a = 'the base cartridge'",
      'const b = `Locate ${cart} cart`',
      'const c = <div>Reading the cartridge...</div>',
      'const d = <div>{/* cart in a JSX comment */}</div>',
      'const e = <b title="Reload the cart" />',
    ].join('\n')
    expect(userText(planted).filter(s => BANNED.test(s))).toEqual([
      'the base cartridge',
      ' cart',
      'Reading the cartridge...',
      'Reload the cart',
    ])
  })

  it('colour check flags literals and template text, never a comment', () => {
    const planted = [
      '// a colour in a comment',
      "const a = 'Back area colour'",
      'const b = `not a 6-digit css colour: ${x}`',
      'const c = <b title="Pick a colour">Colours</b>',
    ].join('\n')
    expect(userText(planted).filter(s => UK_COLOR.test(s))).toEqual([
      'Back area colour',
      'not a 6-digit css colour: ',
      'Pick a colour',
      'Colours',
    ])
  })

  it('scans every root, and the real-tree check can fail (planted tree)', () => {
    expect(Object.keys(REAL.counts)).toEqual(['theia/extension/src', 'src/rom', 'src/project'])
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termgate-'))
    try {
      fs.mkdirSync(path.join(tmp, 'a'))
      fs.mkdirSync(path.join(tmp, 'b'))
      fs.mkdirSync(path.join(tmp, 'empty'))
      fs.writeFileSync(path.join(tmp, 'a/x.ts'), "export const m = 'Back area colour'")
      fs.writeFileSync(path.join(tmp, 'b/y.tsx'), 'export const v = <b>the cartridge</b>')
      const tree = scan(tmp, ['a', 'b'])
      expect(offending(RULES.color, tree)).toEqual(['a/x.ts: "Back area colour"'])
      expect(offending(RULES.cart, tree)).toEqual(['b/y.tsx: "the cartridge"'])
      expect(() => offending(BANNED, scan(tmp, ['a', 'empty']))).toThrow(/empty/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
