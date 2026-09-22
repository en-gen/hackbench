/**
 * Persisting a WorkingRom's edit layers under a project's `ops/` directory.
 * Fully committed: `old` travels with `address` and `new` (docs/glossary.md,
 * "Op"), so a layer file is self-contained and portable across machines.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { appendLayer, loadLayers, popLayer, OPS_DIR } from '../../../src/project/OpsStore'
import { Layer } from '../../../src/project/WorkingRom'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ops-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const layer = (id: string): Layer => ({
  id,
  label: `set Mario's red (${id})`,
  ops: [{ address: '$00B2CE', old: '$391F', new: '$03E0' }],
})

describe('OpsStore', () => {
  it('a project with no ops/ directory yet loads as an empty stack', () => {
    expect(loadLayers(tmp)).toEqual([])
  })

  it('round-trips a layer: address, old and new all survive, unchanged', () => {
    appendLayer(tmp, layer('L1'))
    const loaded = loadLayers(tmp)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(layer('L1'))
  })

  it('preserves stack order across several appends', () => {
    appendLayer(tmp, layer('L1'))
    appendLayer(tmp, layer('L2'))
    appendLayer(tmp, layer('L3'))
    expect(loadLayers(tmp).map(l => l.id)).toEqual(['L1', 'L2', 'L3'])
  })

  it('pop removes only the most recently appended layer', () => {
    appendLayer(tmp, layer('L1'))
    appendLayer(tmp, layer('L2'))
    popLayer(tmp)
    expect(loadLayers(tmp).map(l => l.id)).toEqual(['L1'])
  })

  it('popping an empty stack is a no-op, not a throw', () => {
    expect(() => popLayer(tmp)).not.toThrow()
    expect(loadLayers(tmp)).toEqual([])
  })

  it('each layer file is one op per line and carries "old" (nothing is gitignored)', () => {
    appendLayer(tmp, layer('L1'))
    const files = fs.readdirSync(path.join(tmp, OPS_DIR)).filter(f => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    const text = fs.readFileSync(path.join(tmp, OPS_DIR, files[0]), 'utf8')
    const opLine = text.split('\n').find(l => l.includes('"address"'))
    expect(opLine).toBeDefined()
    expect(opLine).toContain('"old"')
    expect(opLine).toContain('"new"')
    // Valid JSON on its own once trailing comma/brackets are trimmed - the
    // real round-trip above already proves parseability; this just proves
    // the "one op per line" shape a reviewer's diff depends on.
    expect(JSON.parse(opLine!.trim().replace(/,$/, ''))).toEqual({
      address: '$00B2CE',
      old: '$391F',
      new: '$03E0',
    })
  })
})
