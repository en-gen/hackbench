import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  getLevelMusicBankAddr,
  getOverworldMusicBankAddr,
  getCreditsMusicBankAddr,
  getLevelMusicBankAddrIfReadable,
  getBankBlockSize,
  readBankSongPointers,
} from '../../../src/rom/SpcBuilder'

const ROMS_DIR = resolve(__dirname, '../../roms')

/**
 * Pinned per-ROM, per-bank, read directly against the fixtures rather than
 * compared against another call to the same function under test. Song counts
 * are cross-checked against the disassembly's literal dw lists rather than
 * assumed from a runtime scan of any kind:
 *   overworld (Bank 1): bank_0E.asm:2359-2367, 9 entries
 *   level     (Bank 2): bank_0E.asm:3840-3868, 29 entries
 *   credits   (Bank 3): bank_03.asm:10292-10303, 12 entries
 *
 * The three AddmusicK-patched carts are the real case this project's own
 * "read the table, but check the routine which reads it still exists" rule
 * exists for: their level-music upload routine's opcode at $008147 is `E2`
 * (SEP #$20), not the vanilla LDA.B `A9` readUploadAddress assumes, so the
 * ROM address it derives is not a real block header (all four header bytes
 * are $55 filler on this corpus). Their overworld bank resolves to
 * `$85c2a5`, well outside ROM space.
 *
 * Their credits bank reads correct data even though the shared tail both
 * upload paths fall through to (StartMusicUpload) is also patched on this
 * corpus - the routine's own bytes read intact, but that is not the same
 * claim as "this path is reached at runtime" (docs/music-bank-song-table.md).
 * Included anyway: a fix that broke real data to catch fake data would not
 * show up testing only the broken banks.
 */
const EXPECTED: Record<
  string,
  {
    level: { count: number; bankRomAddr: number; readable: boolean }
    overworld: { count: number }
    credits: { count: number; bankRomAddr: number }
  }
> = {
  'Super Mario World (USA).vanilla.sfc': {
    level: { count: 29, bankRomAddr: 0x0eaed6, readable: true },
    overworld: { count: 9 },
    credits: { count: 12, bankRomAddr: 0x03e400 },
  },
  'Super Mario World (USA).magic.sfc': {
    level: { count: 29, bankRomAddr: 0x0eaed6, readable: true },
    overworld: { count: 9 },
    credits: { count: 12, bankRomAddr: 0x03e400 },
  },
  'Seven_Vanilla_Levels.sfc': {
    level: { count: 29, bankRomAddr: 0x0eaed6, readable: true },
    overworld: { count: 9 },
    credits: { count: 12, bankRomAddr: 0x03e400 },
  },
  'Grand Poo World 2 1.1.sfc': {
    level: { count: 0, bankRomAddr: 0x0eae60, readable: false },
    overworld: { count: 0 },
    credits: { count: 12, bankRomAddr: 0x03e400 },
  },
  'GrandPooWorld_V1.2.sfc': {
    level: { count: 0, bankRomAddr: 0x0eaeb0, readable: false },
    overworld: { count: 0 },
    credits: { count: 12, bankRomAddr: 0x03e400 },
  },
  'Invictus 1.0.sfc': {
    level: { count: 0, bankRomAddr: 0x0eae60, readable: false },
    overworld: { count: 0 },
    credits: { count: 12, bankRomAddr: 0x03e400 },
  },
}

describe('SpcBuilder bank song table (requires test/roms/*.sfc)', () => {
  for (const file of Object.keys(EXPECTED)) {
    const expected = EXPECTED[file]
    const present = existsSync(resolve(ROMS_DIR, file))

    // skipIf per file, not a filter over the file list: with the corpus
    // absent these cases must still be REGISTERED and reported skipped, not
    // silently cease to exist (issue #417 - CI is exactly this column).
    // vitest still calls this factory to enumerate the skipped its, so the
    // ROM is opened lazily inside each it() rather than at factory scope -
    // opening it here would throw before skipIf ever gets to skip anything.
    describe.skipIf(!present)(file, () => {
      const openRom = () => SmwRom.open(resolve(ROMS_DIR, file)).rom

      it('level bank: resolves the expected ROM address and readability', () => {
        const rom = openRom()
        expect(getLevelMusicBankAddr(rom)).toBe(expected.level.bankRomAddr)
        expect(getLevelMusicBankAddrIfReadable(rom) !== null).toBe(expected.level.readable)
      })

      it('level bank: reads the song count this fixture actually has', () => {
        const rom = openRom()
        expect(readBankSongPointers(rom, getLevelMusicBankAddr(rom))).toHaveLength(
          expected.level.count,
        )
      })

      it('overworld bank: reads the song count this fixture actually has', () => {
        const rom = openRom()
        expect(readBankSongPointers(rom, getOverworldMusicBankAddr(rom))).toHaveLength(
          expected.overworld.count,
        )
      })

      it('credits bank: resolves the expected ROM address and song count', () => {
        const rom = openRom()
        const creditsAddr = getCreditsMusicBankAddr(rom)
        expect(creditsAddr).toBe(expected.credits.bankRomAddr)
        expect(readBankSongPointers(rom, creditsAddr)).toHaveLength(expected.credits.count)
      })

      if (expected.level.count > 0) {
        it('level bank: song commands are 1-based and sequential', () => {
          const rom = openRom()
          const levelAddr = getLevelMusicBankAddr(rom)
          readBankSongPointers(rom, levelAddr).forEach((p, i) => expect(p.bgmCommand).toBe(i + 1))
        })

        it('level bank: every song pointer resolves strictly inside the bank ARAM range', () => {
          const rom = openRom()
          const levelAddr = getLevelMusicBankAddr(rom)
          const header = rom.readAt(levelAddr, 4)!
          const aramDest = header[2] | (header[3] << 8)
          const bankEnd = aramDest + getBankBlockSize(rom, levelAddr)
          for (const p of readBankSongPointers(rom, levelAddr)) {
            expect(p.aramPointer).toBeGreaterThan(aramDest)
            expect(p.aramPointer).toBeLessThan(bankEnd)
          }
        })
      }
    })
  }
})

/**
 * A synthetic bank proves the real-data boundary case the corpus cannot: a
 * cart with a genuinely large, fully-terminated table. 64 was a read-buffer
 * size in the pre-fix code that had been promoted into a correctness gate,
 * silently capping any real bank at or above it to zero.
 */
describe('SpcBuilder bank song table: synthetic large bank', () => {
  const ARAM_DEST = 0x1000

  /**
   * A block header + N sequential, self-consistent song pointers + a $0000
   * terminator, in a buffer sized generously past what readBankSongPointers
   * will ever request for the resulting blockSize (its own maxEntries cap),
   * so the read never falls off the end regardless of songCount.
   */
  function buildSyntheticRom(songCount: number): {
    readAt(addr: number, len: number): Uint8Array | null
  } {
    const tableBytes = songCount * 2
    const songDataStart = ARAM_DEST + tableBytes
    // Each song's data is 1 byte, laid out sequentially and in table order,
    // so pointer i (0-based) is songDataStart + i and the whole scan sees
    // consistently increasing, always-valid addresses, same as a real bank
    // with no interleaving.
    const size = tableBytes + songCount + 2 // + terminator word after data
    const bytes = new Uint8Array(4 + tableBytes + 4096) // generous, zero-filled tail
    bytes[0] = size & 0xff
    bytes[1] = (size >> 8) & 0xff
    bytes[2] = ARAM_DEST & 0xff
    bytes[3] = (ARAM_DEST >> 8) & 0xff
    for (let i = 0; i < songCount; i++) {
      const ptr = songDataStart + i
      bytes[4 + i * 2] = ptr & 0xff
      bytes[4 + i * 2 + 1] = (ptr >> 8) & 0xff
    }
    return {
      readAt: (addr: number, len: number) => {
        if (addr < 0 || addr + len > bytes.length) return null
        return bytes.slice(addr, addr + len)
      },
      // Flat, direct-index addressing: file offset IS the SNES address here.
      fileOffsetOf: (addr: number) => addr,
      buffer: { length: bytes.length },
    }
  }

  // Cast: readBankSongPointers only calls RomFile.readAt/fileOffsetOf/buffer,
  // so a minimal stub stands in without constructing a real RomFile from
  // bytes on disk.
  const asRom = (stub: ReturnType<typeof buildSyntheticRom>) => stub as any

  it('a 63-song table reads all 63 songs', () => {
    expect(readBankSongPointers(asRom(buildSyntheticRom(63)), 0)).toHaveLength(63)
  })

  it('a 64-song table reads all 64 songs, not zero', () => {
    expect(readBankSongPointers(asRom(buildSyntheticRom(64)), 0)).toHaveLength(64)
  })

  it('a 100-song table reads all 100 songs', () => {
    expect(readBankSongPointers(asRom(buildSyntheticRom(100)), 0)).toHaveLength(100)
  })
})

/**
 * A declared block size can overrun the ROM file itself (a corrupted or
 * unrelated header value): the read must clamp to what is actually there
 * instead of refusing the whole table outright.
 */
describe('SpcBuilder bank song table: declared size overruns the file', () => {
  it('reads the real, smaller table instead of reporting zero', () => {
    const aramDest = 0x1000
    const songCount = 20
    const tableBytes = songCount * 2
    const songDataStart = aramDest + tableBytes
    // Declared blockSize (0x4000) claims far more than the buffer actually
    // holds; only 604 bytes are present after the table start, matching the
    // scenario the fix targets.
    const declaredSize = 0x4000
    const bytes = new Uint8Array(4 + 604)
    bytes[0] = declaredSize & 0xff
    bytes[1] = (declaredSize >> 8) & 0xff
    bytes[2] = aramDest & 0xff
    bytes[3] = (aramDest >> 8) & 0xff
    for (let i = 0; i < songCount; i++) {
      const ptr = songDataStart + i
      bytes[4 + i * 2] = ptr & 0xff
      bytes[4 + i * 2 + 1] = (ptr >> 8) & 0xff
    }
    const rom = {
      readAt: (addr: number, len: number) => {
        if (addr < 0 || addr + len > bytes.length) return null
        return bytes.slice(addr, addr + len)
      },
      fileOffsetOf: (addr: number) => addr,
      buffer: { length: bytes.length },
    } as any
    expect(readBankSongPointers(rom, 0)).toHaveLength(songCount)
  })
})

/**
 * A garbage header (implausible size, pointers that never legitimately
 * terminate) must not enumerate an unbounded number of rows into the tree.
 */
describe('SpcBuilder bank song table: absolute sanity cap', () => {
  it('a constant, never-catching-up table is capped, not enumerated in full', () => {
    const aramDest = 0x1000
    const declaredSize = 0xf000 // implausibly large, but self-consistent
    const bankEnd = aramDest + declaredSize
    const bytes = new Uint8Array(4 + 0x2000)
    bytes[0] = declaredSize & 0xff
    bytes[1] = (declaredSize >> 8) & 0xff
    bytes[2] = aramDest & 0xff
    bytes[3] = (aramDest >> 8) & 0xff
    // Every slot points to the same address just inside the bank's end:
    // always in range, and minSongStart locks onto it on the very first
    // entry and never drops further, so only an absolute cap stops the scan
    // short of the buffer's own end.
    const constantPtr = bankEnd - 2
    for (let i = 0; i * 2 + 5 < bytes.length; i++) {
      bytes[4 + i * 2] = constantPtr & 0xff
      bytes[4 + i * 2 + 1] = (constantPtr >> 8) & 0xff
    }
    const rom = {
      readAt: (addr: number, len: number) => {
        if (addr < 0 || addr + len > bytes.length) return null
        return bytes.slice(addr, addr + len)
      },
      fileOffsetOf: (addr: number) => addr,
      buffer: { length: bytes.length },
    } as any
    expect(readBankSongPointers(rom, 0).length).toBeLessThanOrEqual(512)
  })
})

/**
 * Each safeguard isolated behind a fixture engineered to trigger it
 * specifically, rather than the ROM corpus's coincidental pattern: the
 * corpus's three broken carts all happen to hit the self-reference check at
 * slot 0 (issue #417), which never exercises the table-overlap check at all,
 * so a corpus sweep alone cannot prove that one is load-bearing.
 */
describe('SpcBuilder bank song table: each safeguard in isolation', () => {
  const SYNTH_ARAM_DEST = 0x1000

  function romFromBytes(bytes: Uint8Array) {
    return {
      readAt: (addr: number, len: number) => {
        if (addr < 0 || addr + len > bytes.length) return null
        return bytes.slice(addr, addr + len)
      },
      fileOffsetOf: (addr: number) => addr,
      buffer: { length: bytes.length },
    } as any
  }

  // Small enough that maxEntries (floor(size/2)) never exceeds the buffer
  // below; readBankSongPointers sizes its read from the declared block size,
  // same gotcha the real code fixes for a 64+ song bank.
  const SYNTH_SIZE = 0x20

  it("a pointer at the table's own start is rejected, not accepted", () => {
    // aramDest=SYNTH_ARAM_DEST, and slot 0 equals aramDest itself: the
    // AddmusicK-filler failure mode, where the whole "header" is one
    // repeated filler value.
    const bytes = new Uint8Array(4 + SYNTH_SIZE + 16)
    bytes[0] = SYNTH_SIZE & 0xff
    bytes[1] = (SYNTH_SIZE >> 8) & 0xff
    bytes[2] = SYNTH_ARAM_DEST & 0xff
    bytes[3] = (SYNTH_ARAM_DEST >> 8) & 0xff
    bytes[4] = SYNTH_ARAM_DEST & 0xff
    bytes[5] = (SYNTH_ARAM_DEST >> 8) & 0xff
    expect(readBankSongPointers(romFromBytes(bytes), 0)).toHaveLength(0)
  })

  it("a value inside an earlier song's own data is not counted as a further song", () => {
    // 2 real entries, then the slot a naive scan would read as a 3rd entry
    // is actually the earliest song's own data - which itself opens with a
    // word that is a plausible, in-range, non-zero ARAM pointer, exactly as
    // bank_0E.asm:3871-3874 does for the vanilla level bank.
    const song0Start = SYNTH_ARAM_DEST + 4 // right after the 2-entry table
    const song1Start = song0Start + 10
    const bytes = new Uint8Array(4 + SYNTH_SIZE + 16)
    bytes[0] = SYNTH_SIZE & 0xff
    bytes[1] = (SYNTH_SIZE >> 8) & 0xff
    bytes[2] = SYNTH_ARAM_DEST & 0xff
    bytes[3] = (SYNTH_ARAM_DEST >> 8) & 0xff
    bytes[4] = song0Start & 0xff
    bytes[5] = (song0Start >> 8) & 0xff
    bytes[6] = song1Start & 0xff
    bytes[7] = (song1Start >> 8) & 0xff
    const fakeThirdPointer = song1Start + 4
    bytes[8] = fakeThirdPointer & 0xff
    bytes[9] = (fakeThirdPointer >> 8) & 0xff
    expect(readBankSongPointers(romFromBytes(bytes), 0)).toHaveLength(2)
  })
})
