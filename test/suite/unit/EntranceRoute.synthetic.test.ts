/**
 * #945 (D66 call 1): a sub area's entrance is the one the normal route reaches it by, not the
 * lowest secondary id. The chooser, its note, and the claim that layer 2 and layer 3 follow it.
 * Hand-built `MapEntrances`; no ROM. The walk that fills `route` is tested in SmwRom.classify.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { chooseEntrance, chooseEntranceNoted } from '../../../src/rom/L3Loader'
import type { MapEntrances } from '../../../src/rom/SmwRom'

const via = (o: Partial<MapEntrances>): MapEntrances => ({ overworld: false, primary: false, secondary: [], ...o }) // prettier-ignore

describe('chooseEntrance follows the route (#945)', () => {
  it('a sub area takes its route entrance, not the lowest id', () => {
    const v = via({ secondary: [0x20, 0xa5], route: 0xa5 })
    expect(chooseEntrance(v)).toBe(0xa5)
    expect(chooseEntranceNoted(v).note).toBeUndefined()
  })
  it('a single route takes that entrance', () => {
    expect(chooseEntrance(via({ secondary: [0x20], route: 0x20 }))).toBe(0x20)
  })
  it('a primary exit that got there first stays primary despite later secondary entrances', () => {
    expect(chooseEntrance(via({ primary: true, secondary: [0x22], route: null }))).toBeNull()
  })
  it('a non-entry map entered by a primary exit too still takes its earlier secondary route', () => {
    const v = via({ primary: true, secondary: [0x30], route: 0x30 })
    expect(chooseEntrance(v)).toBe(0x30)
    expect(chooseEntranceNoted(v).note).toBeUndefined()
  })
  it('an entry map is primary whatever else enters it', () => {
    expect(chooseEntrance(via({ overworld: true, secondary: [0x21], route: null }))).toBeNull()
    expect(chooseEntrance(via({ overworld: true, secondary: [0x21], route: 0x21 }))).toBeNull()
  })
  it('an unavailable graph is primary, without a note', () => {
    expect(chooseEntranceNoted(undefined)).toEqual({ entrance: null })
  })
  it('no route found: the earlier rule as a defined fallback, and a note says so', () => {
    const noted = chooseEntranceNoted(via({ secondary: [0x30, 0x1c3] }))
    expect(noted.entrance).toBe(0x30)
    expect(noted.note).toMatch(/no route/i)
    expect(chooseEntranceNoted(via({ primary: true, secondary: [0x30] })).entrance).toBeNull()
    expect(chooseEntranceNoted(via({})).entrance).toBeNull()
    expect(chooseEntranceNoted(via({})).note).toMatch(/no route/i)
  })
  // D78 call 2: a map no route reaches opens at screen 0 (readLevelStart refuses it, so the view
  // keeps its scroll; LevelStart.synthetic.test.ts), and no entrance is called a guess.
  it('an unreached map names no guessed entrance', () => {
    const note = chooseEntranceNoted(via({})).note
    expect(note).not.toMatch(/guess/i)
  })
})
