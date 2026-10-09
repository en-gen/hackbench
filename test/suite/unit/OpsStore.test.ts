/**
 * Persisting a WorkingRom's edit layers under a project's `ops/` directory.
 * Fully committed: `old` travels with `address` and `new` (docs/glossary.md,
 * "Op"), so a layer file is self-contained and portable across machines.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  appendLayer,
  clearRedo,
  loadLayers,
  loadRedoLayers,
  popLayer,
  popRedoLayer,
  pushRedoLayer,
  opsStamp,
  OPS_DIR,
  REDO_DIR,
} from '../../../src/project/OpsStore'
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
    popLayer(tmp, 'L2')
    expect(loadLayers(tmp).map(l => l.id)).toEqual(['L1'])
  })

  // The caller names the layer it just took off in memory. A top file that is
  // not that layer (a `git pull` landed one on top) belongs to someone else.
  it('pop refuses, and deletes nothing, when the top file is not the named layer', () => {
    appendLayer(tmp, layer('L1'))
    appendLayer(tmp, layer('PULLED'))
    expect(() => popLayer(tmp, 'L1')).toThrow(/PULLED/)
    expect(loadLayers(tmp).map(l => l.id)).toEqual(['L1', 'PULLED'])
  })

  it('popping an empty stack refuses: the named layer is not on disk', () => {
    expect(() => popLayer(tmp, 'L1')).toThrow()
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

describe('OpsStore staged layers', () => {
  it('a stray NNNN.json.tmp is not a layer and does not move opsStamp', () => {
    appendLayer(tmp, layer('L1'))
    const before = opsStamp(tmp).key
    fs.writeFileSync(path.join(tmp, OPS_DIR, '0001.json.tmp'), '{"half":', 'utf8')
    expect(loadLayers(tmp).map(l => l.id)).toEqual(['L1'])
    expect(opsStamp(tmp).key).toBe(before)
  })
})

/**
 * The redo area: `ops/redo/`, holding layers `undo` took off the stack.
 *
 * Persisted rather than held in memory so redo survives closing the project.
 * Same file format and same zero-padded naming as `ops/` itself, so the
 * highest index is the top of the stack - the next layer `redo` re-applies.
 */
describe('OpsStore redo area', () => {
  it('a project with no redo/ directory yet loads as an empty redo stack', () => {
    expect(loadRedoLayers(tmp)).toEqual([])
  })

  it('round-trips an undone layer: address, old and new all survive', () => {
    pushRedoLayer(tmp, layer('L1'))
    expect(loadRedoLayers(tmp)).toEqual([layer('L1')])
  })

  it('preserves undo order, oldest-undone first', () => {
    pushRedoLayer(tmp, layer('L3'))
    pushRedoLayer(tmp, layer('L2'))
    pushRedoLayer(tmp, layer('L1'))
    expect(loadRedoLayers(tmp).map(l => l.id)).toEqual(['L3', 'L2', 'L1'])
  })

  it('popRedoLayer removes only the most recently undone layer', () => {
    pushRedoLayer(tmp, layer('L2'))
    pushRedoLayer(tmp, layer('L1'))
    popRedoLayer(tmp, 'L1')
    expect(loadRedoLayers(tmp).map(l => l.id)).toEqual(['L2'])
  })

  it('popRedoLayer refuses, and deletes nothing, when the top file is not the named layer', () => {
    pushRedoLayer(tmp, layer('L1'))
    pushRedoLayer(tmp, layer('PULLED'))
    expect(() => popRedoLayer(tmp, 'L1')).toThrow(/PULLED/)
    expect(loadRedoLayers(tmp).map(l => l.id)).toEqual(['L1', 'PULLED'])
  })

  it('popping an empty redo stack refuses: the named layer is not on disk', () => {
    expect(() => popRedoLayer(tmp, 'L1')).toThrow()
    expect(loadRedoLayers(tmp)).toEqual([])
  })

  it('clearRedo empties the redo area, and is safe when there is none', () => {
    expect(() => clearRedo(tmp)).not.toThrow()
    pushRedoLayer(tmp, layer('L1'))
    pushRedoLayer(tmp, layer('L2'))
    clearRedo(tmp)
    expect(loadRedoLayers(tmp)).toEqual([])
  })

  /**
   * `redo/` lives INSIDE `ops/`, so this proves the applied-stack reader is
   * not confused by it. `layerFiles` filters to `.json`, which a directory
   * is not - but that is an invariant worth a test rather than a reading,
   * because a redo entry leaking into the applied stack would re-apply an
   * edit the user explicitly undid.
   */
  it('redo entries never appear in the applied stack', () => {
    appendLayer(tmp, layer('APPLIED'))
    pushRedoLayer(tmp, layer('UNDONE'))
    expect(loadLayers(tmp).map(l => l.id)).toEqual(['APPLIED'])
  })

  it('the redo area sits under ops/, one file per undone layer', () => {
    pushRedoLayer(tmp, layer('L1'))
    const files = fs.readdirSync(path.join(tmp, OPS_DIR, REDO_DIR)).filter(f => f.endsWith('.json'))
    expect(files).toHaveLength(1)
  })
})
