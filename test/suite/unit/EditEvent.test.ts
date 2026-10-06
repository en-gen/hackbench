/**
 * The edit event (#576): one CloudEvents-shaped envelope, built in one place
 * (WorkingCopyNotifier) from the layer a WorkingRom change carries. Synthetic
 * ROMs only: CI has no ROM. Every case asserts a COUNT or an exact payload, so
 * a notifier that never fires, or fires twice, fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import { Layer, WorkingRom } from '../../../src/project/WorkingRom'
import { EditEvent, buildEditEvent, coalesceRanges, domainOf } from '../../../src/project/EditEvent'
import { FULL_WORD_MASK } from '../../../src/rom/PaletteOp'
import { loromToOffset } from '../../../src/rom/addressing'
import {
  WorkingCopyClient,
  WorkingCopyNotifier,
} from '../../../theia/extension/src/node/working-copy-notifier'

describe('coalesceRanges', () => {
  it('sorts, and merges overlapping and touching ranges but not separated ones', () => {
    expect(
      coalesceRanges([
        { start: 10, end: 12 },
        { start: 2, end: 4 },
        { start: 4, end: 6 },
        { start: 11, end: 14 },
      ]),
    ).toEqual([
      { start: 2, end: 6 },
      { start: 10, end: 14 },
    ])
  })

  it('does not mutate its input and returns [] for none', () => {
    const input = [{ start: 4, end: 6 }]
    coalesceRanges(input)
    expect(input).toEqual([{ start: 4, end: 6 }])
    expect(coalesceRanges([])).toEqual([])
  })
})

describe('buildEditEvent', () => {
  it('fills the CloudEvents envelope and names the subject', () => {
    const at = new Date('2026-10-06T12:00:00Z')
    const e = buildEditEvent({
      manifestPath: '/p.hbproj',
      applied: true,
      domain: 'palette',
      ranges: [{ start: 1, end: 3 }],
      id: 'fixed',
      time: at,
    })
    expect(e).toEqual({
      specversion: '1.0',
      id: 'fixed',
      source: 'urn:hackbench:working-copy',
      type: 'hackbench.edit.applied',
      subject: '/p.hbproj',
      time: '2026-10-06T12:00:00.000Z',
      datacontenttype: 'application/json',
      data: { domain: 'palette', ranges: [{ start: 1, end: 3 }] },
    })
  })

  it('reverted maps to its own type, and two events never share an id', () => {
    const args = { manifestPath: '/p', domain: 'map16' as const, ranges: [] }
    const a = buildEditEvent({ ...args, applied: false })
    const b = buildEditEvent({ ...args, applied: false })
    expect(a.type).toBe('hackbench.edit.reverted')
    expect(a.id).not.toBe(b.id)
  })
})

describe('domainOf', () => {
  const word = (mask?: number): Layer => ({
    id: 'l',
    label: 'l',
    ops: [{ address: '$00B2CE', old: '$0000', new: '$0001', mask }],
  })
  it('a full-word write is Map16, a colour write (no mask) is palette', () => {
    expect(domainOf(word(FULL_WORD_MASK))).toBe('map16')
    expect(domainOf(word())).toBe('palette')
  })
})

let tmp: string
let registry: RomRegistry
let working: WorkingRomRegistry

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-editevt-'))
  registry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
  working = new WorkingRomRegistry(registry)
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function fakeRom(): Uint8Array {
  const rom = new Uint8Array(0x80000)
  for (let i = 0; i < rom.length; i++) rom[i] = (i * 31) & 0xff
  rom.set(Buffer.from('SUPER MARIO WORLD  '.padEnd(21, ' '), 'ascii'), 0x7fc0)
  return rom
}

const ADDR = 0x00b2ce
const OFFSET = loromToOffset(ADDR, 0x80000, false) as number

function word(bytes: Uint8Array, offset: number): string {
  const w = bytes[offset] | (bytes[offset + 1] << 8)
  return `$${w.toString(16).toUpperCase().padStart(4, '0')}`
}

/** A project on a synthetic ROM, watched by a notifier whose client records every event. */
function watched(): { manifest: string; events: EditEvent[]; bytes: Uint8Array } {
  const bytes = fakeRom()
  const romPath = path.join(tmp, 'a.sfc')
  fs.writeFileSync(romPath, bytes)
  registry.register(romPath)
  const manifest = createProject({
    romPath,
    name: 'P',
    directory: path.join(tmp, 'proj'),
  }).manifestPath
  const r = working.get(manifest)
  if (r.status !== 'ok') throw new Error(r.status)
  const events: EditEvent[] = []
  const notifier = new WorkingCopyNotifier<WorkingCopyClient>()
  notifier.setClient({ onEditEvent: e => events.push(e) })
  // As ProjectServiceImpl.setClient wires it: every copy, existing or built later.
  working.onWorkingCopy((m, w) => notifier.watch(m, w))
  return { manifest, events, bytes }
}

describe('the notifier fires the edit event', () => {
  it('once per setWord, as applied, with the palette domain and the word range', () => {
    const { manifest, events, bytes } = watched()
    const edit = { romAddr: ADDR, oldHex: word(bytes, OFFSET), newHex: '$03E0' }
    expect(working.setWord(manifest, edit).status).toBe('ok')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'hackbench.edit.applied',
      subject: manifest,
      data: { domain: 'palette', ranges: [{ start: OFFSET, end: OFFSET + 2 }] },
    })
  })

  it('a Map16 word write (full mask) reports the map16 domain', () => {
    const { manifest, events, bytes } = watched()
    const r = working.get(manifest)
    if (r.status !== 'ok') throw new Error(r.status)
    r.working.append({
      id: 'm',
      label: 'm',
      ops: [{ address: '$00B2CE', old: word(bytes, OFFSET), new: '$8001', mask: FULL_WORD_MASK }],
    })
    expect(events.map(e => [e.type, e.data?.domain])).toEqual([['hackbench.edit.applied', 'map16']])
  })

  it('adjacent ops of one layer coalesce into one range', () => {
    const { manifest, events, bytes } = watched()
    const r = working.get(manifest)
    if (r.status !== 'ok') throw new Error(r.status)
    r.working.append({
      id: 'two',
      label: 'two',
      ops: [
        { address: '$00B2CE', old: word(bytes, OFFSET), new: '$0001' },
        { address: '$00B2D0', old: word(bytes, OFFSET + 2), new: '$0002' },
      ],
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.data?.ranges).toEqual([{ start: OFFSET, end: OFFSET + 4 }])
  })

  it('undo fires reverted with the undone layer ranges; redo fires applied again', () => {
    const { manifest, events, bytes } = watched()
    working.setWord(manifest, { romAddr: ADDR, oldHex: word(bytes, OFFSET), newHex: '$03E0' })
    working.undo(manifest)
    working.redo(manifest)
    const range = { start: OFFSET, end: OFFSET + 2 }
    expect(events.map(e => e.type)).toEqual([
      'hackbench.edit.applied',
      'hackbench.edit.reverted',
      'hackbench.edit.applied',
    ])
    expect(events.map(e => e.data?.ranges)).toEqual([[range], [range], [range]])
  })

  it('a copy built AFTER the subscription is watched too (first use by another service)', () => {
    const bytes = fakeRom()
    const romPath = path.join(tmp, 'a.sfc')
    fs.writeFileSync(romPath, bytes)
    registry.register(romPath)
    const manifest = createProject({
      romPath,
      name: 'P',
      directory: path.join(tmp, 'late'),
    }).manifestPath
    const events: EditEvent[] = []
    const notifier = new WorkingCopyNotifier<WorkingCopyClient>()
    notifier.setClient({ onEditEvent: e => events.push(e) })
    working.onWorkingCopy((m, w) => notifier.watch(m, w)) // nothing cached yet
    working.setWord(manifest, { romAddr: ADDR, oldHex: word(bytes, OFFSET), newHex: '$03E0' })
    expect(events).toHaveLength(1)
  })

  it('a refused edit (stale old value) fires nothing', () => {
    const { manifest, events } = watched()
    const stale = { romAddr: ADDR, oldHex: '$FFFF', newHex: '$03E0' }
    expect(working.setWord(manifest, stale).status).toBe('stale')
    expect(events).toEqual([])
  })

  it('a client-less or closed notifier sends nothing', () => {
    const w = new WorkingRom(fakeRom(), false)
    const events: EditEvent[] = []
    const notifier = new WorkingCopyNotifier<WorkingCopyClient>()
    notifier.watch('/p', w) // no client yet
    w.append({
      id: 'a',
      label: 'a',
      ops: [{ address: '$00B2CE', old: word(fakeRom(), OFFSET), new: '$0001' }],
    })
    expect(events).toEqual([])
  })
})
