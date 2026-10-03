import { describe, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { WorkingRom, Layer } from '../../../src/project/WorkingRom'
import { exportPatch } from '../../../src/project/ExportPatch'
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
// Shared by every case below: working-copy build and IPS export both need
// "N edit layers over a base ROM".
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
  const base10 = fakeRom()
  const layers10 = layersOver(base10, 10)
  perfCase('core.workingcopy.build.synthetic-10layers', () => {
    const working = new WorkingRom(base10, false)
    for (const layer of layers10) working.append(layer)
    working.bytes()
  })

  const base100 = fakeRom()
  const layers100 = layersOver(base100, 100)
  perfCase('core.workingcopy.build.synthetic-100layers', () => {
    const working = new WorkingRom(base100, false)
    for (const layer of layers100) working.append(layer)
    working.bytes()
  })
})

describe('core.export.ips', () => {
  let tmp: string
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-perf-export-'))
  })
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const base = fakeRom()
  const working = new WorkingRom(base, false)
  for (const layer of layersOver(base, 20)) working.append(layer)
  perfCase('core.export.ips.synthetic', () => exportPatch(tmp, 'PerfBench', working, 'ips'))
})
