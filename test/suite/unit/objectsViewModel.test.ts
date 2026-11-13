import { describe, it, expect } from 'vitest'
import {
  canTag,
  NO_TAGS,
  roleOf,
  skippedNote,
  tagTile,
} from '../../../theia/extension/src/browser/objects-view-model'

describe('tagTile', () => {
  it('tags a tile with the current role, keeping lists sorted', () => {
    const t = tagTile(tagTile(NO_TAGS, 9, 'edge'), 3, 'edge')
    expect(t).toEqual({ edge: [3, 9], fill: [] })
  })

  it('moves a tile to the other role, so it is never in both', () => {
    const t = tagTile(tagTile(NO_TAGS, 7, 'edge'), 7, 'fill')
    expect(t).toEqual({ edge: [], fill: [7] })
    expect(roleOf(t, 7)).toBe('fill')
  })

  it('untags a tile that already has the current role', () => {
    const t = tagTile(tagTile(NO_TAGS, 7, 'fill'), 7, 'fill')
    expect(t).toEqual(NO_TAGS)
    expect(roleOf(t, 7)).toBeUndefined()
  })

  it('sweeps every tile and role pair without ever tagging twice', () => {
    for (let tile = 0; tile < 512; tile += 37) {
      for (const first of ['edge', 'fill'] as const) {
        for (const second of ['edge', 'fill'] as const) {
          const t = tagTile(tagTile(NO_TAGS, tile, first), tile, second)
          expect(t.edge.length + t.fill.length).toBe(first === second ? 0 : 1)
        }
      }
    }
  })
})

describe('canTag and skippedNote', () => {
  it('allows tagging only once a tileset is picked, including tileset 0', () => {
    expect(canTag(undefined)).toBe(false)
    expect(canTag(0)).toBe(true)
  })

  it('says in words what was skipped and why', () => {
    expect(skippedNote({ file: 'x.json', reason: 'The file is not readable JSON.' })).toBe(
      'This Object file could not be read: The file is not readable JSON. (x.json)',
    )
  })
})
