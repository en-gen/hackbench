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
    expect(l.detail).toContain('sprite-trace folder')
    expect(l.detail).not.toMatch(/abort/)
  })

  it('still reports a layers folder without its summary as incomplete', () => {
    const l = load({ 'vram.bin': 'x', 'ppu.json': '{}' })
    expect(l.verdict).toBe('unavailable')
    expect(l.detail).toMatch(/^no capture_summary.json: layers folder/)
    expect(l.detail).toMatch(/incomplete/)
  })
})
