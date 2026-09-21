import * as path from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import { ADDR, LEVEL_COUNT } from '../../../src/rom/SmwRom'

// 256 KB: `size % 1024 !== 512`, so RomFile reads no copier header (+512).
const BUF_SIZE = 0x40000

// Stamped into the raw buffer before RomFile exists: RomFile picks its
// addressing mode from this byte in its constructor, and every writeAt below
// depends on that choice.
const MAP_MODE_OFFSET = 0x7fd5

// Shared by every unclaimed slot. SmwRom's filler heuristic needs a pointer
// repeated 10+ times, and the hundreds left over put that beyond doubt.
const FILLER_PTR = 0x038000

const FIRST_ROOM_PTR = 0x018000
const ROOM_STRIDE = 0x100

const ptrBytes = (ptr: number): number[] => [ptr & 0xff, (ptr >> 8) & 0xff, (ptr >> 16) & 0xff]

/**
 * Writes a synthetic LoROM image whose exit graph is exactly `rooms`, keyed by
 * pointer-table index, and returns the path of the written file.
 *
 * Nintendo owns every byte of a real ROM, so tests build their own. Only the
 * structures `SmwRom.buildLevelExitGraph` reads are present: the map-mode byte,
 * the Layer-1 pointer table, and one object stream per room.
 */
export function writeSyntheticRom(dir: string, rooms: Map<number, number[]>): string {
  const buf = Buffer.alloc(BUF_SIZE, 0)
  buf[MAP_MODE_OFFSET] = 0x20

  const file = path.join(dir, 'synthetic.sfc')
  const rom = new RomFile(file, buf)
  rom.writeAt(ADDR.ROM_NAME, Buffer.from('HACKBENCH SYNTHETIC  ', 'ascii'))

  // The filler room terminates before its first object, so `levelHasObjects`
  // rejects it and no unclaimed slot can become a level or an exit target.
  rom.writeAt(FILLER_PTR + 5, [0xff])
  for (let i = 0; i < LEVEL_COUNT; i++) {
    rom.writeAt(ADDR.LEVEL_L1_PTR + i * 3, ptrBytes(FILLER_PTR))
  }

  let slot = 0
  for (const [index, destinations] of rooms) {
    // classifyLevels drops a slot whose pointer it has already seen, so every
    // room needs its own address.
    const ptr = FIRST_ROOM_PTR + slot++ * ROOM_STRIDE
    rom.writeAt(ADDR.LEVEL_L1_PTR + index * 3, ptrBytes(ptr))

    const body: number[] = []
    // `levelHasObjects` rejects a room whose first byte is $FF: leaves need one.
    if (destinations.length === 0) body.push(0x00, 0x10, 0x01)

    for (const dest of destinations) {
      // An exit carries only the low byte; buildLevelExitGraph re-adds bit 8
      // from the reaching root's submap flag, so this edge is unreachable.
      if ((dest & 0x100) !== (index & 0x100)) {
        throw new Error(`$${index.toString(16)} -> $${dest.toString(16)} crosses the submap flag`)
      }
      // Extended object $00, settings 0, byte 1 of 0: a primary screen exit,
      // so the trailing byte is the destination low byte (see the screen-exit
      // branch of LevelParser.parseLevelObjects).
      body.push(0x00, 0x00, 0x00, dest & 0xff)
    }
    body.push(0xff)

    // The 5-byte level header stays zeroed: level mode 0.
    rom.writeAt(ptr + 5, body)
  }

  rom.saveAs(file)
  return file
}
