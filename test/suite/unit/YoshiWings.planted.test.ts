/**
 * Proof the wings tests can fail (#1229): each plants one defect in a copy of the source, and the
 * same checks the real code passes must throw on it. A mutation here is a smoke test of these two
 * checks, not coverage evidence. The copies live in a scratch directory; imports they do not
 * mutate point back at the real src/rom files.
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'
import * as realTree from '../../../src/rom/MapTree'
import { seamsFor, wingsRom, wingsTree, yoshiUnder } from '../support/wingsTree'

const ROM_DIR = path.resolve(__dirname, '../../../src/rom').split(path.sep).join('/')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-planted-'))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

interface Edit {
  file: string
  from: string
  to: string
}

/** Copies the edited modules, pointing every import they do not edit back at src/rom. */
async function mutant(edits: Edit[]): Promise<typeof realTree> {
  const edited = new Set([...edits.map(e => e.file), 'MapTree'])
  for (const file of edited) {
    let src = fs.readFileSync(path.join(ROM_DIR, `${file}.ts`), 'utf8').replace(/\r\n/g, '\n')
    for (const e of edits.filter(x => x.file === file)) {
      expect(
        src,
        `${e.file}: the text to mutate is gone, so this proof would pass vacuously`,
      ).toContain(e.from)
      src = src.replace(e.from, e.to)
    }
    src = src.replace(/from '\.\/([^']+)'/g, (m, mod: string) =>
      edited.has(mod) ? m : `from '${ROM_DIR}/${mod}'`,
    )
    fs.writeFileSync(path.join(scratch, `${file}.ts`), src)
  }
  return import(/* @vite-ignore */ pathToFileURL(path.join(scratch, 'MapTree.ts')).href)
}

const EXITS = { 0x001: [0x040], 0x040: [], 0x002: [], 0x101: [0x140], 0x140: [], 0x102: [] }

/** The two checks: only column 1 of 4 links, and the link lands in the root's own half. */
function checks(build: typeof realTree.buildMapTree): void {
  for (let x = 0; x < 8; x++) {
    const r = wingsRom(EXITS)
    const linked = Object.keys(yoshiUnder(wingsTree(r, seamsFor(r, { 0x001: [x] }), build))).length
    expect(linked, `column ${x}`).toBe(x % 4 === 1 ? 1 : 0)
  }
  const r = wingsRom(EXITS)
  const t = wingsTree(r, seamsFor(r, { 0x040: [9], 0x102: [13] }), build)
  expect(yoshiUnder(t)).toEqual({ 0x001: [0x0c8], 0x102: [0x1c8] })
}

describe('the wings checks can fail', () => {
  it('pass on the real code', () => {
    checks(realTree.buildMapTree)
  })

  it('go red when the column is ignored', async () => {
    const m = await mutant([
      {
        file: 'YoshiWings',
        from: 'id === WINGS_TILE && columns.has(x % PERIOD)',
        to: 'id === WINGS_TILE',
      },
    ])
    expect(() => checks(m.buildMapTree)).toThrow()
  })

  it('go red when the submap half is ignored', async () => {
    const m = await mutant([
      {
        file: 'MapTree',
        from: 'const high = flags.get(root) ? screenHigh! : 0',
        to: 'const high = 0',
      },
    ])
    expect(() => checks(m.buildMapTree)).toThrow()
  })
})
