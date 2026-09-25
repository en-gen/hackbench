/**
 * Every seeded slot must actually be a top-level map on the vanilla cart, and
 * the ROM's own name for it must belong to its group: the seed table was
 * read from the overworld name table (see the spec), so this is what proves
 * it still matches the cart rather than a stale transcription.
 *
 * Names below were read directly from this corpus's vanilla ROM (not
 * guessed or taken from a published list, per docs/glossary.md's rule).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildMapTree } from '../../../src/rom/MapTree'
import { createProject, romIdentity } from '../../../src/project/Project'
import { VANILLA_SEED, VANILLA_SHA256, seedIfVanilla } from '../../../src/project/MapGroups'
import { freshRom, hasRom, VANILLA, MAGIC } from '../support/corpus'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/** Groups whose maps all carry a common word; checked as a substring. */
const NAME_CONTAINS: Record<string, string> = {
  "1. Yoshi's Island": "YOSHI'S",
  '2. Donut Plains': 'DONUT',
  '3. Vanilla Dome': 'VANILLA',
  '5. Forest of Illusion': 'FOREST',
  '6. Chocolate Island': 'CHOCO',
  '8. Star World': 'STAR WORLD',
}

/**
 * Exact names for slots whose group membership is not spelled out in the
 * name (castles, switch palaces, bridges, doors, the ghost ship, Special
 * Zone's level titles). Covers Twin Bridges, Special Zone, and the
 * non-conforming members of Yoshi's Island / Donut Plains / Vanilla Dome /
 * Forest of Illusion / Chocolate Island / Valley of Bowser.
 */
const EXACT_NAME: Record<number, string> = {
  0x101: "#1 IGGY'S CASTLE",
  0x014: 'YELLOW SWITCH PALACE',
  0x007: "#2 MORTON'S CASTLE",
  0x008: 'GREEN SWITCH PALACE',
  0x003: 'TOP SECRET AREA',
  0x11c: "#3 LEMMY'S CASTLE",
  0x11b: 'RED SWITCH PALACE',
  0x00f: 'CHEESE BRIDGE AREA',
  0x010: 'COOKIE MOUNTAIN',
  0x00c: 'BUTTER BRIDGE 1',
  0x00d: 'BUTTER BRIDGE 2',
  0x011: 'SODA LAKE',
  0x00e: "#4 LUDWIG'S CASTLE",
  0x020: "#5 ROY'S CASTLE",
  0x121: 'BLUE SWITCH PALACE',
  0x01a: "#6 WENDY'S CASTLE",
  0x110: "#7 LARRY'S CASTLE",
  0x10d: 'FRONT DOOR',
  0x10e: 'BACK DOOR',
  0x018: 'SUNKEN GHOST SHIP',
  0x12a: 'GNARLY',
  0x12b: 'TUBULAR',
  0x12c: 'WAY COOL',
  0x12d: 'AWESOME',
  0x128: 'GROOVY',
  0x127: 'MONDO',
  0x126: 'OUTRAGEOUS',
  0x125: 'FUNKY',
}

describe.skipIf(!hasRom(VANILLA))('MapGroups seed table (vanilla corpus)', () => {
  // Loaded in beforeAll: a skipped describe's body still runs at collection,
  // and CI has no ROM.
  let rom: SmwRom
  let topLevel: Set<number>
  beforeAll(() => {
    rom = new SmwRom(freshRom(VANILLA))
    topLevel = new Set(buildMapTree(rom).overworld.map(n => n.index))
  })

  for (const group of VANILLA_SEED) {
    const expectedSubstring = NAME_CONTAINS[group.name]
    for (const slot of group.slots) {
      const hex = `$${slot.toString(16).toUpperCase().padStart(3, '0')}`
      it(`${group.name} ${hex} is a top-level entry map, named by the ROM`, () => {
        expect(topLevel.has(slot)).toBe(true)
        const name = rom.getLevelName(slot)
        expect(name).not.toBeNull()
        const exact = EXACT_NAME[slot]
        if (exact) expect(name).toBe(exact)
        else if (expectedSubstring) expect(name).toContain(expectedSubstring)
      })
    }
  }

  // $017 and $019 hold a leftover name and were deliberately left ungrouped
  // (see the spec). Measured on this corpus: $017 IS a top-level map in
  // buildMapTree (its own root, unreached by any launch tile); $019 is not
  // top-level at all. Asserted as measured, not as originally guessed.
  it('$017 is a top-level map (unreached by a launch tile, not grouped)', () => {
    expect(topLevel.has(0x017)).toBe(true)
  })
  it('$019 is not a top-level map', () => {
    expect(topLevel.has(0x019)).toBe(false)
  })
})

describe.skipIf(!hasRom(MAGIC))('the Lunar Magic resave seeds exactly like vanilla', () => {
  // Proves the header-stripped identity the spec relies on: a copier-headered
  // resave of the same cart must hash to the same sha256 as the headerless
  // original, which is what makes ONE hash safe to gate seeding on.
  it('has the same header-stripped sha256 as vanilla, and it is VANILLA_SHA256', () => {
    const vanillaId = romIdentity(freshRom(VANILLA).buffer)
    const magicId = romIdentity(freshRom(MAGIC).buffer)
    expect(magicId.sha256).toBe(vanillaId.sha256)
    expect(magicId.sha256).toBe(VANILLA_SHA256)
  })

  it('seeds the magic.sfc copy the same as vanilla', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-magic-'))
    try {
      const romFile = path.join(tmp, 'magic.sfc')
      fs.writeFileSync(romFile, freshRom(MAGIC).buffer)
      const project = createProject({
        romPath: romFile,
        name: 'Hack',
        directory: path.join(tmp, 'Hack'),
      })
      const result = seedIfVanilla(project.manifestPath, project.baseRom)
      expect(result).toEqual(VANILLA_SEED)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
