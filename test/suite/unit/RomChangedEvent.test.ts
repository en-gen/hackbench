/**
 * The ROM-changed event (#576): the node side announces, from one place, that
 * a project's base ROM was swapped, so explorers and views rebuild from
 * scratch. It must fire once per swap and NOT on the first build or on an
 * ordinary edit (those have their own paths). Synthetic ROMs only: CI has no
 * ROM. Each case asserts a COUNT, so an event that never fires fails too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject, romIdentity } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import { appendLayer } from '../../../src/project/OpsStore'
import { loromToOffset } from '../../../src/rom/addressing'
import { RomChangedNotifier } from '../../../theia/extension/src/node/rom-changed-notifier'

let tmp: string
let registry: RomRegistry
let working: WorkingRomRegistry

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-romchg-'))
  registry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
  working = new WorkingRomRegistry(registry)
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function fakeRom(seed: number): Uint8Array {
  const rom = new Uint8Array(0x80000)
  for (let i = 0; i < rom.length; i++) rom[i] = (i * seed) & 0xff
  rom.set(Buffer.from('SUPER MARIO WORLD  '.padEnd(21, ' '), 'ascii'), 0x7fc0)
  return rom
}

function put(name: string, bytes: Uint8Array): string {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, bytes)
  return p
}

function project(romPath: string, dir = 'proj', register = true): string {
  if (register) registry.register(romPath)
  return createProject({ romPath, name: 'P', directory: path.join(tmp, dir) }).manifestPath
}

const ADDR = 0x00b2ce

/** The word at ADDR as the "$XXXX" string an op's `old` expects. */
function wordAt(bytes: Uint8Array): string {
  const at = loromToOffset(ADDR, bytes.length, false) as number
  const word = bytes[at] | (bytes[at + 1] << 8)
  return `$${word.toString(16).toUpperCase().padStart(4, '0')}`
}

/** Rewrite the manifest's base ROM hash to that of `bytes` (what a `git pull` can do). */
function repoint(manifest: string, bytes: Uint8Array): string {
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  m.baseRom.sha256 = romIdentity(bytes).sha256
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2))
  return m.baseRom.sha256
}

function recorder(): { fired: string[]; stop: () => void } {
  const fired: string[] = []
  return { fired, stop: working.onRomChanged(m => fired.push(m)) }
}

describe('WorkingRomRegistry.onRomChanged', () => {
  it('fires once, for the project, when relocate swaps the ROM path', () => {
    const manifest = project(put('a.sfc', fakeRom(31)))
    working.get(manifest)
    const { fired } = recorder()
    expect(working.relocate(manifest, put('copy.sfc', fakeRom(31)))).toEqual({ status: 'ok' })
    expect(fired).toEqual([manifest])
  })

  it('fires for a project with no cache entry, the ROM-not-located case #527 fixes', () => {
    const rom = put('a.sfc', fakeRom(31))
    const manifest = project(rom)
    fs.rmSync(rom)
    expect(working.get(manifest).status).toBe('rom-not-located')
    const { fired } = recorder()
    working.relocate(manifest, put('moved.sfc', fakeRom(31)))
    expect(fired).toEqual([manifest])
    expect(working.get(manifest).status).toBe('ok')
  })

  it('fires once for each cached project on the same ROM, and once for a header flip', () => {
    const rom = put('a.sfc', fakeRom(31))
    const first = project(rom)
    const second = project(rom, 'proj2', false)
    working.get(first)
    working.get(second)
    const bare = fakeRom(31)
    const headered = new Uint8Array(bare.length + 512)
    headered.set(bare, 512)
    const { fired } = recorder()
    working.relocate(first, put('headered.smc', headered))
    expect([...fired].sort()).toEqual([first, second].sort())
    // The entries were dropped for a header flip; their rebuild is the swap
    // already announced, not a second one.
    working.get(first)
    working.get(second)
    expect(fired).toHaveLength(2)
  })

  it('a refused relocate fires nothing', () => {
    const manifest = project(put('a.sfc', fakeRom(31)))
    working.get(manifest)
    const { fired } = recorder()
    expect(working.relocate(manifest, put('other.sfc', fakeRom(33))).status).toBe('mismatch')
    expect(fired).toEqual([])
  })

  it('does not fire on the first build, a cached read, or an ordinary edit', () => {
    const bytes = fakeRom(31)
    const manifest = project(put('a.sfc', bytes))
    const { fired } = recorder()
    working.get(manifest)
    working.get(manifest)
    const edit = { romAddr: ADDR, oldHex: wordAt(bytes), newHex: '$03E0' }
    expect(working.setWord(manifest, edit).status).toBe('ok')
    expect(working.get(manifest).status).toBe('ok')
    expect(fired).toEqual([])
  })

  it('fires when a rebuild replaces an existing entry (layers rewritten under it)', () => {
    const bytes = fakeRom(31)
    const manifest = project(put('a.sfc', bytes))
    const first = working.get(manifest)
    if (first.status !== 'ok') throw new Error(first.status)
    const { fired } = recorder()
    // As a `git pull` would: a layer lands in ops/ behind the cached copy.
    appendLayer(first.project.directory, {
      id: 'pulled',
      label: 'pulled',
      ops: [{ address: '$00B2CE', old: wordAt(bytes), new: '$03E0' }],
    })
    expect(working.get(manifest).status).toBe('ok')
    expect(fired).toEqual([manifest])
  })

  it('relocating one project announces only that project, not one on another ROM', () => {
    const first = project(put('a.sfc', fakeRom(31)))
    const second = project(put('b.sfc', fakeRom(37)), 'proj2')
    working.get(first)
    working.get(second)
    const { fired } = recorder()
    working.relocate(first, put('copy.sfc', fakeRom(31)))
    expect(fired).toEqual([first])
  })

  it('registering a ROM announces the projects that were waiting for it, once each', () => {
    const rom = put('a.sfc', fakeRom(31))
    const waitingA = project(rom)
    const waitingB = project(rom, 'proj2', false)
    const other = project(put('b.sfc', fakeRom(37)), 'proj3')
    fs.rmSync(rom)
    // A fresh registry: neither project's ROM is findable, so both wait.
    registry.forget(JSON.parse(fs.readFileSync(waitingA, 'utf8')).baseRom.sha256)
    expect(working.get(waitingA).status).toBe('rom-not-located')
    expect(working.get(waitingB).status).toBe('rom-not-located')
    expect(working.get(other).status).toBe('ok')
    const { fired } = recorder()
    working.register(put('back.sfc', fakeRom(31)))
    expect([...fired].sort()).toEqual([waitingA, waitingB].sort())
    // Served now: registering again announces nothing.
    working.register(put('back2.sfc', fakeRom(31)))
    expect(fired).toHaveLength(2)
  })

  it('a project that waited and was then served by get() is not announced by a later register', () => {
    const rom = put('a.sfc', fakeRom(31))
    const manifest = project(rom)
    const sha = JSON.parse(fs.readFileSync(manifest, 'utf8')).baseRom.sha256
    registry.forget(sha)
    expect(working.get(manifest).status).toBe('rom-not-located')
    // The ROM turns up WITHOUT going through the working registry.
    registry.register(rom)
    expect(working.get(manifest).status).toBe('ok')
    const { fired } = recorder()
    working.register(put('again.sfc', fakeRom(31)))
    expect(fired).toEqual([])
  })

  it('a waiting project served by a later get() is announced once, and a later register adds nothing', () => {
    const rom = put('a.sfc', fakeRom(31))
    const manifest = project(rom)
    const sha = JSON.parse(fs.readFileSync(manifest, 'utf8')).baseRom.sha256
    registry.forget(sha)
    expect(working.get(manifest).status).toBe('rom-not-located')
    const { fired } = recorder()
    // The ROM reappears without register or relocate: a view stuck on "Locate"
    // learns of it from the first get() that finds it.
    registry.register(rom)
    expect(working.get(manifest).status).toBe('ok')
    expect(fired).toEqual([manifest])
    working.get(manifest)
    working.register(put('again.sfc', fakeRom(31)))
    expect(fired).toEqual([manifest])
  })

  it('relocating one waiting project announces the others waiting on the same ROM', () => {
    const rom = put('a.sfc', fakeRom(31))
    const a = project(rom)
    const b = project(rom, 'proj2', false)
    fs.rmSync(rom)
    registry.forget(JSON.parse(fs.readFileSync(a, 'utf8')).baseRom.sha256)
    expect(working.get(a).status).toBe('rom-not-located')
    expect(working.get(b).status).toBe('rom-not-located')
    const { fired } = recorder()
    working.relocate(a, put('moved.sfc', fakeRom(31)))
    expect([...fired].sort()).toEqual([a, b].sort())
    // B is served now; a register must not announce it a second time.
    working.register(put('again.sfc', fakeRom(31)))
    expect(fired).toHaveLength(2)
  })

  it('a manifest repointed at a missing ROM is announced once when the ROM turns up', () => {
    const romA = put('a.sfc', fakeRom(31))
    const manifest = project(romA)
    expect(working.get(manifest).status).toBe('ok') // cached on ROM A
    const other = fakeRom(37)
    const shaB = repoint(manifest, other)
    expect(registry.resolve(shaB)).toBeNull()
    expect(working.get(manifest).status).toBe('rom-not-located')
    const { fired } = recorder()
    working.register(put('b.sfc', other))
    expect(working.get(manifest).status).toBe('ok')
    expect(fired).toEqual([manifest])
  })

  it('registering a ROM nobody was waiting for announces nothing', () => {
    const { fired } = recorder()
    working.register(put('a.sfc', fakeRom(31)))
    expect(fired).toEqual([])
  })

  it('stops delivering after the returned unsubscribe is called', () => {
    const manifest = project(put('a.sfc', fakeRom(31)))
    const { fired, stop } = recorder()
    stop()
    working.relocate(manifest, put('copy.sfc', fakeRom(31)))
    expect(fired).toEqual([])
  })
})

describe('RomChangedNotifier pushes the event to its own connection', () => {
  it('a relocate reaches the client exactly once; a closed connection hears nothing', () => {
    const manifest = project(put('a.sfc', fakeRom(31)))
    const notifier = new RomChangedNotifier(() => working)
    const client = { onRomChanged: vi.fn() }
    notifier.setClient(client)
    working.relocate(manifest, put('copy.sfc', fakeRom(31)))
    expect(client.onRomChanged).toHaveBeenCalledTimes(1)
    expect(client.onRomChanged).toHaveBeenCalledWith(manifest)

    notifier.setClient(undefined)
    working.relocate(manifest, put('copy2.sfc', fakeRom(31)))
    expect(client.onRomChanged).toHaveBeenCalledTimes(1)
  })

  it('a reconnect releases the old subscription: only the new client hears the swap', () => {
    const manifest = project(put('a.sfc', fakeRom(31)))
    const notifier = new RomChangedNotifier(() => working)
    const closed = { onRomChanged: vi.fn() }
    const replaced = { onRomChanged: vi.fn() }
    const current = { onRomChanged: vi.fn() }
    notifier.setClient(closed)
    notifier.setClient(undefined)
    notifier.setClient(replaced)
    notifier.setClient(current) // a new connection without a close in between
    working.relocate(manifest, put('copy.sfc', fakeRom(31)))
    expect(closed.onRomChanged).not.toHaveBeenCalled()
    expect(replaced.onRomChanged).not.toHaveBeenCalled()
    expect(current.onRomChanged).toHaveBeenCalledTimes(1)
  })
})
