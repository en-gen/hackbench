import { describe, it, expect } from 'vitest'
import {
  applyWriteReply,
  canTag,
  changeTileset,
  draftOf,
  EMPTY_EDITOR,
  formatTileLabel,
  newObjectState,
  NO_TAGS,
  openDefinition,
  removableId,
  roleOf,
  skippedNote,
  tagEditor,
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

describe('the editor state (stale replies, tileset switch, what Save sends)', () => {
  const defA = {
    version: 1 as const,
    id: 'aaaa0001',
    name: 'A',
    tileset: 1,
    edge: [256],
    fill: [257, 300],
  }
  const defB = {
    version: 1 as const,
    id: 'bbbb0002',
    name: 'B',
    tileset: 2,
    edge: [260],
    fill: [261],
  }

  it('drops a save reply that arrives after another row was opened: B keeps its own id and name', () => {
    const a = openDefinition(EMPTY_EDITOR, defA)
    const sentToken = a.token // Save pressed on A
    const b = openDefinition(a, defB) // the user clicks row B mid-save
    const after = applyWriteReply(b, sentToken, defA)
    expect(after).toBe(b)
    expect(after.editId).toBe('bbbb0002')
    expect(after.name).toBe('B')
  })

  it('takes the reply when nothing moved, so a first save learns its id', () => {
    const fresh = { ...EMPTY_EDITOR, name: 'New', tileset: 3 }
    const after = applyWriteReply(fresh, fresh.token, { ...defA, name: 'New' })
    expect(after.editId).toBe('aaaa0001')
    expect(after.name).toBe('New')
  })

  it('drops a reply after New, a tileset change or a project change', () => {
    const a = openDefinition(EMPTY_EDITOR, defA)
    for (const moved of [newObjectState(a), changeTileset(a, 5), newObjectState(a)]) {
      expect(applyWriteReply(moved, a.token, defA).editId).toBe(moved.editId)
    }
  })

  it('turns a tileset change into a new unsaved definition and clears the tags', () => {
    const a = openDefinition(EMPTY_EDITOR, defA)
    const b = changeTileset(a, 4)
    expect(b.tileset).toBe(4)
    expect(b.tags).toEqual(NO_TAGS)
    expect(b.editId).toBeUndefined()
    expect(b.name).toBe('A')
    // Picking the same tileset again changes nothing.
    expect(changeTileset(a, 1)).toBe(a)
  })

  it('builds exactly what Save sends, fill included (acceptance 7, at the activity)', () => {
    const a = openDefinition(EMPTY_EDITOR, defA)
    expect(draftOf(a)).toEqual({
      id: 'aaaa0001',
      name: 'A',
      tileset: 1,
      edge: [256],
      fill: [257, 300],
    })
    const tagged = tagEditor(changeTileset(EMPTY_EDITOR, 2), 300, 'fill')
    expect(draftOf({ ...tagged, name: 'X' })).toEqual({
      id: undefined,
      name: 'X',
      tileset: 2,
      edge: [],
      fill: [300],
    })
  })

  it('has nothing to send before a tileset is picked', () => {
    expect(draftOf({ ...EMPTY_EDITOR, name: 'X' })).toBeUndefined()
  })
})

describe('labels and removable files', () => {
  it('writes tile numbers the way the Map16 editor does', () => {
    expect(formatTileLabel(0x102)).toBe('Tile $102')
    expect(formatTileLabel(5)).toBe('Tile $005')
  })

  it('offers Remove only for a file the app can name by id', () => {
    expect(removableId('broken.json')).toBe('broken')
    expect(removableId('ABC12345.json')).toBeUndefined()
    expect(removableId('objects')).toBeUndefined()
    expect(removableId('a_b.json')).toBeUndefined()
  })
})
