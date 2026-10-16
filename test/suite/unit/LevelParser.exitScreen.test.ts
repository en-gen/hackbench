/**
 * A screen exit's OWN screen field (#956). CODE_0DA512 files the exit under
 * X = _A & $1F, where _A is object byte 0 (SMWDisX bank_0D.asm:1428-1432).
 * That is not the stream screen the object sits on: vanilla places exits on
 * one stream screen with a field naming another (the corpus test below counts
 * 129 of 227 vanilla screen exits whose own screen differs from placement).
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { SmwRom, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { SYNTHETIC_VERTICAL_TABLE } from '../support/verticalTable'
import { hasRom, romPath, VANILLA } from '../support/corpus'

const ZERO_HEADER: [number, number, number, number, number] = [0, 0, 0, 0, 0]

/** `placement` filler objects each open a new screen, then one exit with own field `own`. */
function levelWithExit(placement: number, own: number, dest = 0x42): Buffer {
  const body: number[] = []
  // Standard object 1 (b1 high nibble 1), new-screen flag set: advances the stream screen.
  for (let i = 0; i < placement; i++) body.push(0x80, 0x10, 0x00)
  body.push(own & 0x1f, 0x00, 0x00, dest)
  return Buffer.from([...ZERO_HEADER, ...body, 0xff])
}

describe('parseLevelObjects - screen exit own screen field (#956)', () => {
  const pairs: Array<[number, number]> = [
    [7, 3], // invented values: placed on 7, field names 3
    [0, 0],
    [0, 0x1f],
    [7, 7], // own equals placement
    [5, 0],
    [3, 0x1f],
    [12, 9],
  ]
  it.each(pairs)('exit on stream screen %i reports own field %i', (placement, own) => {
    const { objects } = parseLevelObjects(levelWithExit(placement, own), SYNTHETIC_VERTICAL_TABLE)
    const exit = objects.find(o => o.screenExitDest !== undefined)!
    expect(exit.screen).toBe(placement)
    expect(exit.screenExitScreen).toBe(own)
    expect(exit.screenExitDest).toBe(0x42)
  })

  // The exit object itself carries the new-screen flag (b0 bit 7), so `screen`
  // advances at this object and the low 5 bits of b0 are the own field. Only
  // the mask keeps the flag (0x80) out of the field. (Bits 5-6 of b0 must be
  // zero for an extended object, so masks 0x3f and 0x7f are equivalent to 0x1f.)
  it.each([
    [0, 0x05],
    [4, 0x0a],
    [2, 0x1f],
  ])('exit that opens a screen itself: %i fillers, own %i', (placement, own) => {
    const body: number[] = []
    for (let i = 0; i < placement; i++) body.push(0x80, 0x10, 0x00)
    body.push(0x80 | own, 0x00, 0x00, 0x42)
    const data = Buffer.from([...ZERO_HEADER, ...body, 0xff])
    const { objects } = parseLevelObjects(data, SYNTHETIC_VERTICAL_TABLE)
    const exit = objects.find(o => o.screenExitDest !== undefined)!
    expect(exit.screenExitScreen).toBe(own)
    expect(exit.screen).toBe(placement + 1)
  })

  it.each([
    // [b1, dest byte, expected dest, expected secondary]
    [0x00, 0x42, 0x042, false],
    [0x01, 0x42, 0x142, false], // dest high bit
    [0x02, 0x42, 0x042, true], // secondary flag
    [0x03, 0x07, 0x107, true], // both
    [0x06, 0x07, 0x007, true], // secondary value 3
  ])('exit b1=%i dest byte %i decodes dest %i secondary %s', (b1, byte, dest, secondary) => {
    const data = Buffer.from([...ZERO_HEADER, 0x00, b1, 0x00, byte, 0xff])
    const { objects } = parseLevelObjects(data, SYNTHETIC_VERTICAL_TABLE)
    const exit = objects.find(o => o.screenExitDest !== undefined)!
    expect(exit.screenExitDest).toBe(dest)
    expect(exit.screenExitIsSecondary).toBe(secondary)
  })

  it('is absent on ordinary objects', () => {
    const { objects } = parseLevelObjects(levelWithExit(2, 1), SYNTHETIC_VERTICAL_TABLE)
    const others = objects.filter(o => o.screenExitDest === undefined)
    expect(others).toHaveLength(2)
    for (const o of others) expect(o.screenExitScreen).toBeUndefined()
  })
})

// Digest of every exit's (slot, dest, secondary). Those fields are not changed
// by #956, so before and after are equal by construction; the digest guards
// future regressions in them. Vanilla US 1.0 ROM, one machine.
const BASELINE_DIGEST = '91b6c0ede3895725'
const BASELINE_COUNT = 227
// Exits whose own field differs from the stream screen they sit on.
const DIFFERING_COUNT = 129

describe.skipIf(!hasRom(VANILLA))('screen exit own screen, vanilla corpus (#956)', () => {
  it('leaves existing exit fields untouched and lists exits whose own screen differs', () => {
    const smw = SmwRom.open(romPath(VANILLA))
    const lines: string[] = []
    const differing: string[] = []
    let count = 0
    for (let slot = 0; slot < LEVEL_COUNT; slot++) {
      const raw = smw.getLevelRawData(slot)
      if (!raw || raw.length < 6) continue
      let parsed
      try {
        parsed = parseLevelObjects(raw, [])
      } catch {
        continue
      }
      for (const o of parsed.objects) {
        if (o.screenExitDest === undefined) continue
        count++
        lines.push(`${slot}:${o.screenExitDest}:${o.screenExitIsSecondary}`)
        expect(o.screenExitScreen).toBeDefined()
        expect(o.screenExitScreen!).toBeLessThan(0x20)
        expect(o.screenExitScreen).toBe(o.raw[0]! & 0x1f)
        if (o.screenExitScreen !== o.screen)
          differing.push(`${slot}:placement=${o.screen}:own=${o.screenExitScreen}`)
      }
    }
    const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
    console.log(`exits=${count} digest=${digest}\ndiffering=${differing.join(' ')}`)
    expect(count).toBe(BASELINE_COUNT)
    expect(digest).toBe(BASELINE_DIGEST)
    expect(differing).toHaveLength(DIFFERING_COUNT)
  })
})
