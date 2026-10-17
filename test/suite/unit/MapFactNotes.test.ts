/**
 * #1008: the warnings the removed facts strip carried, as notes. Pure and ROM-free: every
 * input is a planted DTO, so each trigger is exercised (a note that never fires is the
 * defect this file exists to catch).
 */
import { describe, it, expect } from 'vitest'
import { factNotes } from '../../../theia/extension/src/browser/map-view-messages'

const ok = { index: 0x105 }
const keys = (i: Parameters<typeof factNotes>[0]) => factNotes(i).map(n => n.note)

describe('factNotes', () => {
  it('says nothing for a map that read cleanly', () => {
    expect(factNotes({ details: ok })).toEqual([])
    expect(factNotes({})).toEqual([])
  })

  it.each([
    ['nameUnavailable', 'name', 'Name unavailable'],
    ['levelDataUnavailable', 'level-data', 'Level data unavailable'],
    ['orientationUnavailable', 'orientation', 'Orientation unavailable'],
    ['objectsUnavailable', 'objects', 'Objects unavailable'],
    ['spriteUnavailable', 'sprite-data', 'Sprites unavailable'],
  ] as const)('%s becomes the %s note, the reason in the title only', (field, note, text) => {
    const [n, ...rest] = factNotes({ details: { ...ok, [field]: 'planted reason $7E88DD' } })
    expect(rest).toEqual([])
    expect(n).toMatchObject({ note, text, title: 'planted reason $7E88DD' })
    expect(n!.text).not.toContain('$')
  })

  it('claims nothing past the level data when it was not read', () => {
    const d = {
      ...ok,
      levelDataUnavailable: 'L',
      orientationUnavailable: 'O',
      objectsUnavailable: 'B',
      spriteUnavailable: 'S',
    }
    expect(keys({ details: d })).toEqual(['level-data'])
  })

  it('keeps the graphics caveat in full, drawn as an error', () => {
    const [n] = factNotes({ details: { ...ok, gfxAssignmentNote: 'The GFX files may differ.' } })
    expect(n).toMatchObject({ note: 'gfx-assignment', text: 'The GFX files may differ.', error: true }) // prettier-ignore
  })

  it('shows a failed read in plain words with the exception only in the title', () => {
    expect(factNotes({ failed: 'Could not be read.', failedDetail: 'boom' })).toEqual([
      { note: 'map-details', text: 'Could not be read.', title: 'boom', error: true },
    ])
  })

  it('shows a missing ROM once, even when the start says the same', () => {
    const romMissing = 'The base ROM X is not on this machine.'
    expect(factNotes({ romMissing, startWhy: romMissing })).toEqual([
      { note: 'rom-missing', text: romMissing, error: true },
    ])
  })

  it('shows the start with the loader text as the second title line', () => {
    expect(factNotes({ details: ok, startWhy: 'Plain.', startDetail: 'raw' })).toEqual([
      { note: 'start', text: 'Start unavailable', title: 'Plain.\nraw' },
    ])
  })

  it('orders notes first by group: this map, then this ROM (map-facts-properties.md)', () => {
    const details = {
      ...ok,
      nameUnavailable: 'n',
      objectsUnavailable: 'o',
      spriteUnavailable: 's',
      gfxAssignmentNote: 'g',
    }
    const all = { details, startWhy: 'w', romMissing: 'r' }
    expect(keys(all)).toEqual([
      'name',
      'objects',
      'sprite-data',
      'start',
      'gfx-assignment',
      'rom-missing',
    ])
  })
})
