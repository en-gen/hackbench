import { describe, it, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { exportPatch } from '../../../src/project/ExportPatch'
import { WorkingRom } from '../../../src/project/WorkingRom'
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

describe('core.export.ips', () => {
  let tmp: string
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-perf-export-'))
  })
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('synthetic', async () => {
    const base = fakeRom()
    const working = new WorkingRom(base, false)
    for (let i = 0; i < 20; i++) {
      const addr = 0x00b2ce + i * 2
      const oldWord = wordAt(base, addr)
      working.append({
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
    await perfCase('core.export.ips.synthetic', 'ms', 'lower', () => {
      exportPatch(tmp, 'PerfBench', working, 'ips')
    })
  })
})
