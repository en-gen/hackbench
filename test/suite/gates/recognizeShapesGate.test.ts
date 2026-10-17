/**
 * `recognizeShapes` (SpriteDispatch.ts) makes the sprite readers accept a synthetic cart's own code. It exists for
 * test fixtures only: a call anywhere else would let production accept code the game never had. Calls are allowed
 * under test/suite/support and nowhere else (src, theia, tools, other tests).
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../..')
const SKIP = new Set(['node_modules', 'out', 'dist', 'lib', '.git', 'lib-gen'])
const CALL = /(?<!function )\brecognizeShapes\(/

/** Files (relative, forward slashes) under `dir` whose text calls `recognizeShapes(`, support and this gate excepted. */
function callers(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) out.push(...callers(dir, r))
    } else if (/\.(ts|tsx|js|cjs|mjs)$/.test(e.name)) {
      if (CALL.test(fs.readFileSync(path.join(dir, r), 'utf8'))) out.push(r)
    }
  }
  return out
}
const allowed = (rel: string) =>
  rel.startsWith('test/suite/support/') || rel.endsWith('recognizeShapesGate.test.ts')

describe('recognizeShapes gate', () => {
  it('is called only from test/suite/support', () => {
    const files = ['src', 'theia', 'tools', 'test'].flatMap(d =>
      callers(root, d).filter(r => !allowed(r)),
    )
    expect(
      files,
      `production or test code outside support calls recognizeShapes: ${files.join(', ')}`,
    ).toEqual([])
  })

  it('finds the fixture, so the scan is not walking nothing', () => {
    expect(callers(root, 'test/suite/support')).toContain(
      'test/suite/support/syntheticSpriteRom.ts',
    )
  })

  it('planted: a call in src text is matched, a definition is not', () => {
    expect(CALL.test("import { recognizeShapes } from './x'\nrecognizeShapes(P)")).toBe(true)
    expect(CALL.test('export function recognizeShapes(shapes: ShapePrints) {}')).toBe(false)
  })

  it('planted: a file under src that calls it is reported as an offender', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-'))
    try {
      fs.mkdirSync(path.join(dir, 'src'))
      fs.writeFileSync(path.join(dir, 'src', 'bad.ts'), 'recognizeShapes(MINE)')
      expect(callers(dir, 'src').filter(r => !allowed(r))).toEqual(['src/bad.ts'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
