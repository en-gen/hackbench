import { describe, expect, it } from 'vitest'
import { parseQuery, rowMatches } from '../../../theia/extension/src/browser/explorer-match'
import { parseHexId } from '../../../src/project/HexId'

const hex = (n: number) => n.toString(16)

describe('parseHexId', () => {
  it('reads every spelling of every id in the slot range to the same number', () => {
    for (let n = 0; n <= 0x1ff; n++) {
      const h = hex(n)
      for (const form of [
        h,
        h.toUpperCase(),
        `$${h}`,
        `0x${h}`,
        `0X${h.toUpperCase()}`,
        ` $${h} `,
      ]) {
        expect(parseHexId(form), form).toBe(n)
      }
    }
  })

  it('refuses text that is not hex', () => {
    for (const bad of ['', '$', '0x', 'xyz', '1g', '$$1', '10 5', 'castle']) {
      expect(parseHexId(bad), bad).toBeNull()
    }
  })
})

describe('rowMatches', () => {
  const slot = (n: number) => ({ id: n, texts: ['Donut Plains 1'] })

  it('matches a row by id in any form, and only that row', () => {
    for (let n = 0; n <= 0x1ff; n++) {
      const other = (n + 1) & 0x1ff
      for (const q of [hex(n), `$${hex(n)}`, `0x${hex(n)}`]) {
        expect(rowMatches(parseQuery(q), { id: n, texts: [] }), q).toBe(true)
        expect(rowMatches(parseQuery(q), { id: other, texts: [] }), q).toBe(false)
      }
    }
  })

  it('a $ or 0x prefix is id-only, so a name containing the digits does not match', () => {
    const row = { id: 5, texts: ['Level 105 castle'] }
    expect(rowMatches(parseQuery('105'), row)).toBe(true)
    expect(rowMatches(parseQuery('$105'), row)).toBe(false)
    expect(rowMatches(parseQuery('0x105'), row)).toBe(false)
    expect(rowMatches(parseQuery('$5'), row)).toBe(true)
  })

  it('matches names by case-insensitive substring across all texts', () => {
    const row = { id: 9, texts: ['DONUT PLAINS 1', 'my alias'] }
    expect(rowMatches(parseQuery('plains'), row)).toBe(true)
    expect(rowMatches(parseQuery('ALIAS'), row)).toBe(true)
    expect(rowMatches(parseQuery('nope'), row)).toBe(false)
  })

  it('a row with no id never matches by number, and an empty query matches nothing', () => {
    expect(rowMatches(parseQuery('0'), { texts: ['Folder'] })).toBe(false)
    expect(rowMatches(parseQuery(''), slot(0))).toBe(false)
    expect(rowMatches(parseQuery('   '), slot(0))).toBe(false)
  })
})
