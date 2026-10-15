import { describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../../src/rom/ReadMapEntrances', () => ({
  // Each call returns a map whose single value records which read produced it.
  readMapEntrances: () => new Map([[0, { read: ++reads.count }]]),
}))

import { RomFile } from '../../../../src/rom/RomFile'
import { entrancesFor } from '../../../../src/rom/model/MapBuilder'
import type { SmwRom } from '../../../../src/rom/SmwRom'

// Synthetic: no ROM. The graph reader is stubbed; what is under test is the cache around it.
describe('MapBuilder entrances cache', () => {
  it('reads once per ROM version and again after a writeAt', () => {
    const file = new RomFile('c.sfc', Buffer.alloc(0x80000, 0))
    const rom = { rom: file } as unknown as SmwRom
    const first = entrancesFor(rom, {})
    expect(entrancesFor(rom, {})).toBe(first)
    expect(reads.count).toBe(1)

    file.writeAt(0x8000, [1])
    const second = entrancesFor(rom, {})
    expect(second).not.toBe(first)
    expect(reads.count).toBe(2)
  })

  it('an explicit entrances override bypasses the cache', () => {
    const file = new RomFile('c.sfc', Buffer.alloc(0x80000, 0))
    const rom = { rom: file } as unknown as SmwRom
    expect(entrancesFor(rom, { entrances: undefined })).toBeUndefined()
  })
})
