/**
 * Where a map is first entered (#339), on corpus ROMs. Skipped when a ROM is
 * absent (describe.skipIf); the gate and the decode are proven without one in
 * LevelStart.synthetic.test.ts. Measured on one machine, the corpus as listed
 * in docs/testing.md.
 */
import { beforeAll, describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { readLevelStart } from '../../../src/rom/LevelStart'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { freshRom, hasRom, INVICTUS, VANILLA } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('readLevelStart on the vanilla ROM', () => {
  // describe.skipIf still runs this body to collect tests, so the ROM loads in beforeAll.
  let rom: SmwRom
  beforeAll(() => {
    rom = new SmwRom(freshRom(VANILLA))
  })

  it('$109, the vertical entry map, starts on screen 6 at y 1680', () => {
    expect(readLevelStart(rom, 0x109)).toMatchObject({
      ok: true,
      kind: 'main',
      vertical: true,
      screen: 6,
      y: 1680,
    })
  })

  it('every horizontal entry map starts on the screen its own entrance names', () => {
    const maps = deriveOverworldEntrances(rom).entryMaps
    expect(maps.length).toBeGreaterThan(50)
    let horizontal = 0
    for (const m of maps) {
      const s = readLevelStart(rom, m)
      expect(s.ok, `slot ${m}`).toBe(true)
      if (!s.ok || s.vertical) continue
      horizontal++
      // The screen is X's high byte, which is DATA_05F600's low 5 bits (bank_05.asm:7382).
      expect(s.screen, `slot ${m}`).toBe(rom.rom.readByte(0x05f600 + m)! & 0x1f)
      expect(s.x >> 8).toBe(s.screen)
    }
    expect(horizontal).toBeGreaterThan(30)
  })

  it('a sub area one primary exit from the overworld starts on its own main entrance', () => {
    // $007 exits straight to $0E6 (a primary exit); $0E6 is not an entry map.
    const s = readLevelStart(rom, 0x0e6)
    expect(s).toMatchObject({ ok: true, kind: 'main', hops: 1, vertical: false })
    expect(s.ok && s.screen).toBe(rom.rom.readByte(0x05f600 + 0xe6)! & 0x1f)
  })

  it('a map no overworld tile or screen exit leads to is unavailable, with a reason', () => {
    // $0C5 is the new-game intro slot: entered by the game, not by a tile or an exit.
    const s = readLevelStart(rom, 0x0c5)
    expect(s.ok).toBe(false)
    expect(!s.ok && s.reason).toMatch(/No overworld tile or screen exit/)
  })
})

describe.skipIf(!hasRom(INVICTUS))('readLevelStart on a hack', () => {
  it('is unavailable with a plain-words reason, and gives no vanilla answer', () => {
    const s = readLevelStart(new SmwRom(freshRom(INVICTUS)), 0x109)
    expect(s.ok).toBe(false)
    expect(!s.ok && s.reason).toMatch(/replaces the game's level entrance code/)
  })
})
