/**
 * Exit graph, last exit written per screen (#957), across all 512 vanilla slots.
 * The game files each exit under its own screen field with a plain STA
 * (SMWDisX bank_0D.asm:1428-1435), so a second exit for a screen replaces the first.
 * Evidence scope: vanilla ROM, one machine, Layer 1 streams only.
 */
import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { VANILLA, hasRom, romPath } from '../support/corpus'

/** Slots where the old rule (every exit object) and the new (last per screen) disagree. */
function sweep(rawOf: (slot: number) => Uint8Array | null | undefined) {
  const affected: number[] = []
  let slotsRead = 0
  let exitObjects = 0
  for (let i = 0; i < 512; i++) {
    const raw = rawOf(i)
    if (!raw || raw.length < 6) continue
    slotsRead++
    const exits = parseLevelObjects(raw, []).objects.filter(o => o.screenExitDest !== undefined)
    exitObjects += exits.length
    if (new Set(exits.map(o => o.screenExitScreen)).size !== exits.length) affected.push(i)
  }
  return { affected, slotsRead, exitObjects }
}

// A screen-exit object on `screen` to the primary destination `dest`.
const exit = (screen: number, dest: number) => [screen, 0x01, 0x00, dest]

describe('exit last-write-wins sweep oracle (#957)', () => {
  it('flags a slot holding two exits for one screen, and only that slot', () => {
    const slots: Record<number, number[]> = {
      7: [0, 0, 0, 0, 0, ...exit(3, 0x50), ...exit(3, 0x51), 0xff],
      8: [0, 0, 0, 0, 0, ...exit(3, 0x50), ...exit(4, 0x51), 0xff],
    }
    const r = sweep(i => (slots[i] ? Uint8Array.from(slots[i]!) : null))
    expect(r).toEqual({ affected: [7], slotsRead: 2, exitObjects: 4 })
  })
})

// Measured on the vanilla ROM (one machine): no slot has two exit objects for one screen,
// so the fix changes no vanilla edge. The floors keep an empty sweep from passing.
const AFFECTED_SLOTS: number[] = []

describe.skipIf(!hasRom(VANILLA))('exit last-write-wins -- vanilla sweep (#957)', () => {
  it('affects exactly the measured slots, over all 512 slots', () => {
    const rom = SmwRom.open(romPath(VANILLA))
    const r = sweep(i => rom.getLevelRawData(i))
    expect(r.slotsRead).toBe(512)
    expect(r.exitObjects).toBe(227)
    expect(r.affected).toEqual(AFFECTED_SLOTS)
  })
})
