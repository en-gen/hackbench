/** Song structure: sections, the driver's loop counter, subroutines, and the uploaded-memory fence. */
import { describe, it, expect } from 'vitest'
import { parseSong } from '../../../../src/rom/nspc/NspcSong'
import { syntheticEarlier, putSection } from '../../support/syntheticNspc'

const A = 0x5000
const B = 0x5100
const T1 = 0x6000
const T2 = 0x6100

function withTracks() {
  const s = syntheticEarlier()
  // T1: duration 24 + q, note $A4, tie, rest, end.
  s.put(T1, [0x18, 0x7f, 0xa4, 0xc6, 0xc7, 0x00])
  // T2: 48 ticks, one note.
  s.put(T2, [0x30, 0x80, 0x00])
  putSection(s, A, [T1, T2])
  putSection(s, B, [T1])
  return s
}

describe('parseSong', () => {
  it('reads notes, durations and the q byte', () => {
    const s = withTracks()
    s.put(0x7000, [A & 0xff, A >> 8, 0, 0])
    const r = parseSong(s.image(), 0x7000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [section] = r.song.order
    expect(section.tracks[0]!.events).toEqual([
      { k: 'note', note: 0x24, ticks: 24, q: 0x7f },
      { k: 'tie', ticks: 24, q: undefined },
      { k: 'rest', ticks: 24, q: undefined },
    ])
    // The shortest track ends the section for every voice.
    expect(section.ticks).toBe(48)
    expect(r.song.loopIndex).toBeNull()
  })

  it('unrolls a counted repeat and finds the infinite loop by state, not by position', () => {
    const s = withTracks()
    // A, B, [jump x2 to B], then [jump forever to A].
    const list = 0x7000
    const words = [A, B, 0x0002, list + 2, 0x00ff, list, 0]
    s.put(
      list,
      words.flatMap(w => [w & 0xff, w >> 8]),
    )
    const r = parseSong(s.image(), list)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.song.order.map(x => x.addr)).toEqual([A, B, B, B])
    expect(r.song.loopIndex).toBe(0)
  })

  it('expands a subroutine call with its repeat count', () => {
    const s = syntheticEarlier()
    const sub = 0x6200
    s.put(sub, [0x0c, 0x80, 0x00])
    // $E9 is CALL: lo, hi, count.
    s.put(T1, [0xe9, sub & 0xff, sub >> 8, 3, 0x00])
    putSection(s, A, [T1])
    s.put(0x7000, [A & 0xff, A >> 8, 0, 0])
    const r = parseSong(s.image(), 0x7000)
    expect(r.ok && r.song.order[0].ticks).toBe(36)
  })

  it('refuses a track that runs into memory no upload wrote', () => {
    const s = syntheticEarlier()
    s.put(T1, [0x18, 0xa4]) // no terminator: the next byte was never written
    putSection(s, A, [T1])
    s.put(0x7000, [A & 0xff, A >> 8, 0, 0])
    const r = parseSong(s.image(), 0x7000)
    expect(r).toEqual({
      ok: false,
      kind: 'unwritten',
      reason: expect.stringContaining('unwritten'),
    })
  })

  it('refuses a command whose length the driver does not define', () => {
    const s = syntheticEarlier()
    s.put(T1, [0xfe, 0x00])
    putSection(s, A, [T1])
    s.put(0x7000, [A & 0xff, A >> 8, 0, 0])
    expect(parseSong(s.image(), 0x7000)).toMatchObject({ ok: false, kind: 'structure' })
  })
})
