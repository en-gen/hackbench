import { describe, it } from 'vitest'
import { WorkingRom, Layer } from '../../../src/project/WorkingRom'
import { loromToOffset } from '../../../src/rom/addressing'
import { perfCase } from '../support/perfCase'

function fakeRom(size = 0x80000): Uint8Array {
  const rom = new Uint8Array(size)
  for (let i = 0; i < size; i++) rom[i] = (i * 31) & 0xff
  return rom
}

function wordAt(rom: Uint8Array, addr: number): number {
  const offset = loromToOffset(addr, rom.length, false) as number
  return rom[offset] | (rom[offset + 1] << 8)
}

const hex = (n: number): string => `$${n.toString(16).toUpperCase().padStart(4, '0')}`

// N distinct, non-overlapping word edits starting at Mario's palette address,
// so each layer's "old" value matches the base ROM and none stale each other.
function layersOver(base: Uint8Array, count: number): Layer[] {
  const layers: Layer[] = []
  for (let i = 0; i < count; i++) {
    const addr = 0x00b2ce + i * 2
    const oldWord = wordAt(base, addr)
    layers.push({
      id: `L${i}`,
      label: `L${i}`,
      scope: 'edit',
      ops: [
        {
          address: `$${addr.toString(16).toUpperCase()}`,
          old: hex(oldWord),
          new: hex((oldWord + 1) & 0x7fff),
        },
      ],
    })
  }
  return layers
}

describe('core.workingcopy.build', () => {
  it('synthetic-10layers', async () => {
    const base = fakeRom()
    const layers = layersOver(base, 10)
    await perfCase('core.workingcopy.build.synthetic-10layers', 'ms', 'lower', () => {
      const working = new WorkingRom(base, false)
      for (const layer of layers) working.append(layer)
      working.bytes()
    })
  })

  it('synthetic-100layers', async () => {
    const base = fakeRom()
    const layers = layersOver(base, 100)
    await perfCase('core.workingcopy.build.synthetic-100layers', 'ms', 'lower', () => {
      const working = new WorkingRom(base, false)
      for (const layer of layers) working.append(layer)
      working.bytes()
    })
  })
})
