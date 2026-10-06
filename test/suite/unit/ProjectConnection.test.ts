/**
 * What one connection's project service wires up (#576), tested through the
 * plain-TS ProjectConnection that ProjectServiceImpl forwards `setClient` to.
 * ProjectServiceImpl itself cannot load in the unit job (it imports Theia's
 * inversify, which that job does not install), so a source check pins the
 * forwarding, and ConnectionDi.test.ts proves it end to end where Theia is
 * installed. Synthetic ROMs only: CI has no ROM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import { appendLayer } from '../../../src/project/OpsStore'
import { WorkingRom } from '../../../src/project/WorkingRom'
import { loromToOffset } from '../../../src/rom/addressing'
import { EditEvent } from '../../../src/project/EditEvent'
import { ProjectConnection } from '../../../theia/extension/src/node/project-connection'

const client = () => ({ onEditEvent: vi.fn(), onRomChanged: vi.fn() })

describe('ProjectConnection with a stubbed registry (every subscription observable)', () => {
  function stub() {
    const unsubRom = vi.fn()
    const unsubCopy = vi.fn()
    const registry = {
      onRomChanged: vi.fn(() => unsubRom),
      onWorkingCopy: vi.fn(() => unsubCopy),
    }
    return { registry, unsubRom, unsubCopy }
  }

  it('subscribes to both registry events once per client', () => {
    const { registry } = stub()
    new ProjectConnection(() => registry as unknown as WorkingRomRegistry).setClient(client())
    expect(registry.onRomChanged).toHaveBeenCalledTimes(1)
    expect(registry.onWorkingCopy).toHaveBeenCalledTimes(1)
  })

  it('a closed connection releases the ROM and the copy subscription', () => {
    const { registry, unsubRom, unsubCopy } = stub()
    const c = new ProjectConnection(() => registry as unknown as WorkingRomRegistry)
    c.setClient(client())
    c.setClient(undefined)
    expect(unsubRom).toHaveBeenCalledTimes(1)
    expect(unsubCopy).toHaveBeenCalledTimes(1)
    expect(registry.onWorkingCopy).toHaveBeenCalledTimes(1)
  })

  it('connect, close, reconnect: every old subscription is released, new ones made', () => {
    const { registry, unsubRom, unsubCopy } = stub()
    const c = new ProjectConnection(() => registry as unknown as WorkingRomRegistry)
    c.setClient(client())
    c.setClient(undefined)
    c.setClient(client())
    expect(registry.onRomChanged).toHaveBeenCalledTimes(2)
    expect(registry.onWorkingCopy).toHaveBeenCalledTimes(2)
    expect(unsubRom).toHaveBeenCalledTimes(1)
    expect(unsubCopy).toHaveBeenCalledTimes(1)
    c.setClient(undefined)
    expect(unsubRom).toHaveBeenCalledTimes(2)
    expect(unsubCopy).toHaveBeenCalledTimes(2)
  })

  it('a new client without a close in between still releases the old subscriptions', () => {
    const { registry, unsubRom, unsubCopy } = stub()
    const c = new ProjectConnection(() => registry as unknown as WorkingRomRegistry)
    c.setClient(client())
    c.setClient(client())
    expect(unsubRom).toHaveBeenCalledTimes(1)
    expect(unsubCopy).toHaveBeenCalledTimes(1)
  })
})

describe('ProjectServiceImpl forwards setClient to it', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../../theia/extension/src/node/project-server.ts'),
    'utf8',
  )
  it('builds one ProjectConnection over the injected registry and calls it from setClient', () => {
    expect(source).toContain('new ProjectConnection(() => this.workingRoms)')
    expect(source).toMatch(
      /setClient\(client[^)]*\): void \{\s*this\.connection\.setClient\(client\)/,
    )
  })
})

describe('ProjectConnection with the real registry', () => {
  let tmp: string
  let registry: RomRegistry
  let working: WorkingRomRegistry
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-conn-'))
    registry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
    working = new WorkingRomRegistry(registry)
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const bytes = (() => {
    const rom = new Uint8Array(0x80000)
    for (let i = 0; i < rom.length; i++) rom[i] = (i * 31) & 0xff
    rom.set(Buffer.from('SUPER MARIO WORLD  '.padEnd(21, ' '), 'ascii'), 0x7fc0)
    return rom
  })()
  const ADDR = 0x00b2ce
  const OFFSET = loromToOffset(ADDR, bytes.length, false) as number
  const oldHex = `$${(bytes[OFFSET]! | (bytes[OFFSET + 1]! << 8)).toString(16).toUpperCase().padStart(4, '0')}`

  function project(): string {
    const romPath = path.join(tmp, 'a.sfc')
    fs.writeFileSync(romPath, bytes)
    registry.register(romPath)
    return createProject({ romPath, name: 'P', directory: path.join(tmp, 'proj') }).manifestPath
  }
  const listeners = (w: WorkingRom): number =>
    (w as unknown as { listeners: Set<unknown> }).listeners.size

  it('a closed window hears no edit; its reconnected successor does', () => {
    const manifest = project()
    const conn = new ProjectConnection(() => working)
    const closed = client()
    conn.setClient(closed)
    working.get(manifest)
    conn.setClient(undefined)
    const next = client()
    conn.setClient(next)
    working.setWord(manifest, { romAddr: ADDR, oldHex, newHex: '$03E0' })
    expect(closed.onEditEvent).not.toHaveBeenCalled()
    expect(next.onEditEvent).toHaveBeenCalledTimes(1)
  })

  it('a copy the registry replaces is released, so it can be collected', () => {
    const manifest = project()
    const conn = new ProjectConnection(() => working)
    const c = client()
    conn.setClient(c)
    const first = working.get(manifest)
    if (first.status !== 'ok') throw new Error(first.status)
    expect(listeners(first.working)).toBe(1)
    // A layer lands in ops/ behind the cached copy: the next get rebuilds it.
    appendLayer(first.project.directory, {
      id: 'pulled',
      label: 'pulled',
      ops: [{ address: '$00B2CE', old: oldHex, new: '$03E0' }],
    })
    const second = working.get(manifest)
    if (second.status !== 'ok') throw new Error(second.status)
    expect(second.working).not.toBe(first.working)
    expect(listeners(first.working)).toBe(0)
    expect(listeners(second.working)).toBe(1)
  })

  it('a copy dropped by a header-flipping relocate is released too', () => {
    const manifest = project()
    const conn = new ProjectConnection(() => working)
    conn.setClient(client())
    const first = working.get(manifest)
    if (first.status !== 'ok') throw new Error(first.status)
    const headered = new Uint8Array(bytes.length + 512)
    headered.set(bytes, 512)
    const copy = path.join(tmp, 'h.smc')
    fs.writeFileSync(copy, headered)
    working.relocate(manifest, copy)
    expect(listeners(first.working)).toBe(0)
  })

  it('events reach the client typed as the edit event', () => {
    const manifest = project()
    const conn = new ProjectConnection(() => working)
    const seen: EditEvent[] = []
    conn.setClient({ onEditEvent: e => seen.push(e), onRomChanged: () => {} })
    working.setWord(manifest, { romAddr: ADDR, oldHex, newHex: '$03E0' })
    expect(seen.map(e => e.subject)).toEqual([manifest])
  })
})
