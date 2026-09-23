/**
 * WorkingRomRegistry: one WorkingRom per open project, shared by every
 * backend service. See docs/glossary.md, "Working copy".
 *
 * `setWord` always records one committed `edit` layer, validated against
 * the value currently at that address.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject, RomIdentity } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import { loadLayers, loadRedoLayers } from '../../../src/project/OpsStore'
import { loromToOffset } from '../../../src/rom/addressing'

let tmp: string
let romRegistry: RomRegistry
let working: WorkingRomRegistry

const MARIO_RED_ADDR = 0x00b2ce

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-wrreg-'))
  romRegistry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
  working = new WorkingRomRegistry(romRegistry)
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function fakeRom(): Uint8Array {
  const rom = new Uint8Array(0x80000)
  for (let i = 0; i < rom.length; i++) rom[i] = (i * 31) & 0xff
  rom.set(Buffer.from('SUPER MARIO WORLD  ', 'ascii'), 0x7fc0)
  const offset = loromToOffset(MARIO_RED_ADDR, rom.length, false) as number
  rom[offset] = 0x1f
  rom[offset + 1] = 0x39 // $391F
  return rom
}

function makeProject(): { manifestPath: string } {
  const romPath = path.join(tmp, 'game.sfc')
  fs.writeFileSync(romPath, fakeRom())
  romRegistry.register(romPath)
  const p = createProject({ romPath, name: 'MyHack', directory: path.join(tmp, 'MyHack') })
  return { manifestPath: p.manifestPath }
}

describe('WorkingRomRegistry', () => {
  it('rom-not-located when the cartridge was never registered', () => {
    const romPath = path.join(tmp, 'unregistered.sfc')
    fs.writeFileSync(romPath, fakeRom())
    const p = createProject({ romPath, name: 'Ghost', directory: path.join(tmp, 'Ghost') })
    // A fresh registry instance that never saw this ROM registered.
    const isolated = new WorkingRomRegistry(new RomRegistry(path.join(tmp, 'other-registry.json')))
    const r = isolated.get(p.manifestPath)
    expect(r.status).toBe('rom-not-located')
  })

  it('setWord records one persisted edit layer and updates bytes()', () => {
    const { manifestPath } = makeProject()
    const r1 = working.setWord(manifestPath, {
      romAddr: MARIO_RED_ADDR,
      oldHex: '$391F',
      newHex: '$03E0',
    })
    expect(r1.status).toBe('ok')
    if (r1.status !== 'ok') throw new Error('unreachable')

    const offset = loromToOffset(MARIO_RED_ADDR, r1.working.baseBytes().length, false) as number
    const bytes = r1.working.bytes()
    expect(bytes[offset] | (bytes[offset + 1] << 8)).toBe(0x03e0)

    const persisted = loadLayers(r1.project.directory)
    expect(persisted).toHaveLength(1)
    expect(persisted[0].ops[0]).toEqual({ address: '$00B2CE', old: '$391F', new: '$03E0' })
  })

  it('each call against the newly-committed value records its own layer, in order', () => {
    const { manifestPath } = makeProject()
    working.setWord(manifestPath, { romAddr: MARIO_RED_ADDR, oldHex: '$391F', newHex: '$1000' })
    const r2 = working.setWord(manifestPath, {
      romAddr: MARIO_RED_ADDR,
      oldHex: '$1000', // the value the FIRST call just committed, not the original
      newHex: '$2000',
    })
    expect(r2.status).toBe('ok')
    if (r2.status !== 'ok') throw new Error('unreachable')

    expect(r2.working.stack).toHaveLength(2)
    expect(loadLayers(r2.project.directory)).toHaveLength(2)

    const offset = loromToOffset(MARIO_RED_ADDR, r2.working.baseBytes().length, false) as number
    const bytes = r2.working.bytes()
    expect(bytes[offset] | (bytes[offset + 1] << 8)).toBe(0x2000)
  })

  it('setWord refuses a stale oldHex instead of silently overwriting', () => {
    const { manifestPath } = makeProject()
    working.setWord(manifestPath, {
      romAddr: MARIO_RED_ADDR,
      oldHex: '$391F',
      newHex: '$03E0',
    })
    const stale = working.setWord(manifestPath, {
      romAddr: MARIO_RED_ADDR,
      oldHex: '$391F', // no longer true: the first edit already changed it
      newHex: '$7C00',
    })
    expect(stale.status).toBe('stale')
    // The rejected edit never persisted a second layer.
    const r = working.get(manifestPath)
    if (r.status !== 'ok') throw new Error('unreachable')
    expect(loadLayers(r.project.directory)).toHaveLength(1)
  })

  it('the same manifest path returns the same in-memory WorkingRom across calls', () => {
    const { manifestPath } = makeProject()
    const a = working.get(manifestPath)
    const b = working.get(manifestPath)
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('unreachable')
    expect(a.working).toBe(b.working)
  })

  // The cache is keyed by path; a `git pull` can repoint the manifest under it.
  describe('the cached copy follows the manifest base ROM identity', () => {
    function rewriteBaseRom(manifestPath: string, baseRom: Partial<RomIdentity>): void {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      manifest.baseRom = { ...manifest.baseRom, ...baseRom }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    }

    it('reports rom-not-located once the manifest names a ROM not on this machine', () => {
      const { manifestPath } = makeProject()
      expect(working.get(manifestPath).status).toBe('ok')
      rewriteBaseRom(manifestPath, { sha256: 'f'.repeat(64), title: 'SOMEONE ELSES ROM' })
      const r = working.get(manifestPath)
      expect(r.status).toBe('rom-not-located')
      if (r.status !== 'rom-not-located') throw new Error('unreachable')
      expect(r.baseRom.title).toBe('SOMEONE ELSES ROM')
    })

    it('loads the newly named ROM when it is registered, not the cached one', () => {
      const { manifestPath } = makeProject()
      const before = working.get(manifestPath)
      if (before.status !== 'ok') throw new Error('unreachable')

      const other = fakeRom()
      other[0] ^= 0xff
      const otherPath = path.join(tmp, 'other.sfc')
      fs.writeFileSync(otherPath, other)
      const otherIdentity = romRegistry.register(otherPath)
      rewriteBaseRom(manifestPath, { sha256: otherIdentity.sha256 })

      const after = working.get(manifestPath)
      if (after.status !== 'ok') throw new Error('unreachable')
      expect(after.working).not.toBe(before.working)
      expect(after.romPath).toBe(otherPath)
      expect(after.working.bytes()[0]).toBe(other[0])
    })

    it('reports unreadable while the manifest is gone, and the same copy once it is back', () => {
      const { manifestPath } = makeProject()
      const a = working.get(manifestPath)
      const saved = fs.readFileSync(manifestPath)
      fs.rmSync(manifestPath)
      expect(working.get(manifestPath).status).toBe('unreadable')
      fs.writeFileSync(manifestPath, saved)
      const b = working.get(manifestPath)
      if (a.status !== 'ok' || b.status !== 'ok') throw new Error('unreachable')
      expect(b.working).toBe(a.working)
    })

    it('keeps the in-memory copy, edits included, when only the title changes', () => {
      const { manifestPath } = makeProject()
      working.setWord(manifestPath, { romAddr: MARIO_RED_ADDR, oldHex: '$391F', newHex: '$03E0' })
      const a = working.get(manifestPath)
      rewriteBaseRom(manifestPath, { title: 'RETITLED' })
      const b = working.get(manifestPath)
      if (a.status !== 'ok' || b.status !== 'ok') throw new Error('unreachable')
      expect(b.working).toBe(a.working)
      expect(b.working.stack).toHaveLength(1)
      expect(b.project.baseRom.title).toBe('RETITLED')
    })
  })

  /**
   * setWord backs Map16 edits too, where bit 15 is real data (vertical
   * flip), not padding. Without `mask: FULL_WORD_MASK` this bit would be
   * silently dropped on write (the default BGR555 behaviour every palette
   * op relies on) - see PaletteOp.ts's `Op.mask`.
   */
  it('setWord with FULL_WORD_MASK writes and validates all 16 bits, not just the low 15', () => {
    const { manifestPath } = makeProject()
    const r1 = working.setWord(manifestPath, {
      romAddr: MARIO_RED_ADDR,
      oldHex: '$391F',
      newHex: '$83E0', // bit 15 set: would be dropped to $03E0 under the default mask
      mask: 0xffff,
    })
    expect(r1.status).toBe('ok')
    if (r1.status !== 'ok') throw new Error('unreachable')
    const offset = loromToOffset(MARIO_RED_ADDR, r1.working.baseBytes().length, false) as number
    const bytes = r1.working.bytes()
    expect(bytes[offset] | (bytes[offset + 1] << 8)).toBe(0x83e0)

    // A stale check against the pre-bit-15 value must now fail: with the
    // full mask, $03E0 no longer matches what is actually committed ($83E0).
    const stale = working.setWord(manifestPath, {
      romAddr: MARIO_RED_ADDR,
      oldHex: '$03E0',
      newHex: '$0000',
      mask: 0xffff,
    })
    expect(stale.status).toBe('stale')
  })
})

/**
 * Undo/redo across the persisted stack.
 *
 * The acceptance the owner asked for: an undone layer is KEPT, so redo can
 * put it back, and it is kept ON DISK, so closing and reopening the project
 * still offers the redo. A new edit ends that future.
 */
describe('WorkingRomRegistry undo/redo', () => {
  const edit = (manifestPath: string, oldHex: string, newHex: string) =>
    working.setWord(manifestPath, { romAddr: MARIO_RED_ADDR, oldHex, newHex })

  const wordAt = (mp: string): number => {
    const r = working.get(mp)
    if (r.status !== 'ok') throw new Error('unreachable')
    const offset = loromToOffset(MARIO_RED_ADDR, r.working.baseBytes().length, false) as number
    const bytes = r.working.bytes()
    return bytes[offset] | (bytes[offset + 1] << 8)
  }

  const dirOf = (mp: string): string => {
    const r = working.get(mp)
    if (r.status !== 'ok') throw new Error('unreachable')
    return r.project.directory
  }

  it('editStack reports what is undoable and redoable, and what each is called', () => {
    const { manifestPath } = makeProject()
    expect(working.editStack(manifestPath)).toMatchObject({
      status: 'ok',
      canUndo: false,
      canRedo: false,
    })

    edit(manifestPath, '$391F', '$03E0')

    expect(working.editStack(manifestPath)).toMatchObject({
      status: 'ok',
      canUndo: true,
      canRedo: false,
      undoLabel: 'set $00B2CE to $03E0',
    })
  })

  it('undo reverts the bytes and moves the layer file into the redo area', () => {
    const { manifestPath } = makeProject()
    edit(manifestPath, '$391F', '$03E0')
    const dir = dirOf(manifestPath)

    const r = working.undo(manifestPath)

    expect(r.status).toBe('ok')
    expect(wordAt(manifestPath)).toBe(0x391f)
    expect(loadLayers(dir)).toHaveLength(0)
    expect(loadRedoLayers(dir).map(l => l.label)).toEqual(['set $00B2CE to $03E0'])
  })

  it('redo re-applies the layer and moves its file back into the applied stack', () => {
    const { manifestPath } = makeProject()
    edit(manifestPath, '$391F', '$03E0')
    working.undo(manifestPath)
    const dir = dirOf(manifestPath)

    const r = working.redo(manifestPath)

    expect(r.status).toBe('ok')
    expect(wordAt(manifestPath)).toBe(0x03e0)
    expect(loadLayers(dir)).toHaveLength(1)
    expect(loadRedoLayers(dir)).toHaveLength(0)
  })

  /**
   * The whole point of persisting the redo area rather than holding it in
   * memory. A second registry over the same project directory is exactly
   * what the next launch of the app sees.
   */
  it('a reopened project still offers the redo, and redoing it works', () => {
    const { manifestPath } = makeProject()
    edit(manifestPath, '$391F', '$03E0')
    working.undo(manifestPath)

    const reopened = new WorkingRomRegistry(romRegistry)
    expect(reopened.editStack(manifestPath)).toMatchObject({
      status: 'ok',
      canUndo: false,
      canRedo: true,
      redoLabel: 'set $00B2CE to $03E0',
    })

    expect(reopened.redo(manifestPath).status).toBe('ok')
    const r = reopened.get(manifestPath)
    if (r.status !== 'ok') throw new Error('unreachable')
    const offset = loromToOffset(MARIO_RED_ADDR, r.working.baseBytes().length, false) as number
    const bytes = r.working.bytes()
    expect(bytes[offset] | (bytes[offset + 1] << 8)).toBe(0x03e0)
  })

  it('a new edit clears the redo future on disk, not just in memory', () => {
    const { manifestPath } = makeProject()
    edit(manifestPath, '$391F', '$03E0')
    working.undo(manifestPath)
    const dir = dirOf(manifestPath)
    expect(loadRedoLayers(dir)).toHaveLength(1)

    edit(manifestPath, '$391F', '$7C00')

    expect(loadRedoLayers(dir)).toHaveLength(0)
    expect(working.editStack(manifestPath)).toMatchObject({ canRedo: false })
    // And a registry reopening the project agrees: nothing lingers.
    expect(new WorkingRomRegistry(romRegistry).editStack(manifestPath)).toMatchObject({
      canRedo: false,
    })
  })

  it('undo and redo are LIFO across several edits', () => {
    const { manifestPath } = makeProject()
    edit(manifestPath, '$391F', '$1000')
    edit(manifestPath, '$1000', '$2000')

    working.undo(manifestPath)
    expect(wordAt(manifestPath)).toBe(0x1000)
    working.undo(manifestPath)
    expect(wordAt(manifestPath)).toBe(0x391f)
    working.redo(manifestPath)
    expect(wordAt(manifestPath)).toBe(0x1000)
    working.redo(manifestPath)
    expect(wordAt(manifestPath)).toBe(0x2000)
  })

  it('undo with nothing to undo is an ok no-op, not a failure', () => {
    const { manifestPath } = makeProject()
    expect(working.undo(manifestPath)).toMatchObject({ status: 'ok', canUndo: false })
    expect(wordAt(manifestPath)).toBe(0x391f)
  })

  it('redo with nothing to redo is an ok no-op, not a failure', () => {
    const { manifestPath } = makeProject()
    edit(manifestPath, '$391F', '$03E0')
    expect(working.redo(manifestPath)).toMatchObject({ status: 'ok', canRedo: false })
    expect(wordAt(manifestPath)).toBe(0x03e0)
  })

  it('a project whose cartridge is not on this machine reports that, rather than throwing', () => {
    const romPath = path.join(tmp, 'unregistered.sfc')
    fs.writeFileSync(romPath, fakeRom())
    const p = createProject({ romPath, name: 'Ghost', directory: path.join(tmp, 'Ghost') })
    const isolated = new WorkingRomRegistry(new RomRegistry(path.join(tmp, 'other-registry.json')))
    expect(isolated.undo(p.manifestPath).status).toBe('rom-not-located')
    expect(isolated.redo(p.manifestPath).status).toBe('rom-not-located')
    expect(isolated.editStack(p.manifestPath).status).toBe('rom-not-located')
  })
})
