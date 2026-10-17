/**
 * The exit graph counts only screen exits the game reads (#788): a layer 1 stream that
 * never reaches $FF within the bytes getLevelRawData reads is not trusted, as for the
 * start lookup (#787). Synthetic bytes only, so no corpus is needed.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { buildMapTree } from '../../../src/rom/MapTree'
import {
  plantOverworldTiles,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'

const F800 = 0x05f800
const HEADER = [0, 0, 0, 0, 0]
const PRIMARY = [0x00, 0x01, 0x00, 0xc5] // screen exit object to $0C5
const SECONDARY = [0x00, 0x02, 0x00, 0x10] // via DATA_05F800 index $10, which names $0C5
// Where getLevelRawData stops reading (SmwRom.ts), the cap this test pins.
const READ_CAP = 0x2000

/** $001 (an overworld level) holds `body` at `ptr`; every other slot is the filler room. */
function rom(body: number[], ptr = 0x068000, fileEnd = false): RomFile {
  const file = new RomFile('mock.smc', Buffer.alloc(0x400000, 0x00))
  file.buffer[0x7fd5] = 0x20
  plantStockSubmapCode(file)
  plantOverworldTiles(file)
  for (let i = 0; i < 0x200; i++) file.writeAt(ADDR.LEVEL_L1_PTR + i * 3, [0x00, 0xf0, 0x07])
  file.writeAt(0x07f000, [...HEADER, 0xff])
  file.writeAt(F800 + 0x10, [0xc5])
  const set = (n: number, p: number) =>
    file.writeAt(ADDR.LEVEL_L1_PTR + n * 3, [p & 0xff, (p >> 8) & 0xff, p >> 16])
  set(0x001, ptr)
  if (fileEnd) {
    // The stream's last byte is the ROM's last byte; $FFxxxx is the LoROM mirror of the final bank.
    const at = file.buffer.length - HEADER.length - body.length
    file.buffer.set([...HEADER, ...body], at)
    set(0x001, 0xff8000 + (at & 0x7fff))
  } else file.writeAt(ptr, [...HEADER, ...body])
  set(0x0c5, 0x06e800)
  file.writeAt(0x06e800, [...HEADER, 0xff])
  return file
}

const graphOf = (file: RomFile) => {
  const sm = new SmwRom(file)
  const { roots } = deriveOverworldEntrances(sm, undefined, SYNTHETIC_FINGERPRINTS)
  return sm.buildLevelExitGraph(roots, SYNTHETIC_FINGERPRINTS.entry)
}
const edge = (file: RomFile) => graphOf(file).graph.get(0x001) ?? []
// A harmless 3-byte standard object (0x42), n times: plain zeros would parse as more screen exits.
const filler = (n: number) => new Array<number[]>(n).fill([0x42, 0, 0]).flat()

describe.each([
  ['primary', PRIMARY],
  ['secondary', SECONDARY],
])('buildLevelExitGraph, %s screen exit, unterminated streams (synthetic)', (_kind, exit) => {
  it('control: the terminated stream contributes its exit', () => {
    const g = graphOf(rom([...exit, 0xff]))
    expect(g.unavailable).toBeFalsy()
    expect(g.graph.get(0x001)).toEqual([0xc5])
    expect(g.unreadableExits).toEqual([])
  })

  it('an exit before the run-off point is dropped, and the slot is listed', () => {
    const g = graphOf(rom([...exit, ...filler(10)]))
    expect(edge(rom([...exit, ...filler(10)]))).toEqual([])
    expect(g.unreadableExits).toEqual([0x001])
  })

  it('an exit cut off at the end of the ROM (its extra byte missing) is dropped', () => {
    // 5 header + 3 of the exit's 4 bytes = the last 8 bytes of the file.
    const file = rom(exit.slice(0, 3), 0, true)
    expect(edge(file)).toEqual([])
  })

  it('control: a terminated stream ending on the last ROM byte keeps its exit', () => {
    const file = rom([...exit, 0xff], 0, true)
    expect(edge(file)).toEqual([0xc5])
  })

  it('a stream whose $FF lies past the read cap is dropped (pins getLevelRawData 0x2000)', () => {
    // Filler objects are 3 bytes each; the $FF sits on an object start well past the cap.
    const past = [...exit, ...filler(2800), 0xff]
    expect(5 + past.length).toBeGreaterThan(READ_CAP)
    expect(edge(rom(past))).toEqual([])
    const within = [...exit, ...filler(1000), 0xff]
    expect(5 + within.length).toBeLessThan(READ_CAP)
    expect(edge(rom(within))).toEqual([0xc5])
  })
})

it('the map tree says in plain words that a map was not read to its end', () => {
  const tree = buildMapTree(new SmwRom(rom([...PRIMARY, ...filler(10)])), SYNTHETIC_FINGERPRINTS)
  expect(tree.notes.join('\n')).toMatch(/screen exits are not shown.*\$001/)
  const clean = buildMapTree(new SmwRom(rom([...PRIMARY, 0xff])), SYNTHETIC_FINGERPRINTS)
  expect(clean.notes.join('\n')).not.toMatch(/screen exits are not shown/)
})
