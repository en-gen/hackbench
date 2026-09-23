/** Translation to AddmusicK MML: by meaning, transposes baked, loops and samples. */
import { describe, it, expect } from 'vitest'
import { parseSong } from '../../../../src/rom/nspc/NspcSong'
import { exportSong } from '../../../../src/rom/nspc/AmkExport'
import { syntheticEarlier, putSection, SYN, Synthetic } from '../../support/syntheticNspc'

const OPTS = { folder: 'src', title: 't', game: 'g' }

function song(s: Synthetic, track: number[], extraSections = 0) {
  s.put(0x6000, track)
  putSection(s, 0x5000, [0x6000])
  const words = [...Array(1 + extraSections).fill(0x5000), 0x00ff, 0x7000, 0]
  s.put(
    0x7000,
    words.flatMap(w => [w & 0xff, w >> 8]),
  )
  // Instrument 2 uses sample 1; the sample is one looping block.
  s.put(SYN.instrTable + 2 * 5, [0x01, 0xff, 0xe0, 0x7f, 0x03])
  s.put(SYN.dir + 4, [0x00, 0x42, 0x00, 0x42])
  s.put(0x4200, [0x03, 1, 2, 3, 4, 5, 6, 7, 8])
  const r = parseSong(s.image(), 0x7000)
  if (!r.ok) throw new Error(r.reason)
  return exportSong(s.image(), r.song, OPTS)
}

describe('exportSong', () => {
  it('writes the instrument, samples and a loop marker', () => {
    const ex = song(syntheticEarlier(), [0xda, 0x02, 0x18, 0xa4, 0x00])
    expect(ex.mml).toContain('"01.brr" $FF $E0 $7F $03 $00')
    expect(ex.mml).toMatch(/#0\n\/ @30 o4 c=24/)
    expect(ex.samples).toEqual([
      { path: 'samples/src/01.brr', bytes: new Uint8Array([0, 0, 0x03, 1, 2, 3, 4, 5, 6, 7, 8]) },
    ])
    expect(ex.warnings).toEqual([])
  })

  it('bakes the global transpose into the notes instead of emitting it', () => {
    // $E4 is global transpose in the Earlier dialect: +2 semitones.
    const ex = song(syntheticEarlier(), [0xe4, 0x02, 0x18, 0xa4, 0x00])
    expect(ex.mml).toContain('o4 d=24')
    expect(ex.mml).not.toContain('$E4')
  })

  it('maps tremolo off to its AddmusicK form, since AddmusicK reuses $E6', () => {
    const ex = song(syntheticEarlier(), [0xe6, 0x18, 0xa4, 0x00])
    expect(ex.mml).toContain('$E5 $00 $00 $00')
    expect(ex.mml).not.toContain('$E6')
  })

  it('turns a repeated subroutine into an AddmusicK loop', () => {
    const s = syntheticEarlier()
    s.put(0x6200, [0x0c, 0xa4, 0x00])
    const ex = song(s, [0xe9, 0x00, 0x62, 0x04, 0x00])
    expect(ex.mml).toContain('[ o4 c=12 ]4')
  })

  it('warns and drops a command with no known meaning', () => {
    const s = syntheticEarlier()
    s.put(SYN.lens + (0xed - 0xda), [2])
    const ex = song(s, [0xed, 0x10, 0x18, 0xa4, 0x00])
    expect(ex.warnings.join()).toContain('$ED')
  })
})
