/**
 * The reveal audit of the sprite report (#1132): its text and its command, on synthetic rows (CI has no ROM).
 * The pure text must be byte-identical on a rerun and must list what drew at rest and is now hidden; each claim has a
 * planted row that changes it.
 */
import { describe, expect, it } from 'vitest'
import { parseArgs, run, type Io } from '../../../tools/scripts/spriteReportRun'
import {
  revealReport,
  solidToDoorText,
  sweepSection,
  type RevealRow,
} from '../../../tools/scripts/spriteReport'

const rows: RevealRow[] = [
  { map: '105', index: 2, id: 0x74, column: 25, row: 23, rest: 'drew', hidden: false },
  {
    map: '105',
    index: 0,
    id: 0xc7,
    column: 5,
    row: 23,
    rest: 'blank',
    hidden: true,
    condition: 'mario-at-sprite',
  },
  {
    map: '105',
    index: 1,
    id: 0x4d,
    column: 15,
    row: 23,
    rest: 'drew',
    hidden: true,
    condition: 'mario-at-sprite',
  },
  {
    map: '105',
    index: 5,
    id: 0x56,
    column: 55,
    row: 20,
    name: 'Test',
    rest: 'drew',
    hidden: true,
    condition: 'none-found',
  },
  {
    map: '105',
    index: 3,
    id: 0x5,
    column: 35,
    row: 23,
    rest: 'blank',
    hidden: true,
    marker: 'unrevealed',
  },
  { map: '105', index: 4, id: 0xe2, column: 45, row: 23, rest: 'special', hidden: false },
]

describe('revealReport', () => {
  it('counts each class, lists the drew-at-rest-now-hidden sprites, and sorts by list index', () => {
    const text = revealReport(rows)
    expect(text).toContain('6 placed sprites')
    expect(text).toContain('drew at rest 3, blank 2, refused 0, special 1')
    expect(text).toContain('hidden 4, revealed 2, marker for lack of a reveal 1')
    expect(text).toContain('no condition reveals (kept in the door): 1')
    const flipped = text.split('Drew at rest, now hidden:\n')[1]!.split('\n\n')[0]!
    expect(flipped.split('\n')).toEqual([
      'map 105 #1 $4D (column 15, row 23): rest drew, hidden, revealed by mario-at-sprite',
      'map 105 #5 $56 (column 55, row 20): rest drew, hidden, no condition reveals it',
    ])
    const all = text.split('All sprites:\n')[1]!.split('\n')
    expect(all.map(l => l.match(/#(\d)/)?.[1])).toEqual(['0', '1', '2', '3', '4', '5', undefined])
  })

  it('is byte-identical on a rerun, whatever order the rows come in', () => {
    expect(revealReport([...rows].reverse())).toBe(revealReport(rows))
  })

  it('says none when nothing flipped: the section can be empty, so it is not decoration', () => {
    const none = revealReport(rows.filter(r => !(r.rest === 'drew' && r.hidden)))
    expect(none.split('Drew at rest, now hidden:\n')[1]!.startsWith('none\n')).toBe(true)
  })
})

describe('solidToDoorText', () => {
  const say = (c: string) => `says ${c}`
  it('lists map, column, row, id, name and condition for each solid-to-door sprite, "none found" where nothing reveals', () => {
    const text = solidToDoorText(rows, say)
    expect(text).toContain(
      'map $105, column 15, row 23, sprite $4D (no name): says mario-at-sprite',
    )
    expect(text).toContain('map $105, column 55, row 20, sprite $56 Test: none found')
    expect(text).toContain('door: 2\n')
  })
  it('leaves out a sprite that was blank at rest or is not hidden', () => {
    const text = solidToDoorText(rows, say)
    expect(text).not.toContain('$C7')
    expect(text).not.toContain('$74')
  })
})

describe('sprite-report --reveal', () => {
  const io = (): Io & { out: string[] } => {
    const out: string[] = []
    return { repoRoot: '/r', rom: '/rom', captures: '/none', exists: p => p !== '/none', sha: () => ({ sha: 'x', dirty: false }), grade: () => [], reveal: map => rows.map(r => ({ ...r, map: map.toString(16) })), env: {}, log: s => out.push(s), out } // prettier-ignore
  }

  it('prints the audit for one map and needs no captures', () => {
    const i = io()
    expect(run(['--reveal', '--map', '105'], i)).toBe(0)
    expect(i.out.join('\n')).toBe(revealReport(rows))
  })

  it('stops on a missing ROM, writing nothing', () => {
    const i = { ...io(), exists: () => false }
    expect(run(['--reveal', '--map', '105'], i)).toBe(1)
  })

  it('needs a map and nothing else', () => {
    for (const bad of [
      ['--reveal'],
      ['--reveal', '--map', '1', '--sprite', '2'],
      ['--reveal', '--sheet', '--map', '1'],
    ])
      expect(typeof parseArgs(bad)).toBe('string')
  })
})

describe('sweepSection (reveal-sweep)', () => {
  const text = sweepSection('ROM', rows, ['map 1: no sprite data'])
  it('counts revealed sprites per condition, leaving none-found out of them', () => {
    const per = text.split('Revealed per condition:\n')[1]!.split('\n\n')[0]!
    expect(per).toBe('mario-at-sprite: 2')
  })
  it('reports the sprites no condition reveals on a line of their own', () => {
    expect(text).toContain('Hidden, no condition reveals it (kept in the door): 1')
  })
  it('lists markers per reason and the maps not run', () => {
    expect(text).toContain('Markers per reason:\nunrevealed: 1')
    expect(text).toContain('Maps not run: 1\nmap 1: no sprite data')
  })
  it('lists the same-as-rest cases apart, and counts none when no row is flagged (#1365)', () => {
    expect(text).toContain('(not counted, D207): 0')
    const flagged = [
      { ...rows[0]!, hidden: true, condition: 'none-found', sameAsRest: ['mario-at-sprite', 'more-frames'] }, // prettier-ignore
      { ...rows[0]!, index: 5, hidden: true, condition: 'none-found', sameAsRest: ['p-switch'] }, // prettier-ignore
    ]
    const t = sweepSection('ROM', flagged, [])
    // Only the Mario-position repeats are listed by sprite; every skipped condition is tallied.
    expect(t).toContain('(not counted, D207): 1\nmap 105 #2 $74 (column 25, row 23): mario-at-sprite') // prettier-ignore
    expect(t).toContain('at-rest picture (#1365):\nmario-at-sprite: 1\nmore-frames: 1\np-switch: 1') // prettier-ignore
  })
  it.each([
    ['mario-at-sprite', true],
    ['mario-left', true],
    ['mario-right', true],
    ['more-frames', false],
    ['p-switch', false],
    ['on-off', false],
  ])('lists the sprite by name for a skipped %s only when Mario moves: %s', (c, listed) => {
    const t = sweepSection('ROM', [{ ...rows[0]!, hidden: true, condition: 'none-found', sameAsRest: [c] }], []) // prettier-ignore
    expect(t).toContain(`(not counted, D207): ${listed ? 1 : 0}`)
    expect(t).toContain(`at-rest picture (#1365):
${c}: 1`)
  })
  it('blanks ids and numbers in a refusal reason so one refusal counts once', () => {
    const a = { ...rows[0]!, marker: 'refused: the sprite became $FF: id $ff is past 201' }
    const b = { ...rows[0]!, index: 9, marker: 'refused: the sprite became $12: id $12 is past 77' }
    expect(sweepSection('ROM', [a, b], [])).toContain(
      'refused: the sprite became $..: id $.. is past N: 2',
    )
  })
})
