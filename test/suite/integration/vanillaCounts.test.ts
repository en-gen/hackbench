/**
 * What the vanilla cart actually says about levels and exits.
 *
 * The EXIT count is a ROM fact and closes exactly at 96.
 *
 * The LEVEL count is not. The ROM supports several defensible answers and
 * external sources disagree with each other (73, 72, and a per-world breakdown
 * summing to 61), so this file reports the ROM's quantities and does not pick
 * one as "the" level count. An earlier version of this test defined
 * `levels = entryMaps - switchPalaces` to reach 73; that was fitting to a
 * target, and switch palaces are levels.
 *
 * Every input is read from the cart:
 *   entry maps      deriveOverworldEntrances (walks OWL1TileData as CODE_04D7F2 does)
 *   switch palaces  DATA_05A590[0..3], the indices the CPX #$04 gate at
 *                   bank_05.asm:3321-3324 turns into SwitchPalaceColor
 *   awards          OWLevelExitMode per docs/rom/smw-overworld-levels.md
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom, isOverworldLevel } from '../../../src/rom/SmwRom'
import { buildLevelSubtree } from '../../../src/rom/LevelTree'
import { parseLevelSprites } from '../../../src/rom/LevelParser'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const VANILLA_ROM = romPath(VANILLA)
const EVENT_TABLE = 0x05d608
const SWITCH_TABLE = 0x05a590
const SWITCH_COUNT = 4 // the CPX #$04 gate, bank_05.asm:3321

describe.skipIf(!hasRom(VANILLA))('vanilla level and exit counts', () => {
  // Built in beforeAll, not in the describe body: describe.skipIf still runs
  // the body at collection time, so opening the ROM there crashes CI, which
  // has no ROM. The suite must skip, not explode.
  let rom: SmwRom
  let switchPalaces: Set<number>
  let scored: Array<{
    room: number
    tl: number | undefined
    ev: number
    normal: number
    secret: number
    side: boolean
    isSwitch: boolean
    awardsNormal: boolean
  }>
  let entryMapCount = 0
  let distinctL1 = 0

  beforeAll(() => {
    rom = SmwRom.open(VANILLA_ROM)
    const idx = deriveOverworldEntrances(rom)
    const g = rom.buildLevelExitGraph(idx.levelBounds).graph
    const sp = (i: number) => {
      const p = rom.getLevelSpritePointer(i)
      if (!p) return []
      const b = rom.rom.readAt(p, 0x800)
      if (!b) return []
      try {
        return parseLevelSprites(b)
      } catch {
        return []
      }
    }

    const slotToTl = new Map<number, number>()
    for (const e of idx.entrances)
      if (e.isMap && e.action === 'map' && !slotToTl.has(e.slot)) slotToTl.set(e.slot, e.translevel)

    switchPalaces = new Set(
      Array.from({ length: SWITCH_COUNT }, (_, i) => rom.rom.readByte(SWITCH_TABLE + i)!),
    )

    entryMapCount = idx.entryMaps.length
    distinctL1 = new Set(idx.entryMaps.map(r => rom.getLevelL1Pointer(r))).size

    scored = idx.entryMaps.map(room => {
      const tl = slotToTl.get(room)
      const ev = tl === undefined ? 0xff : (rom.rom.readByte(EVENT_TABLE + tl) ?? 0xff)
      const chain = new Set<number>()
      const f = (n: any) => {
        if (n.kind === 'room') chain.add(n.index)
        n.children.forEach(f)
      }
      f(buildLevelSubtree(room, g, i => isOverworldLevel(i, idx.levelBounds)))
      let normal = 0,
        secret = 0,
        side = false
      for (const c of chain)
        for (const s of sp(c)) {
          const x = (s.raw[0] >> 2) & 3
          if (s.spriteId === 0x7b) {
            if (x === 1) secret++
            else normal++
          } else if (s.spriteId === 0x0e) secret++
          else if (s.spriteId === 0x4a) normal++
          else if (s.spriteId === 0x8c) side = true
        }
      const isSwitch = tl !== undefined && switchPalaces.has(tl)
      const awardsNormal = ev !== 0xff && !(normal === 0 && secret === 0 && side)
      return { room, tl, ev, normal, secret, side, isSwitch, awardsNormal }
    })
  })

  it('names 4 switch palaces from DATA_05A590', () => {
    expect(switchPalaces.size).toBe(4)
    expect([...switchPalaces].sort((a, b) => a - b)).toEqual([0x08, 0x14, 0x3f, 0x45])
    expect(scored.filter(s => s.isSwitch)).toHaveLength(4)
  })

  it('reports the level-ish quantities the ROM supports', () => {
    // Launch tiles that start a map, after warps and filler are removed.
    expect(entryMapCount).toBe(77)

    // $015 and $017 share an L1 pointer AND a sprite pointer: one level, two
    // launch tiles. Distinct level data is therefore 76.
    //
    // 76 is the one figure here with an independent external match: the Super
    // Mario Wiki gives "73 levels (76 including Yoshi's House and the Top
    // Secret Area and if the Back Door and Front Door are counted as separate
    // levels)". Reached here without consulting it. Its 73 is that 76 minus
    // three editorial conventions, not a quantity the cart computes.
    expect(distinctL1).toBe(76)

    // Entry maps that can award a normal exit.
    expect(scored.filter(s => s.awardsNormal)).toHaveLength(74)

    // Switch palaces are levels, so they are NOT subtracted anywhere here.
    expect(scored.filter(s => s.isSwitch)).toHaveLength(4)
  })

  it('counts 96 exits', () => {
    const normalExits = scored.filter(s => s.awardsNormal).length
    // No orphan fudge here any more. $0EB and $1E7 used to need adding by hand
    // because buildLevelExitGraph could not reach them; they are now found by
    // the chain walk like every other secret exit, and the total is unchanged.
    const secretExits = scored.filter(s => s.secret > 0 && s.ev !== 0xff).length
    expect(normalExits).toBe(74)
    expect(secretExits).toBe(22)
    expect(normalExits + secretExits).toBe(96)
  })
})
