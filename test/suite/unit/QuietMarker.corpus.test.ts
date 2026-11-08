/**
 * The quiet marker on the vanilla ROM (#1011): what the game's own loader routes away from the sprite slots shows the
 * quiet marker, never the failure box. ROM-gated; the synthetic cases are in QuietMarker.test.ts.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import { parseLevelSprites } from '../../../src/rom/LevelParser'
import { instructionLength } from '../../../src/rom/dispatch/HandlerWalk'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { quietText } from '../../../theia/extension/src/browser/sprite-props'
import { loadClasses, type LoadClass } from '../../../src/rom/sprites/interp/LoadClass'
import { MAGIC, VANILLA, freshRom, hasRom, romPath } from '../support/corpus'
import { slow } from '../support/loadTimeout'

describe.skipIf(!hasRom(VANILLA))('quiet marker on the vanilla ROM', () => {
  const bytes = new Uint8Array(hasRom(VANILLA) ? readFileSync(romPath(VANILLA)) : 0)
  /** The sprites the node service serves for one vanilla map, or a failure. */
  const get = (map: number) => {
    const r = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), map)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    return r.sprites
  }

  it(
    '$C9 on $126 is the quiet marker with the shooter words, not the framed id box',
    slow(60_000),
    () => {
      const c9 = get(0x126).filter(s => s.id === 0xc9)
      expect(c9.length).toBe(16)
      for (const s of c9) {
        expect(s).toMatchObject({ status: 'quiet', kind: 'shooter', name: 'Bullet Bill Shooter' })
        expect(quietText(s)).toBe(
          'Bullet Bill Shooter: fires on a timer; nothing is drawn until it does',
        )
        expect(quietText(s)).not.toMatch(/OAM|pass/i)
      }
    },
  )

  it(
    'every quiet marker on $10A and $126 draws at priority 3, above any tile (no ids named: #1132 draws some)',
    slow(60_000),
    () => {
      const quiet = [...get(0x10a), ...get(0x126)].filter(s => s.status === 'quiet')
      expect(quiet.length).toBeGreaterThan(0)
      for (const s of quiet)
        expect(Array.from(Buffer.from(s.priority!, 'base64')).every(p => p === 3)).toBe(true)
    },
  )
  it(
    'every scroll command $E7-$FF placed on a vanilla map is the quiet marker, named as a scroll command',
    slow(120_000),
    () => {
      // The maps are found from the sprite streams alone (cheap), then each is served for real.
      const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(bytes)))
      const maps: number[] = []
      for (let m = 0; m < 0x200; m++) {
        const ptr = rom.getLevelSpritePointer(m)
        const data = ptr === null ? null : rom.rom.readUpTo(ptr, 0x200)
        if (data && parseLevelSprites(data, false).some(s => s.spriteId >= 0xe7)) maps.push(m)
      }
      expect(maps.length).toBeGreaterThan(3)
      const scroll = maps.flatMap(m => get(m).filter(s => s.id >= 0xe7))
      expect(scroll.length).toBeGreaterThan(5)
      expect(scroll.filter(s => s.status !== 'quiet' || s.kind !== 'scroll')).toEqual([])
      expect(new Set(scroll.map(quietText))).toEqual(
        new Set(['Scroll command: changes how the screen scrolls; it has no picture in the game']),
      )
    },
  )
})

/** The game's routing by id (bank_02.asm:5290-5368): shooters 201-202, generators 203-217, scroll commands 231-255. */
const expected = (id: number): LoadClass =>
  id >= 231
    ? 'scroll'
    : id >= 203 && id < 218
      ? 'generator'
      : id >= 201 && id < 203
        ? 'shooter'
        : 'normal'
const IDS = Array.from({ length: 256 }, (_, id) => id)

describe.each([VANILLA, MAGIC])('the loader routing of %s, every id', name => {
  describe.skipIf(!hasRom(name))('with the ROM', () => {
    it.each(IDS)('id %i', id => {
      const classes = loadClasses(freshRom(name))
      if (classes.status !== 'ok') throw new Error(classes.reason)
      expect(classes.of(id)).toBe(expected(id))
      // With extra bit 3 set only the scroll commands stay scroll commands.
      expect(classes.of(id, 0x08)).toBe(expected(id) === 'scroll' ? 'scroll' : 'normal')
    })
  })
})

// A hook planted at every instruction start of the main loop's stretch (bank_02.asm:1355-1409, from $02:8AB1 to the last
// call before the loader's at $02:8B1D). Starts come from a decode of the ROM's own bytes (8-bit widths: the stretch has no REP or SEP).
describe.skipIf(!hasRom(VANILLA))('a planted loop in the stretch before the loader call', () => {
  const FIRST = 0x028ab1
  const LAST = 0x028b1a
  const starts: { at: number; op: number }[] = []
  if (hasRom(VANILLA)) {
    const rom = freshRom()
    for (let at = FIRST; at <= LAST;) {
      const op = rom.readAt(at, 1)![0]!
      starts.push({ at, op })
      at += instructionLength(op, true, true)
    }
  }
  const status = (edit: (rom: RomFile) => void) => {
    const rom = freshRom()
    edit(rom)
    return loadClasses(rom).status
  }

  it('decodes the whole stretch and an unmodified ROM reads ok', () => {
    expect(starts.length).toBe(48) // reviewer's measure of the decode, one machine, 2026-11-07
    expect(starts[0]!.at).toBe(FIRST)
    expect(status(() => undefined)).toBe('ok')
  })

  it('is unavailable with a loop planted at every instruction start', () => {
    const missed = starts.filter(
      s => status(rom => rom.writeAt(s.at, [0x80, 0xfe])) !== 'unavailable',
    )
    expect(missed.map(s => s.at.toString(16))).toEqual([])
  })

  it('is unavailable with each branch turned into a self-loop (offset $FE): every branch has a run that takes it', () => {
    // BPL, BMI, BVC, BVS, BRA, BCC, BCS, BNE, BEQ: the stretch's branches are bank_02.asm:1360, :1362, :1364, :1368,
    // :1376, :1378, :1387, :1391, :1397 and :1400. A looped branch only shows in a run that takes it.
    const branches = starts.filter(s =>
      [0x10, 0x30, 0x50, 0x70, 0x80, 0x90, 0xb0, 0xd0, 0xf0].includes(s.op),
    )
    expect(branches.length).toBe(10)
    const missed = branches.filter(
      s => status(rom => rom.writeAt(s.at + 1, [0xfe])) !== 'unavailable',
    )
    expect(missed.map(s => s.at.toString(16))).toEqual([])
  })

  it('still reads ok with the JSL at :1401 replaced by NOPs', () => {
    const jsl = starts.filter(s => s.op === 0x22)
    expect(jsl.length).toBe(1)
    expect(status(rom => rom.writeAt(jsl[0]!.at, [0xea, 0xea, 0xea, 0xea]))).toBe('ok')
  })
})
