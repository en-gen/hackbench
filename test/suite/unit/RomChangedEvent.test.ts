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
import { createProject } from '../../../src/project/Project'
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
    const notifier = new RomChangedNotifier(working)
    const client = { onRomChanged: vi.fn() }
    notifier.setClient(client)
    working.relocate(manifest, put('copy.sfc', fakeRom(31)))
    expect(client.onRomChanged).toHaveBeenCalledTimes(1)
    expect(client.onRomChanged).toHaveBeenCalledWith(manifest)

    notifier.setClient(undefined)
    working.relocate(manifest, put('copy2.sfc', fakeRom(31)))
    expect(client.onRomChanged).toHaveBeenCalledTimes(1)
  })
})
