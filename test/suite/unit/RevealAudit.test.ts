/**
 * The reveal audit of the sprite report (#1132): its text and its command, on synthetic rows (CI has no ROM).
 * The pure text must be byte-identical on a rerun and must list what drew at rest and is now hidden; each claim has a
 * planted row that changes it.
 */
import { describe, expect, it } from 'vitest'
import { parseArgs, run, type Io } from '../../../tools/scripts/spriteReportRun'
import { revealReport, type RevealRow } from '../../../tools/scripts/spriteReport'

const rows: RevealRow[] = [
  { map: '105', index: 2, id: 0x74, rest: 'drew', hidden: false },
  { map: '105', index: 0, id: 0xc7, rest: 'blank', hidden: true, condition: 'mario-at-sprite' },
  { map: '105', index: 1, id: 0x4d, rest: 'drew', hidden: true, condition: 'mario-at-sprite' },
  { map: '105', index: 3, id: 0x5, rest: 'blank', hidden: true, marker: 'unrevealed' },
  { map: '105', index: 4, id: 0xe2, rest: 'special', hidden: false },
]

describe('revealReport', () => {
  it('counts each class, lists the drew-at-rest-now-hidden sprites, and sorts by list index', () => {
    const text = revealReport(rows)
    expect(text).toContain('5 placed sprites')
    expect(text).toContain('drew at rest 2, blank 2, refused 0, special 1')
    expect(text).toContain('hidden 3, revealed 2, marker for lack of a reveal 1')
    const flipped = text.split('Drew at rest, now hidden:\n')[1]!.split('\n\n')[0]!
    expect(flipped).toBe('map 105 #1 $4D: rest drew, hidden, revealed by mario-at-sprite')
    const all = text.split('All sprites:\n')[1]!.split('\n')
    expect(all.map(l => l.match(/#(\d)/)?.[1])).toEqual(['0', '1', '2', '3', '4', undefined])
  })

  it('is byte-identical on a rerun, whatever order the rows come in', () => {
    expect(revealReport([...rows].reverse())).toBe(revealReport(rows))
  })

  it('says none when nothing flipped: the section can be empty, so it is not decoration', () => {
    const none = revealReport(rows.filter(r => !(r.rest === 'drew' && r.hidden)))
    expect(none.split('Drew at rest, now hidden:\n')[1]!.startsWith('none\n')).toBe(true)
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
