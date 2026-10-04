/**
 * User-facing text says "ROM", never "cartridge" or "cart": nobody in the
 * romhacking community calls it that. Comments and identifiers are exempt;
 * only string literals and JSX text can reach a user.
 *
 * Playwright covers each view's settled DOM. This gate covers what it
 * cannot pin down: transient placeholders ("Reading the ROM..."), toast
 * messages, and refusal reasons built in src/rom and src/project that the
 * Theia views display verbatim.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'

const ROOT = path.resolve(__dirname, '../../..')
// US spelling in UI text (#273). Also catches "colours" and "recolour".
const UK_COLOR = /colour/i
const SCANNED = ['theia/extension/src', 'src/rom', 'src/project']
const BANNED = /cartridge|\bcarts?\b/i

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

/** Every piece of literal text in `source` that could be shown to a user. */
function userText(source: string, fileName = 'x.tsx'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
      found.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** `path: "text"` for every scanned user-facing literal matching `re`. */
function offending(re: RegExp): string[] {
  const files = SCANNED.flatMap(d => sourceFiles(path.join(ROOT, d)))
  // Tripwire: a moved directory must not pass by scanning nothing.
  expect(files.length).toBeGreaterThan(100)
  return files.flatMap(f =>
    userText(fs.readFileSync(f, 'utf8'), f)
      .filter(s => re.test(s))
      .map(s => `${path.relative(ROOT, f)}: ${JSON.stringify(s)}`),
  )
}

describe('ROM terminology gate', () => {
  it('no user-facing string says cartridge or cart', () => {
    expect(offending(BANNED)).toEqual([])
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

  it('no user-facing string says colour (US spelling, #273)', () => {
    expect(offending(UK_COLOR)).toEqual([])
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
})
