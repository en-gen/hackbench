import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  deriveOverworldEntrances,
  TRANSLEVEL_TILE_MIN,
  TRANSLEVEL_TILE_MAX,
  STAR_WARP_TILE,
  PIPE_WARP_TILE,
} from '../../../src/rom/OverworldEntrances'

const P = [
  path.join(os.homedir(), 'OneDrive', 'hackbench-fixtures', 'Super Mario World (USA).vanilla.sfc'),
  path.join(os.homedir(), 'Super Mario World (USA).vanilla.sfc'),
].find(existsSync)

// CODE_04DC09 (bank_04.asm:5637) MVN-copies OWL1TileData from $0CF7DF, $800 bytes.
const OWL1_TILE_DATA = 0x0cf7df
const BUF_LEN = 0x800

describe.skipIf(!P)('launch tile count, direct scan', () => {
  it('counts bytes in [$56,$80] the way CODE_04D7F2 does', () => {
    const rom = SmwRom.open(P!)
    const buf = rom.rom.readAt(OWL1_TILE_DATA, BUF_LEN)!
    const hist = new Map<number, number>()
    let count = 0
    for (let i = 0; i < BUF_LEN; i++) {
      const b = buf[i]
      if (b >= TRANSLEVEL_TILE_MIN && b <= TRANSLEVEL_TILE_MAX) {
        count++
        hist.set(b, (hist.get(b) ?? 0) + 1)
      }
    }
    const mainHalf = Array.from({ length: 0x400 }, (_, i) => buf[i]).filter(
      b => b >= TRANSLEVEL_TILE_MIN && b <= TRANSLEVEL_TILE_MAX,
    ).length

    const index = deriveOverworldEntrances(rom)
    console.log(`direct scan of OWL1TileData ($0CF7DF, $800 bytes)`)
    console.log(
      `  bytes in [$${TRANSLEVEL_TILE_MIN.toString(16)},$${TRANSLEVEL_TILE_MAX.toString(16)}] : ${count}`,
    )
    console.log(`    main-map half ($000-$3FF) : ${mainHalf}`)
    console.log(`    sub-map half  ($400-$7FF) : ${count - mainHalf}`)
    console.log(`  deriveOverworldEntrances     : ${index.entrances.length}`)
    console.log(
      `  star warp tiles ($${STAR_WARP_TILE.toString(16)})       : ${hist.get(STAR_WARP_TILE) ?? 0}`,
    )
    console.log(
      `  pipe warp tiles ($${PIPE_WARP_TILE.toString(16)})       : ${hist.get(PIPE_WARP_TILE) ?? 0}`,
    )
    console.log(
      `  distinct tile values used   : ${[...hist.keys()]
        .sort((a, b) => a - b)
        .map(v => '$' + v.toString(16).toUpperCase())
        .join(' ')}`,
    )
    console.log(
      `  histogram                   : ${[...hist.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([k, v]) => '$' + k.toString(16).toUpperCase() + 'x' + v)
        .join(' ')}`,
    )
    expect(count).toBe(index.entrances.length)
  })
})
