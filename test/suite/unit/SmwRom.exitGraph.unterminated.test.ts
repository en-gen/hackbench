/**
 * The exit graph counts only screen exits the game reads (#788): a layer 1 stream that
 * never reaches $FF is not trusted, as for the start lookup (#787). Synthetic bytes only.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import {
  plantOverworldTiles,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'

function rom(terminated: boolean): RomFile {
  const file = new RomFile('mock.smc', Buffer.alloc(0x400000, 0x00))
  file.buffer[0x7fd5] = 0x20
  plantStockSubmapCode(file)
  plantOverworldTiles(file)
  for (let i = 0; i < 0x200; i++) file.writeAt(ADDR.LEVEL_L1_PTR + i * 3, [0x00, 0xf0, 0x07])
  file.writeAt(0x07f000, [0, 0, 0, 0, 0, 0xff])
  const slot = (n: number, ptr: number, body: number[]) => {
    file.writeAt(ADDR.LEVEL_L1_PTR + n * 3, [ptr & 0xff, (ptr >> 8) & 0xff, ptr >> 16])
    file.writeAt(ptr, [0, 0, 0, 0, 0, ...body])
  }
  // $001 (an overworld level) has one primary exit to $0C5. Zero fill follows, so with no $FF the parse runs off the buffer.
  slot(0x001, 0x068000, [0x00, 0x01, 0x00, 0xc5, ...(terminated ? [0xff] : [])])
  slot(0x0c5, 0x06e800, [0x42, 0xff])
  return file
}

const graphOf = (file: RomFile) => {
  const sm = new SmwRom(file)
  const { roots } = deriveOverworldEntrances(sm, undefined, SYNTHETIC_FINGERPRINTS)
  return sm.buildLevelExitGraph(roots, SYNTHETIC_FINGERPRINTS.entry)
}

describe('buildLevelExitGraph and unterminated streams (synthetic)', () => {
  it('control: a terminated stream contributes its exit', () => {
    const g = graphOf(rom(true))
    expect(g.unavailable).toBeFalsy()
    expect(g.graph.get(0x001)).toContain(0xc5)
  })

  it('a stream that never reaches $FF contributes no exit', () => {
    const g = graphOf(rom(false))
    expect(g.unavailable).toBeFalsy()
    expect(g.graph.get(0x001) ?? []).not.toContain(0xc5)
  })
})
