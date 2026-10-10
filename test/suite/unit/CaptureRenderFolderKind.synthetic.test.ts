/**
 * #854: capture_render told apart a finished sprite-trace folder (no
 * capture_summary.json by design) from a layers folder that aborted.
 * Synthetic folders, no ROM.
 */
import { describe, expect, it } from 'vitest'
import { loadLevel } from '../../../tools/scripts/capture_render'

const load = (files: Record<string, string>) =>
  loadLevel(n => (n in files ? Buffer.from(files[n]) : null), '$10A')

describe('capture_render folder kind (#854)', () => {
  it('names a finished sprite-trace folder and does not call it aborted', () => {
    const l = load({ 'calls.json': '[]', 'frames.json': '[]', 'meta.json': '{}' })
    expect(l.verdict).toBe('unavailable')
    // The fallback says "not a sprite-trace folder", so a bare "sprite-trace folder" match
    // passes with the branch removed; pin the branch's own wording and rule the fallback out.
    expect(l.detail).toMatch(/this viewer compares layers captures only/)
    expect(l.detail).not.toMatch(/incomplete/)
    expect(l.detail).not.toMatch(/not a sprite-trace/)
    expect(l.detail).not.toMatch(/abort/)
  })

  it('still reports a layers folder without its summary as incomplete', () => {
    const l = load({ 'vram.bin': 'x', 'ppu.json': '{}' })
    expect(l.verdict).toBe('unavailable')
    expect(l.detail).toMatch(/^no capture_summary.json: not a sprite-trace folder/)
    expect(l.detail).toMatch(/incomplete/)
  })

  // Only both trace files mark a sprite trace; either one alone is a partial folder.
  it.each(['calls.json', 'frames.json'])(
    'treats a folder holding only %s as not a finished trace',
    f => {
      const l = load({ [f]: '[]' })
      expect(l.verdict).toBe('unavailable')
      expect(l.detail).toMatch(/^no capture_summary.json: not a sprite-trace folder/)
      expect(l.detail).toMatch(/incomplete/)
      expect(l.detail).not.toContain('this viewer compares layers captures only')
    },
  )
})
