import * as path from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import { ADDR, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { OVERWORLD_ENTRY, OVERWORLD_INDEX_BODY, SCREEN_EXIT } from '../../../src/rom/SubmapFlagGate'
import { OW_ADDR } from '../../../src/rom/OverworldLoader'
import {
  WALK_PROLOGUE_LENGTH,
  type OverworldFingerprints,
} from '../../../src/rom/OverworldEntrances'
import { fingerprint } from '../../../src/rom/Fingerprint'

// 512 KB: `size % 1024 !== 512`, so RomFile reads no copier header (+512).
// Large enough to reach bank $0C, where the overworld tile stream lives.
const BUF_SIZE = 0x80000

// Stamped into the raw buffer before RomFile exists: RomFile picks its
// addressing mode from this byte in its constructor, and every writeAt below
// depends on that choice.
const MAP_MODE_OFFSET = 0x7fd5

// Shared by every unclaimed slot. SmwRom's filler heuristic needs a pointer
// repeated 10+ times, and the hundreds left over put that beyond doubt.
const FILLER_PTR = 0x038000

const FIRST_ROOM_PTR = 0x018000
const ROOM_STRIDE = 0x100

const NOP = 0xea
const nops = (length: number): Buffer => Buffer.alloc(length, NOP)

/**
 * The fingerprinted spans are vanilla code and never committed (CLAUDE.md),
 * so a synthetic ROM fills them with NOPs. Pass this to the reader under test;
 * the stock defaults refuse it.
 */
export const SYNTHETIC_FINGERPRINTS: OverworldFingerprints = Object.freeze({
  entry: Object.freeze([fingerprint(nops(OVERWORLD_INDEX_BODY.length))!]),
  walk: Object.freeze([fingerprint(nops(WALK_PROLOGUE_LENGTH))!]),
})

/**
 * The stock code SubmapFlagGate and OverworldEntrances check, at vanilla's
 * addresses, so a synthetic image is not declined. Tests that must catch a
 * wrong constant plant their own bytes at literal addresses instead.
 */
export function plantStockSubmapCode(rom: RomFile): void {
  for (const c of [...OVERWORLD_ENTRY, ...SCREEN_EXIT]) {
    if ('fingerprints' in c) rom.writeAt(c.addr, nops(c.length))
    else rom.writeAt(c.addr, [...c.bytes])
  }
  rom.writeAt(0x05d8a2, [0xc9, 0x25, 0x90, 0x03, 0x38, 0xe9, 0x24])
  rom.writeAt(0x05d8b4, [0x01])
  rom.writeAt(0x05d7d1, [0x01])
  // CODE_04DC09's call, CODE_04D7F2's prologue and walk, OWPU_ABXY. Operands
  // nothing reads (and the tile-range floor, $50 here) differ from vanilla, so
  // no run of vanilla bytes longer than 32 is committed.
  rom.writeAt(0x04dc57, [0xa9, 0xff, 0x07, 0xa2, 0xdf, 0xf7, 0xa0, 0x00, 0xc8])
  rom.writeAt(0x04dc60, [0x54, 0x7e, 0x0c, 0xab, 0x20, 0xf2, 0xd7, 0xe2, 0x30, 0x6b])
  rom.writeAt(0x04d7f2, nops(WALK_PROLOGUE_LENGTH))
  rom.writeAt(0x04d81d, [0xa0, 0x01, 0xff, 0x84, 0x00, 0xa0, 0xff, 0x07, 0xa9, 0x00, 0x97])
  rom.writeAt(0x04d828, [0x0a, 0x97, 0x0d, 0x88, 0x10, 0xf9, 0xa0, 0x00, 0x00, 0xbb])
  rom.writeAt(0x04d832, [0xb7, 0x04, 0xc9, 0x50, 0x90, 0x11, 0xc9, 0x81, 0xb0, 0x0d])
  rom.writeAt(0x04d83c, [0xa5, 0x00, 0x97, 0x0d, 0xaa, 0xbf, 0x00, 0x00, 0x00, 0x97])
  rom.writeAt(0x04d846, [0x0a, 0xe6, 0x00, 0xc8, 0xc0, 0x00, 0x08, 0xd0, 0xe3])
  rom.writeAt(0x049132, [0xa5, 0x16, 0x29, 0x20, 0x80, 0x09])
  rom.writeAt(0x049141, [0xa5, 0x17, 0x29, 0x30, 0xc9, 0x30, 0xd0, 0x07, 0xad, 0xc1, 0x13])
  rom.writeAt(0x04914c, [0xc9, 0x81, 0xf0, 0x00])
  rom.writeAt(0x049150, [0xa5, 0x16, 0x05, 0x18, 0x29, 0xc0, 0xd0, 0x03, 0x82, 0x00, 0x00])
  rom.writeAt(0x04915b, [0x9c, 0x9e, 0x1b, 0xad, 0xc1, 0x13, 0xc9, 0x5f, 0xd0, 0x18])
  rom.writeAt(0x04917d, [0xad, 0xc1, 0x13, 0xc9, 0x82, 0xf0, 0x04, 0xc9, 0x5b, 0xd0, 0x11])
}

/**
 * $24 main-map and 28 sub-map launch tiles: with the stock bias the derived
 * ranges are $000-$024 and $101-$11C, past any submap root a test names and
 * short of any submap destination ($140 and up).
 */
export function plantOverworldTiles(rom: RomFile): void {
  for (let i = 0; i < 0x24; i++) rom.writeAt(OW_ADDR.L1_TILEDATA + i, [0x6e])
  for (let i = 0; i < 28; i++) rom.writeAt(OW_ADDR.L1_TILEDATA + 0x400 + i, [0x6e])
}

const ptrBytes = (ptr: number): number[] => [ptr & 0xff, (ptr >> 8) & 0xff, (ptr >> 16) & 0xff]

/**
 * Writes a synthetic LoROM image whose exit graph is exactly `rooms`, keyed by
 * pointer-table index, and returns the path of the written file.
 *
 * Nintendo owns every byte of a real ROM, so tests build their own. Only the
 * structures `SmwRom.buildLevelExitGraph` reads are present: the map-mode byte,
 * the stock submap-flag BEQs, the Layer-1 pointer table, and one object stream
 * per room.
 */
export function writeSyntheticRom(dir: string, rooms: Map<number, number[]>): string {
  const buf = Buffer.alloc(BUF_SIZE, 0)
  buf[MAP_MODE_OFFSET] = 0x20

  const file = path.join(dir, 'synthetic.sfc')
  const rom = new RomFile(file, buf)
  rom.writeAt(ADDR.ROM_NAME, Buffer.from('HACKBENCH SYNTHETIC  ', 'ascii'))
  plantStockSubmapCode(rom)
  plantOverworldTiles(rom)

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
