/**
 * Proof the wings tests can fail (#1229): each case plants one defect in a copy of the source, and
 * the same checks the real code passes must throw, with the message of the check that caught it. A
 * mutation here is a smoke test of these checks, not coverage evidence. Every mutant gets its own
 * scratch directory (one shared path serves the first import again); imports a mutant does not edit
 * point back at the real src/rom files.
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'
import * as realTree from '../../../src/rom/MapTree'
import { SmwRom } from '../../../src/rom/SmwRom'
import { seamsFor, wingsRom, wingsTree, yoshiNested, yoshiUnder } from '../support/wingsTree'

const ROM_DIR = path.resolve(__dirname, '../../../src/rom').split(path.sep).join('/')
const scratch: string[] = []
afterAll(() => scratch.forEach(d => fs.rmSync(d, { recursive: true, force: true })))

interface Edit {
  file: string
  from: string
  to: string
}

/** Copies the edited modules (and MapTree) into a fresh directory, pointing every unedited import back at src/rom. */
async function mutant(edits: Edit[]): Promise<typeof realTree> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-planted-'))
  scratch.push(dir)
  const edited = new Set([...edits.map(e => e.file), 'MapTree'])
  for (const file of edited) {
    let src = fs.readFileSync(path.join(ROM_DIR, `${file}.ts`), 'utf8').replace(/\r\n/g, '\n')
    for (const e of edits.filter(x => x.file === file)) {
      expect(
        src,
        `${e.file}: the text to mutate is gone, so this proof would pass vacuously`,
      ).toContain(e.from)
      src = src.split(e.from).join(e.to)
    }
    src = src.replace(/from '\.\/([^']+)'/g, (m, mod: string) =>
      edited.has(mod) ? m : `from '${ROM_DIR}/${mod}'`,
    )
    fs.writeFileSync(path.join(dir, `${file}.ts`), src)
  }
  return import(/* @vite-ignore */ pathToFileURL(path.join(dir, 'MapTree.ts')).href)
}

const EXITS = { 0x001: [0x040], 0x040: [], 0x002: [], 0x101: [0x140], 0x140: [], 0x102: [] }

/** Five checks, each named in its message: columns, halves, the screen-exit operand, a secondary exit, nesting (#1295). */
function checks(build: typeof realTree.buildMapTree): void {
  for (let x = 0; x < 8; x++) {
    const r = wingsRom(EXITS)
    const linked = Object.keys(yoshiUnder(wingsTree(r, seamsFor(r, { 0x001: [x] }), build))).length
    expect(linked, `column ${x}`).toBe(x % 4 === 1 ? 1 : 0)
  }
  const halves = wingsRom(EXITS)
  const t = wingsTree(halves, seamsFor(halves, { 0x040: [9], 0x102: [13] }), build)
  // $040 is a sub area of $001, so its row nests; $102 is a root and lists it directly.
  expect(JSON.stringify([yoshiUnder(t), yoshiNested(t)]), 'halves').toBe(
    JSON.stringify([{ 258: [0x1c8] }, { 1: { 64: [0xc8] } }]),
  )
  const operand = wingsRom({ 0x101: [] })
  operand.writeAt(0x05d7d1, [0x00])
  const o = wingsTree(operand, seamsFor(operand, { 0x101: [1] }), build)
  expect(JSON.stringify(yoshiUnder(o)), 'operand').toBe(JSON.stringify({ 257: [0xc8] }))
  const sec = wingsRom({ 0x001: [0x040], 0x040: [] }, [0x001])
  const s = wingsTree(sec, seamsFor(sec, { 0x001: [1] }), build)
  expect(Object.keys(yoshiUnder(s)).length, 'secondary').toBe(0)
  const cut = wingsRom({ 0x002: [] })
  cut.writeAt(new SmwRom(cut).getLevelL1Pointer(0x002)! + 8, new Array(0x2100).fill(0x01)) // no $FF in reach
  const c = wingsTree(cut, seamsFor(cut, { 0x002: [1] }), build)
  expect(Object.keys(yoshiUnder(c)).length, 'unterminated').toBe(0)
  // #1295: a sub area's block nests the row under that sub area only, never under the root or a sibling.
  const nest = wingsRom({ 0x001: [0x040, 0x041], 0x040: [], 0x041: [] })
  const n = wingsTree(nest, seamsFor(nest, { 0x041: [1] }), build)
  expect(JSON.stringify(yoshiUnder(n)), 'nesting: direct').toBe('{}')
  expect(JSON.stringify(yoshiNested(n)), 'nesting: nested').toBe(
    JSON.stringify({ 1: { 65: [0xc8] } }),
  )
}

describe('the wings checks can fail', () => {
  it('pass on the real code', () => {
    checks(realTree.buildMapTree)
  })

  // Not planted: the half taken from the root's slot (root >= $100) instead of its flag. It is the same
  // value under the stock entry code; only the Lunar Magic entry hook separates them, and no synthetic
  // tree here composes that hook, so that mutant survives (reported, not claimed).
  const PLANTS: [string, Edit[], RegExp][] = [
    [
      'the column is ignored',
      [
        {
          file: 'YoshiWings',
          from: 'id === WINGS_TILE && columns.has(x % PERIOD)',
          to: 'id === WINGS_TILE',
        },
      ],
      /column 0/,
    ],
    [
      'the half is always 0',
      [{ file: 'YoshiWings', from: '((flag ? screenHigh : 0) << 8)', to: '(0 << 8)' }],
      /halves/,
    ],
    [
      'the half is a literal 1',
      [{ file: 'YoshiWings', from: '(flag ? screenHigh : 0)', to: '(flag ? 1 : 0)' }],
      /operand/,
    ],
    [
      'an unreadable holder is counted',
      [{ file: 'MapTree', from: 'graphCut?.includes(i)', to: 'false' }],
      /unterminated/,
    ],
    [
      'a secondary exit is ignored',
      [{ file: 'MapTree', from: 'secondaryExit?.has(i)', to: 'false' }],
      /secondary/,
    ],
    [
      'the link is keyed by root, so the root lists it for a sub area holder',
      [
        {
          file: 'MapTree',
          from: 'wings?.holders.includes(root) ?? false',
          to: 'wings !== undefined',
        },
      ],
      /halves|nesting: direct/,
    ],
    [
      'every sub area of the root nests it, holder or not',
      [{ file: 'MapTree', from: 'wings?.holders.includes(i) ?', to: 'wings !== undefined ?' }],
      /nesting: nested/,
    ],
  ]
  it.each(PLANTS)('go red when %s', async (_what, edits, caught) => {
    const m = await mutant(edits)
    expect(() => checks(m.buildMapTree)).toThrow(caught)
  })
})
