/**
 * WorkingRomRegistry: one WorkingRom per open project, shared by every
 * backend service. See docs/glossary.md, "Working copy".
 *
 * `setWord` always records one committed `edit` layer, validated against
 * the value currently at that address.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject, RomIdentity } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import {
  appendLayer,
  loadLayers,
  loadRedoLayers,
  pushRedoLayer,
} from '../../../src/project/OpsStore'
import { GfxLayer, Layer, WorkingRom } from '../../../src/project/WorkingRom'
import { loromToOffset } from '../../../src/rom/addressing'
import { GfxTable } from '../../../src/rom/GfxTable'
import type { GfxCharEdit } from '../../../src/rom/GfxLayer'
import { RomFile } from '../../../src/rom/RomFile'
import { buildCart } from '../support/syntheticGfxCart'

/**
 * Fault injection for the write paths: `fsFault.hook`, when set, runs before
 * each wrapped call and may throw (a failed write) or act (a pull landing
 * mid-operation). Portable, unlike provoking real I/O errors, and CI is Linux.
 */
const fsFault = vi.hoisted(() => ({
  hook: null as null | ((call: string, target: string) => void),
}))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of ['writeFileSync', 'unlinkSync', 'rmSync', 'renameSync'] as const) {
    const real = actual[name] as (...args: unknown[]) => unknown
    wrapped[name] = (...args: unknown[]) => {
      fsFault.hook?.(name, String(args[0]))
      return real(...args)
    }
  }
  return { ...wrapped, default: wrapped }
})

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
  fsFault.hook = null
  vi.useRealTimers()
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

  // A `git pull` can add, remove or rewrite ops/ files under the same base ROM.
  describe('the cached copy follows the ops/ directory on disk', () => {
    const redLayer = (id: string, oldHex: string, newHex: string): Layer => ({
      id,
      label: `pulled ${id}`,
      ops: [{ address: '$00B2CE', old: oldHex, new: newHex }],
    })

    const redWord = (w: WorkingRom): number => {
      const offset = loromToOffset(MARIO_RED_ADDR, w.baseBytes().length, false) as number
      const bytes = w.bytes()
      return bytes[offset] | (bytes[offset + 1] << 8)
    }

    function opened(manifestPath: string): { w: WorkingRom; dir: string } {
      const r = working.get(manifestPath)
      if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`)
      return { w: r.working, dir: r.project.directory }
    }

    /** A project on a synthetic ROM with a GFX arena. */
    function gfxProject(): { manifestPath: string; dir: string } {
      const romPath = path.join(tmp, 'gfx.sfc')
      fs.writeFileSync(romPath, buildCart({ filler: 4096 }).rom.buffer)
      romRegistry.register(romPath)
      const dirPath = path.join(tmp, 'Gfx')
      const { manifestPath } = createProject({ romPath, name: 'Gfx', directory: dirPath })
      return { manifestPath, dir: opened(manifestPath).dir }
    }
    const gfxLayer = (id: string, value: number): GfxLayer => ({
      id,
      label: id,
      kind: 'gfx',
      chars: [{ file: 2, tile: 0, pixels: [{ x: 0, y: 0, value }] }],
    })
    const gfxPixel = (manifestPath: string, tile: number): number | undefined => {
      const bytes = Buffer.from(opened(manifestPath).w.bytes())
      return GfxTable.load(new RomFile('w.sfc', bytes)).tile(2, tile)?.[0]
    }

    it('picks up a layer file added on disk', () => {
      const { manifestPath } = makeProject()
      working.setWord(manifestPath, { romAddr: MARIO_RED_ADDR, oldHex: '$391F', newHex: '$1000' })
      const { dir } = opened(manifestPath)

      appendLayer(dir, redLayer('pulled', '$1000', '$2000'))

      const { w } = opened(manifestPath)
      expect(w.stack.map(l => l.id).slice(1)).toEqual(['pulled'])
      expect(redWord(w)).toBe(0x2000)
    })

    // Same file name, same layer id and label: only the ops moved.
    it('picks up a layer file rewritten in place', () => {
      const { manifestPath } = makeProject()
      working.setWord(manifestPath, { romAddr: MARIO_RED_ADDR, oldHex: '$391F', newHex: '$1000' })
      const { w: before, dir } = opened(manifestPath)
      const { id, label } = before.stack[0]

      fs.rmSync(path.join(dir, 'ops'), { recursive: true })
      appendLayer(dir, { id, label, ops: [{ address: '$00B2CE', old: '$391F', new: '$7C00' }] })

      const { w } = opened(manifestPath)
      expect(w.stack.map(l => l.id)).toEqual([id])
      expect(redWord(w)).toBe(0x7c00)
    })

    it('picks up a layer file added to the redo area on disk', () => {
      const { manifestPath } = makeProject()
      const { dir } = opened(manifestPath)

      pushRedoLayer(dir, redLayer('pulled', '$391F', '$2000'))

      expect(working.editStack(manifestPath)).toMatchObject({
        status: 'ok',
        canRedo: true,
        redoLabel: 'pulled pulled',
      })
    })

    it('undo after an external change does not delete a file the working copy never applied', () => {
      const { manifestPath } = makeProject()
      working.setWord(manifestPath, { romAddr: MARIO_RED_ADDR, oldHex: '$391F', newHex: '$1000' })
      const { w: before, dir } = opened(manifestPath)
      const mine = before.stack[0].id

      appendLayer(dir, redLayer('pulled', '$1000', '$2000'))

      // Undo takes the pulled layer, which is now the top in memory AND on
      // disk; the edit this copy made stays applied in both.
      expect(working.undo(manifestPath)).toMatchObject({ status: 'ok', redoLabel: 'pulled pulled' })
      const { w } = opened(manifestPath)
      expect(loadLayers(dir).map(l => l.id)).toEqual([mine])
      expect(w.stack.map(l => l.id)).toEqual([mine])
      expect(loadRedoLayers(dir).map(l => l.id)).toEqual(['pulled'])
      expect(redWord(w)).toBe(0x1000)
    })

    // A pulled stack that does not apply to this ROM refuses edits rather
    // than letting them land on a copy that disagrees with disk.
    it('reports unreadable, and refuses edits, when the pulled layers do not apply', () => {
      const { manifestPath } = makeProject()
      const { dir } = opened(manifestPath)

      appendLayer(dir, redLayer('foreign', '$0BAD', '$2000'))

      expect(working.get(manifestPath).status).toBe('unreadable')
      const r = working.setWord(manifestPath, {
        romAddr: MARIO_RED_ADDR,
        oldHex: '$391F',
        newHex: '$1000',
      })
      expect(r.status).toBe('unreadable')
      expect(loadLayers(dir).map(l => l.id)).toEqual(['foreign'])
    })

    // Same name, same size, mtime put back: only ctime says it was written.
    it('picks up a same-size rewrite whose mtime was preserved', () => {
      const { manifestPath } = makeProject()
      working.setWord(manifestPath, { romAddr: MARIO_RED_ADDR, oldHex: '$391F', newHex: '$1000' })
      const file = path.join(opened(manifestPath).dir, 'ops', '0000.json')
      // A whole-second mtime survives the round trip through utimes exactly.
      const pinned = new Date('2026-01-01T00:00:00Z')
      fs.utimesSync(file, pinned, pinned)
      opened(manifestPath)

      const text = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, text.replace('"new":"$1000"', '"new":"$7C00"'))
      fs.utimesSync(file, pinned, pinned)

      expect(redWord(opened(manifestPath).w)).toBe(0x7c00)
    })

    // A gfx layer has no `ops`, so a comparison keyed on them would call two
    // different characters the same layer and keep the stale copy.
    it.each([
      ['a pixel value', '"value":1', '"value":2', 0, 2],
      ['the character number', '"tile": 0', '"tile": 1', 1, 1],
    ])('picks up a same-size gfx layer rewrite of %s whose mtime was preserved', (...c) => {
      const [, from, to, tile, value] = c
      const { manifestPath, dir } = gfxProject()
      appendLayer(dir, gfxLayer('g', 1))
      expect(gfxPixel(manifestPath, 0)).toBe(1)
      expect(gfxPixel(manifestPath, tile)).not.toBe(value) // the rewrite is visible

      const file = path.join(dir, 'ops', '0000.json')
      const pinned = new Date('2026-01-01T00:00:00Z')
      fs.utimesSync(file, pinned, pinned)
      opened(manifestPath)
      const text = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, text.replace(from, to))
      fs.utimesSync(file, pinned, pinned)

      expect(gfxPixel(manifestPath, tile)).toBe(value)
    })

    describe('setGfx', () => {
      const px = (value: number): GfxCharEdit['pixels'] => [{ x: 0, y: 0, value }]

      it('appends ONE layer for several characters, to the stack and to disk, and ends redo', () => {
        const { manifestPath, dir } = gfxProject()
        const r = working.setGfx(manifestPath, [
          { file: 2, tile: 0, pixels: px(5) },
          { file: 2, tile: 1, pixels: px(6) },
        ])
        expect(r.status).toBe('ok')
        expect(gfxPixel(manifestPath, 0)).toBe(5)
        expect(gfxPixel(manifestPath, 1)).toBe(6)
        expect(opened(manifestPath).w.stack).toHaveLength(1)
        expect(loadLayers(dir)).toHaveLength(1)
        working.undo(manifestPath)
        expect(gfxPixel(manifestPath, 0)).not.toBe(5)
        expect(gfxPixel(manifestPath, 1)).not.toBe(6)
        working.redo(manifestPath)
        expect(gfxPixel(manifestPath, 1)).toBe(6)
      })

      it('refuses a character the file lacks, and leaves stack and disk alone', () => {
        const { manifestPath, dir } = gfxProject()
        const r = working.setGfx(manifestPath, [
          { file: 2, tile: 0, pixels: px(5) },
          { file: 2, tile: 999, pixels: px(1) },
        ])
        expect(r.status).toBe('refused')
        expect(opened(manifestPath).w.stack).toHaveLength(0)
        expect(loadLayers(dir)).toHaveLength(0)
      })

      it('keeps the redo, in memory and on disk, when the layer write fails after an undo', () => {
        const { manifestPath, dir } = gfxProject()
        working.setGfx(manifestPath, [{ file: 2, tile: 0, pixels: px(5) }])
        const undone = opened(manifestPath).w.stack[0].id
        working.undo(manifestPath)
        fsFault.hook = (call, target) => {
          if (call === 'writeFileSync' && !target.includes(`${path.sep}redo${path.sep}`)) {
            throw new Error('disk full')
          }
        }
        const r = working.setGfx(manifestPath, [{ file: 2, tile: 1, pixels: px(6) }])
        fsFault.hook = null
        expect(r.status).toBe('io-error')
        expect(loadLayers(dir)).toHaveLength(0)
        expect(loadRedoLayers(dir).map(l => l.id)).toEqual([undone])
        expect(working.editStack(manifestPath)).toMatchObject({ status: 'ok', canRedo: true })
      })

      it('pops the layer back off when the disk write fails', () => {
        const { manifestPath } = gfxProject()
        const held = opened(manifestPath).w // get() would reload from disk and hide a leak
        fsFault.hook = call => {
          if (call === 'writeFileSync') throw new Error('disk full')
        }
        const r = working.setGfx(manifestPath, [{ file: 2, tile: 0, pixels: px(5) }])
        expect(r.status).toBe('io-error')
        expect(held.stack).toHaveLength(0)
      })

      it.each([
        [
          'no pixels',
          [
            { file: 2, tile: 0, pixels: px(1) },
            { file: 2, tile: 1, pixels: [] },
          ],
          /character 1.*one or more pixels/i,
        ],
        [
          'a fractional tile',
          [{ file: 2, tile: 0.5, pixels: px(1) }],
          /character 0.*whole-number/i,
        ],
        ['no characters', [], /nothing to save/i],
      ])('refuses a layer with %s, writes nothing, and the project still opens', (...c) => {
        const [, chars, reason] = c
        const { manifestPath, dir } = gfxProject()
        const r = working.setGfx(manifestPath, chars)
        expect(r.status).toBe('refused')
        expect(r.status === 'refused' && r.reason).toMatch(reason)
        expect(loadLayers(dir)).toHaveLength(0)
        expect(new WorkingRomRegistry(romRegistry).get(manifestPath).status).toBe('ok')
      })

      it('keeps its own copy of the pixels: a caller mutating its array changes nothing', () => {
        const { manifestPath } = gfxProject()
        const edits = [{ file: 2, tile: 0, pixels: px(5) }]
        working.setGfx(manifestPath, edits)
        const held = opened(manifestPath).w
        const bytes = Buffer.from(held.bytes())
        edits[0]!.pixels[0]!.value = 1 // the caller reuses its objects
        edits[0]!.pixels.push({ x: 1, y: 1, value: 2 })
        const layer = held.stack[0]
        expect(layer?.kind === 'gfx' && layer.chars[0]!.pixels).toEqual(px(5))
        // The next get() agrees with disk, so the same working copy comes back.
        expect(opened(manifestPath).w).toBe(held)
        expect(Buffer.compare(bytes, Buffer.from(held.bytes()))).toBe(0)
      })

      it('a multi-character layer reopens to the live bytes, every character', () => {
        const { manifestPath } = gfxProject()
        const edits = [0, 1, 2].map(tile => ({
          file: 2,
          tile,
          pixels: px(((gfxPixel(manifestPath, tile) ?? 0) + 1) & 7),
        }))
        expect(working.setGfx(manifestPath, edits).status).toBe('ok')
        const live = Buffer.from(opened(manifestPath).w.bytes())
        const fresh = new WorkingRomRegistry(romRegistry).get(manifestPath)
        if (fresh.status !== 'ok') throw new Error(fresh.status)
        expect(Buffer.compare(live, Buffer.from(fresh.working.bytes()))).toBe(0)
        for (const e of edits) {
          const t = GfxTable.load(new RomFile('f.sfc', Buffer.from(fresh.working.bytes())))
          expect(t.tile(2, e.tile)![0]).toBe(e.pixels[0]!.value)
        }
      })

      it('a refused Save after an undo leaves the redo layer, in memory and on disk', () => {
        const { manifestPath, dir } = gfxProject()
        working.setGfx(manifestPath, [{ file: 2, tile: 0, pixels: px(5) }])
        working.undo(manifestPath)
        expect(loadRedoLayers(dir)).toHaveLength(1)
        expect(working.setGfx(manifestPath, [{ file: 2, tile: 999, pixels: px(1) }]).status).toBe(
          'refused',
        )
        expect(working.editStack(manifestPath)).toMatchObject({ canRedo: true })
        expect(loadRedoLayers(dir)).toHaveLength(1)
      })

      it('a good Save ends the redo future, on disk too', () => {
        const { manifestPath, dir } = gfxProject()
        working.setGfx(manifestPath, [{ file: 2, tile: 0, pixels: px(5) }])
        working.undo(manifestPath)
        working.setGfx(manifestPath, [{ file: 2, tile: 1, pixels: px(6) }])
        expect(working.editStack(manifestPath)).toMatchObject({ canRedo: false })
        expect(loadRedoLayers(dir)).toHaveLength(0)
      })
    })

    // ops/redo/ is not validated on open for word layers (a stale one opens
    // and refuses on redo). A damaged gfx layer there gets the same policy.
    it.each([
      ['a bad shape', (t: string) => t.replace('"x":0', '"x":0.5'), /gfx layer/],
      ['truncated JSON', (t: string) => t.slice(0, 40), /0000\.json/],
      ['JSON null', () => 'null', /0000\.json/],
      ['word ops that are not a list', () => '{"id":"bad","label":"b","ops":3}', /0000\.json/],
    ])('opens with a gfx layer in ops/redo/ that has %s, and refuses only that redo', (...c) => {
      const [, damage, reason] = c
      const { manifestPath, dir } = gfxProject()
      pushRedoLayer(dir, gfxLayer('bad', 1))
      const file = path.join(dir, 'ops', 'redo', '0000.json')
      fs.writeFileSync(file, damage(fs.readFileSync(file, 'utf8')))

      expect(working.get(manifestPath).status).toBe('ok')
      expect(working.editStack(manifestPath)).toMatchObject({ canRedo: true })
      const r = working.redo(manifestPath)
      expect(r.status).toBe('stale')
      expect(r.status === 'stale' && r.reason).toMatch(reason)
      expect(opened(manifestPath).w.stack).toHaveLength(0)
    })

    // Runs of ten, so replaying per layer (40 decodes) and per run (4) differ.
    it('reopens 4 runs of 10 gfx layers with one table decode per run', () => {
      const { manifestPath, dir } = gfxProject()
      for (let i = 0; i < 40; i++) {
        appendLayer(dir, {
          ...gfxLayer(`g${i}`, 1 + (i % 7)),
          chars: [{ file: i, tile: 0, pixels: [{ x: 0, y: 0, value: 1 + (i % 7) }] }],
        })
        if (i % 10 !== 9) continue
        const [o, n] = [(i - 9) / 10, (i + 1) / 10].map(v => `$${v.toString(16)}`)
        appendLayer(dir, {
          id: `p${i}`,
          label: 'p',
          ops: [{ address: '$00F000', old: o!, new: n! }],
        })
      }
      const loads = vi.spyOn(GfxTable, 'load')
      try {
        expect(new WorkingRomRegistry(romRegistry).get(manifestPath).status).toBe('ok')
        expect(loads).toHaveBeenCalledTimes(4)
      } finally {
        loads.mockRestore()
      }
    })

    // Views hold the instance (working-copy-notifier.ts), so the copy's own
    // writes, and a touch that changes nothing, must not rebuild it.
    it('keeps the same instance across its own edit, undo and redo, and a no-op touch', () => {
      const { manifestPath } = makeProject()
      const { w: first, dir } = opened(manifestPath)

      working.setWord(manifestPath, { romAddr: MARIO_RED_ADDR, oldHex: '$391F', newHex: '$1000' })
      expect(opened(manifestPath).w).toBe(first)
      working.undo(manifestPath)
      expect(opened(manifestPath).w).toBe(first)
      working.redo(manifestPath)
      expect(opened(manifestPath).w).toBe(first)

      const file = path.join(dir, 'ops', '0000.json')
      fs.utimesSync(file, new Date(), new Date(Date.now() + 60_000))
      expect(opened(manifestPath).w).toBe(first)
      expect(first.stack).toHaveLength(1)
    })
  })

  // Undo/redo move a layer between two areas in two writes. Neither a failed
  // write nor a pull landing between them may lose the layer or leave memory
  // and disk disagreeing.
  describe('a move between ops/ and ops/redo/ that fails part-way', () => {
    const inRedo = (target: string) => target.includes(`${path.sep}redo${path.sep}`)

    function editedOnce(): { manifestPath: string; w: WorkingRom; dir: string; mine: string } {
      const { manifestPath } = makeProject()
      working.setWord(manifestPath, { romAddr: MARIO_RED_ADDR, oldHex: '$391F', newHex: '$1000' })
      const r = working.get(manifestPath)
      if (r.status !== 'ok') throw new Error('unreachable')
      return { manifestPath, w: r.working, dir: r.project.directory, mine: r.working.stack[0].id }
    }

    it('undo whose redo write fails keeps the layer applied, in memory and on disk', () => {
      const { manifestPath, w, dir, mine } = editedOnce()
      fsFault.hook = (call, target) => {
        if (call === 'writeFileSync' && inRedo(target)) throw new Error('disk full')
      }

      expect(working.undo(manifestPath).status).toBe('io-error')
      fsFault.hook = null

      expect(loadLayers(dir).map(l => l.id)).toEqual([mine])
      expect(loadRedoLayers(dir)).toEqual([])
      const r = working.get(manifestPath)
      if (r.status !== 'ok') throw new Error('unreachable')
      expect(r.working).toBe(w)
      expect(r.working.stack.map(l => l.id)).toEqual([mine])
    })

    it('redo whose applied write fails keeps the layer redoable, in memory and on disk', () => {
      const { manifestPath, w, dir, mine } = editedOnce()
      working.undo(manifestPath)
      fsFault.hook = (call, target) => {
        if (call === 'writeFileSync' && !inRedo(target)) throw new Error('disk full')
      }

      expect(working.redo(manifestPath).status).toBe('io-error')
      fsFault.hook = null

      expect(loadLayers(dir)).toEqual([])
      expect(loadRedoLayers(dir).map(l => l.id)).toEqual([mine])
      const r = working.get(manifestPath)
      if (r.status !== 'ok') throw new Error('unreachable')
      expect(r.working).toBe(w)
      expect(r.working.redoStack.map(l => l.id)).toEqual([mine])
    })

    it('undo refuses to delete a layer pulled on top between get() and the delete', () => {
      const { manifestPath, dir, mine } = editedOnce()
      fsFault.hook = (call, target) => {
        if (call !== 'writeFileSync' || !inRedo(target)) return
        fsFault.hook = null
        appendLayer(dir, {
          id: 'pulled',
          label: 'pulled',
          ops: [{ address: '$00B2CE', old: '$1000', new: '$2000' }],
        })
      }

      expect(working.undo(manifestPath).status).toBe('io-error')

      expect(loadLayers(dir).map(l => l.id)).toEqual([mine, 'pulled'])
      expect(loadRedoLayers(dir)).toEqual([])
      const r = working.get(manifestPath)
      if (r.status !== 'ok') throw new Error('unreachable')
      expect(r.working.stack.map(l => l.id)).toEqual([mine, 'pulled'])
    })

    it('redo refuses to delete a redo layer pulled on top between get() and the delete', () => {
      const { manifestPath, dir, mine } = editedOnce()
      working.undo(manifestPath)
      fsFault.hook = (call, target) => {
        if (call !== 'writeFileSync' || inRedo(target)) return
        fsFault.hook = null
        pushRedoLayer(dir, {
          id: 'pulled',
          label: 'pulled',
          ops: [{ address: '$00B2CE', old: '$391F', new: '$2000' }],
        })
      }

      expect(working.redo(manifestPath).status).toBe('io-error')

      expect(loadLayers(dir)).toEqual([])
      expect(loadRedoLayers(dir).map(l => l.id)).toEqual([mine, 'pulled'])
      const r = working.get(manifestPath)
      if (r.status !== 'ok') throw new Error('unreachable')
      expect(r.working.stack).toEqual([])
      expect(r.working.redoStack.map(l => l.id)).toEqual([mine, 'pulled'])
    })

    // The refusal's compensating delete fails too, stranding the layer in
    // both areas. It must read as applied, not also as a redo, and the
    // refusal (the cause) must be what the caller is told.
    it('a layer stranded in both areas by a failed compensation reads as applied only', () => {
      const { manifestPath, dir, mine } = editedOnce()
      fsFault.hook = (call, target) => {
        if (call === 'unlinkSync' && inRedo(target)) throw new Error('locked')
        if (call !== 'writeFileSync' || !inRedo(target)) return
        appendLayer(dir, {
          id: 'pulled',
          label: 'pulled',
          ops: [{ address: '$00B2CE', old: '$1000', new: '$2000' }],
        })
      }

      const undone = working.undo(manifestPath)
      fsFault.hook = null
      expect(undone).toMatchObject({
        status: 'io-error',
        reason: expect.stringContaining('pulled'),
      })

      expect(loadRedoLayers(dir).map(l => l.id)).toEqual([mine])
      const r = working.get(manifestPath)
      if (r.status !== 'ok') throw new Error('unreachable')
      expect(r.working.stack.map(l => l.id)).toEqual([mine, 'pulled'])
      expect(r.working.redoStack).toEqual([])
      expect(working.editStack(manifestPath)).toMatchObject({ canRedo: false })
    })

    // append clears the redo stack in memory; if clearing it on disk then
    // fails, the stamp has not moved, so only dropping it forces the check.
    // The clock steps past RACY_MS first: inside that window every call
    // compares anyway, which would hide a stamp that was kept.
    it('an edit whose redo clear fails leaves memory agreeing with disk', () => {
      const { manifestPath, dir, mine } = editedOnce()
      working.undo(manifestPath)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 10_000)
      working.get(manifestPath) // stamps the settled state
      fsFault.hook = call => {
        if (call === 'rmSync') throw new Error('locked')
      }

      const r = working.setWord(manifestPath, {
        romAddr: MARIO_RED_ADDR,
        oldHex: '$391F',
        newHex: '$7C00',
      })
      expect(r.status).toBe('io-error')
      fsFault.hook = null
      // The clear comes first: a write that ran before it would leave a layer on disk.
      expect(loadLayers(dir)).toHaveLength(0)

      expect(loadRedoLayers(dir).map(l => l.id)).toEqual([mine])
      expect(working.editStack(manifestPath)).toMatchObject({ status: 'ok', canRedo: true })
    })

    // The write that fails is the layer's own; the redo future must survive
    // it, in memory and on disk (#634).
    it('a setWord whose layer write fails after an undo keeps the redo, in memory and on disk', () => {
      const { manifestPath, dir, mine } = editedOnce()
      working.undo(manifestPath)
      fsFault.hook = (call, target) => {
        if (call === 'writeFileSync' && !inRedo(target)) throw new Error('disk full')
      }
      const r = working.setWord(manifestPath, {
        romAddr: MARIO_RED_ADDR,
        oldHex: '$391F',
        newHex: '$7C00',
      })
      fsFault.hook = null
      expect(r.status).toBe('io-error')
      expect(loadLayers(dir)).toHaveLength(0)
      expect(loadRedoLayers(dir).map(l => l.id)).toEqual([mine])
      expect(working.editStack(manifestPath)).toMatchObject({ status: 'ok', canRedo: true })
    })

    const wr = (oldHex: string, newHex: string) => ({ romAddr: MARIO_RED_ADDR, oldHex, newHex })
    const tmpsIn = (dir: string) =>
      fs.readdirSync(path.join(dir, 'ops')).filter(f => f.endsWith('.tmp'))

    // A rebuilt instance would strand every subscriber that makes no further request.
    it('a layer write that fails after an undo keeps the held instance and its redo', () => {
      const { manifestPath, w, mine } = editedOnce()
      working.undo(manifestPath)
      fsFault.hook = (call, target) => {
        if (call === 'writeFileSync' && !inRedo(target)) throw new Error('disk full')
      }
      expect(working.setWord(manifestPath, wr('$391F', '$2000')).status).toBe('io-error')
      fsFault.hook = null
      const r = working.get(manifestPath)
      if (r.status !== 'ok') throw new Error('unreachable')
      expect(r.working).toBe(w)
      expect(w.redoStack.map(l => l.id)).toEqual([mine])
    })

    it('a rename that fails pops the failed edit from the held copy', () => {
      const { manifestPath, w } = editedOnce()
      fsFault.hook = call => {
        if (call === 'renameSync') throw new Error('locked')
      }
      expect(working.setWord(manifestPath, wr('$1000', '$2000')).status).toBe('io-error')
      fsFault.hook = null
      expect(w.stack).toHaveLength(1)
    })

    it('a rename and a discard that both fail still report the rename and leave the store usable', () => {
      const { manifestPath, w, dir } = editedOnce()
      fsFault.hook = call => {
        if (call === 'renameSync') throw new Error('locked')
        if (call === 'unlinkSync') throw new Error('locked too')
      }
      const r = working.setWord(manifestPath, wr('$1000', '$2000'))
      fsFault.hook = null
      expect(r).toMatchObject({ status: 'io-error', reason: 'locked' })
      expect(w.stack).toHaveLength(1)
      // The stranded temp is not a layer: not loaded, and the next edit overwrites it.
      expect(tmpsIn(dir)).toHaveLength(1)
      expect(loadLayers(dir)).toHaveLength(1)
      expect(working.setWord(manifestPath, wr('$1000', '$3000')).status).toBe('ok')
      expect(loadLayers(dir).map(l => l.ops?.[0]?.new)).toEqual(['$1000', '$3000'])
      const f = new WorkingRomRegistry(romRegistry).get(manifestPath)
      if (f.status !== 'ok') throw new Error('unreachable')
      expect(f.working.stack).toHaveLength(2)
    })

    it('a stranded temp from a failed rename is invisible to a fresh open', () => {
      const { manifestPath, dir } = editedOnce()
      fsFault.hook = call => {
        if (call === 'renameSync' || call === 'unlinkSync') throw new Error('locked')
      }
      working.setWord(manifestPath, wr('$1000', '$2000'))
      fsFault.hook = null
      expect(tmpsIn(dir)).toEqual(['0001.json.tmp'])
      expect(fs.readdirSync(path.join(dir, 'ops')).filter(f => f === '0001.json')).toEqual([])
      const f = new WorkingRomRegistry(romRegistry).get(manifestPath)
      if (f.status !== 'ok') throw new Error('unreachable')
      expect(f.working.stack).toHaveLength(1)
    })

    it('a redo that dies mid-write leaves no partial layer file under its final name', () => {
      const { manifestPath, dir, mine } = editedOnce()
      working.undo(manifestPath)
      fsFault.hook = (call, target) => {
        if (call !== 'writeFileSync' || inRedo(target)) return
        fsFault.hook = null
        fs.writeFileSync(target, '{"half":', 'utf8')
        throw new Error('power cut')
      }
      expect(working.redo(manifestPath).status).toBe('io-error')
      fsFault.hook = null
      expect(() => loadLayers(dir)).not.toThrow()
      expect(loadLayers(dir)).toEqual([])
      expect(loadRedoLayers(dir).map(l => l.id)).toEqual([mine])
    })

    it('a rename that fails after the redo clear leaves no layer and no temp, memory agreeing', () => {
      const { manifestPath, dir } = editedOnce()
      working.undo(manifestPath)
      fsFault.hook = call => {
        if (call === 'renameSync') throw new Error('locked')
      }
      const r = working.setWord(manifestPath, {
        romAddr: MARIO_RED_ADDR,
        oldHex: '$391F',
        newHex: '$7C00',
      })
      fsFault.hook = null
      expect(r.status).toBe('io-error')
      expect(fs.readdirSync(path.join(dir, 'ops')).filter(f => f.endsWith('.json'))).toEqual([])
      expect(fs.readdirSync(path.join(dir, 'ops')).filter(f => f.includes('.tmp'))).toEqual([])
      expect(loadRedoLayers(dir)).toEqual([])
      expect(working.editStack(manifestPath)).toMatchObject({ status: 'ok', canRedo: false })
    })

    it('a setWord whose layer write fails pops it from the held working copy', () => {
      const { manifestPath } = makeProject()
      const got = working.get(manifestPath)
      if (got.status !== 'ok') throw new Error('unreachable')
      const held = got.working // a later get() would reload from disk and hide a leak
      fsFault.hook = call => {
        if (call === 'writeFileSync') throw new Error('disk full')
      }
      const r = working.setWord(manifestPath, {
        romAddr: MARIO_RED_ADDR,
        oldHex: '$391F',
        newHex: '$1000',
      })
      fsFault.hook = null
      expect(r.status).toBe('io-error')
      expect(held.stack).toHaveLength(0)
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
