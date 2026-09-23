/**
 * The engine locator reads every table address from a code operand, and
 * refuses rather than picks. Synthetic, so it runs where test/roms/ is absent.
 */
import { describe, it, expect } from 'vitest'
import { locateEngine } from '../../../../src/rom/nspc/NspcEngine'
import { syntheticEarlier, SYN, EARLIER_LENS } from '../../support/syntheticNspc'

describe('locateEngine', () => {
  it('reads each table from its operand', () => {
    const r = locateEngine(syntheticEarlier().aram)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.engine).toMatchObject({
      dialect: 'earlier',
      songTable: SYN.songTable,
      instrTable: SYN.instrTable,
      instrWidth: 5,
      percTable: SYN.percTable,
      dir: SYN.dir,
      vcmdFirst: 0xda,
      noteMax: 0xc5,
      tie: 0xc6,
      percMin: 0xd0,
      percMax: 0xd9,
    })
    expect(r.engine.vcmdLens.slice(0, EARLIER_LENS.length)).toEqual(EARLIER_LENS)
  })

  it('follows a relocated instrument table rather than a fixed address', () => {
    const s = syntheticEarlier()
    const at = s.aram.findIndex(
      (_, i) => s.aram[i] === 0x8d && s.aram[i + 1] === 0x05 && s.aram[i + 2] === 0x8f,
    )
    s.aram[at + 3] = 0x80
    s.aram[at + 6] = 0x62
    const r = locateEngine(s.aram)
    expect(r.ok && r.engine.instrTable).toBe(0x6280)
  })

  it('refuses when the song-start routine is missing', () => {
    const s = syntheticEarlier()
    const at = s.aram.findIndex(
      (_, i) => s.aram[i] === 0x1c && s.aram[i + 1] === 0xfd && s.aram[i + 2] === 0xf6,
    )
    s.aram[at + 2] = 0xea // no longer MOV A,abs+Y
    const r = locateEngine(s.aram)
    expect(r.ok).toBe(false)
  })

  it('refuses two song-start routines that disagree, instead of picking one', () => {
    const s = syntheticEarlier()
    s.put(0x9000, [0x1c, 0xfd, 0xf6, 0x00, 0x20, 0xc4, 0x40, 0xf6, 0x01, 0x20, 0xc4, 0x41])
    const r = locateEngine(s.aram)
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('several') })
  })

  it('refuses a high-byte read from a different table', () => {
    const s = syntheticEarlier()
    const at = s.aram.findIndex(
      (_, i) => s.aram[i] === 0x1c && s.aram[i + 1] === 0xfd && s.aram[i + 2] === 0xf6,
    )
    s.aram[at + 8] += 2
    expect(locateEngine(s.aram).ok).toBe(false)
  })

  it('refuses two sample directories', () => {
    const s = syntheticEarlier()
    s.put(0x9100, [0x8f, 0x5d, 0xf2, 0x8f, 0x77, 0xf3])
    expect(locateEngine(s.aram)).toEqual({
      ok: false,
      reason: expect.stringContaining('sample directory'),
    })
  })

  it('reads the percussion boundary from the compare operand', () => {
    const s = syntheticEarlier()
    const at = s.aram.findIndex(
      (_, i) => s.aram[i] === 0x68 && s.aram[i + 1] === 0xd0 && s.aram[i + 2] === 0xb0,
    )
    s.aram[at + 1] = 0xd2
    const r = locateEngine(s.aram)
    expect(r.ok && r.engine.percMin).toBe(0xd2)
  })
})
