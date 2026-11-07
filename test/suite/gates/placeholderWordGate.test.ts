/**
 * No user-facing string says "placeholder" or "test level" (#949, D69). Slots
 * that share a pointer are ordinary maps and unpointed slots are "New"; the old
 * wording came from #901 and the owner ruled it out.
 *
 * Only string literals and JSX text are scanned. That leaves out, by design,
 * what the issue names as unrelated: an HTML `placeholder=` attribute or an
 * `input.placeholder = ...` assignment (the attribute NAME is not a literal) and
 * the sprite renderer's "placeholder box", which is an identifier and comments.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { scan, userText, type Tree } from '../support/userText'

const ROOT = path.resolve(__dirname, '../../..')
const SCANNED = ['theia/extension/src', 'src/rom', 'src/project']
// Whitespace runs (a line break in a template or JSX) and hyphens split the words too.
const BANNED = /\bplace[\s-]*holders?\b|\btest[\s-]*levels?\b/i

/**
 * The sprite renderer's `status: 'drawn' | 'placeholder'` is a code, never shown:
 * the bare word, in the four files that carry it. Anything else there still fails.
 */
const SPRITE_STATUS_FILES = new Set([
  'theia/extension/src/browser/map-view-model.ts',
  'theia/extension/src/browser/sprite-props.ts',
  'theia/extension/src/common/project-protocol.ts',
  'theia/extension/src/node/map-sprites.ts',
])
const isSpriteStatus = (l: Tree['literals'][number]): boolean =>
  l.text === 'placeholder' && SPRITE_STATUS_FILES.has(l.file)

const REAL = scan(ROOT, SCANNED)

/** `path: "text"` for every scanned literal matching the rule; throws if a root held no files. */
function offending(tree: Tree = REAL): string[] {
  for (const [root, n] of Object.entries(tree.counts)) {
    if (n === 0) throw new Error(`gate scanned no files under ${root}`)
  }
  return tree.literals
    .filter(l => BANNED.test(l.text) && !isSpriteStatus(l))
    .map(l => `${l.file}: ${JSON.stringify(l.text)}`)
}

describe('placeholder wording gate', () => {
  it('no user-facing string says placeholder or test level', () => {
    expect(offending()).toEqual([])
  })

  it('flags every literal shape, never a comment, identifier or HTML attribute', () => {
    const planted = [
      '// a placeholder in a comment',
      'const placeholder = 1',
      'input.placeholder = "Search maps"',
      'const a = <input placeholder="Search maps" />',
      "const b = 'This slot is a placeholder'",
      'const c = `Slot ${n} is a Test Level`',
      'const d = <div>Placeholders: {n}</div>',
      "const e = { placeholder: 'Open a recent project' }",
      'const f = <b title="test level" />',
    ].join('\n')
    expect(userText(planted).filter(s => BANNED.test(s))).toEqual([
      'This slot is a placeholder',
      ' is a Test Level',
      'Placeholders: ',
      'test level',
    ])
  })

  it.each([
    ['test newline level', 'This is a test\n  level'],
    ['test-level', 'The test-level slot'],
    ['place-holder', 'a place-holder map'],
    ['place holder', 'a place holder map'],
    ['Test   Levels', 'Test   Levels: 3'],
  ])('catches the split spelling %j', (_name, text) => {
    expect(BANNED.test(text)).toBe(true)
    expect(BANNED.test('Search maps and levels in the latest list')).toBe(false)
    expect(BANNED.test('Open the latest level')).toBe(false)
  })

  it('goes red on a planted string in a scanned tree, and a missing root cannot hide', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'placeholdergate-'))
    try {
      fs.mkdirSync(path.join(tmp, 'a'))
      fs.mkdirSync(path.join(tmp, 'empty'))
      fs.writeFileSync(path.join(tmp, 'a/x.tsx'), "export const m = 'placeholder slot'")
      fs.writeFileSync(path.join(tmp, 'a/y.ts'), "export const n = 'Search maps'")
      expect(offending(scan(tmp, ['a']))).toEqual(['a/x.tsx: "placeholder slot"'])
      // The exemption is the bare status word in its own files, nothing wider.
      fs.mkdirSync(path.join(tmp, 'theia/extension/src/browser'), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, 'theia/extension/src/browser/sprite-props.ts'),
        "export const s = 'placeholder'; export const t = 'placeholder box'",
      )
      expect(offending(scan(tmp, ['theia/extension/src']))).toEqual([
        'theia/extension/src/browser/sprite-props.ts: "placeholder box"',
      ])
      // ...and the bare word anywhere else is still a failure: the exemption names three files.
      fs.writeFileSync(
        path.join(tmp, 'theia/extension/src/browser/other.ts'),
        "export const s = 'placeholder'",
      )
      expect(offending(scan(tmp, ['theia/extension/src']))).toEqual([
        'theia/extension/src/browser/other.ts: "placeholder"',
        'theia/extension/src/browser/sprite-props.ts: "placeholder box"',
      ])
      expect(() => offending(scan(tmp, ['a', 'empty']))).toThrow(/empty/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('scans the three roots', () => {
    expect(Object.keys(REAL.counts)).toEqual(SCANNED)
  })
})
