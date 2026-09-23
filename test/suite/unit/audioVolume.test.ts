import { describe, it, expect } from 'vitest'
import {
  DEFAULT_VOLUME,
  MAX_VOLUME,
  effectiveGain,
  parseVolumeState,
  setVolume,
  toggleMute,
} from '../../../theia/extension/src/browser/audio-volume'

describe('volume state', () => {
  it('mute silences without forgetting the level, and unmute restores it', () => {
    const muted = toggleMute({ volume: 0.4, muted: false })
    expect(effectiveGain(muted)).toBe(0)
    expect(muted.volume).toBe(0.4)
    expect(effectiveGain(toggleMute(muted))).toBe(0.4)
  })

  it('unmuting at zero volume comes back audible, not as a click that does nothing', () => {
    expect(effectiveGain(toggleMute({ volume: 0, muted: true }))).toBe(DEFAULT_VOLUME)
  })

  it('moving the slider while muted unmutes, the way every media player behaves', () => {
    expect(setVolume(0.7)).toEqual({ volume: 0.7, muted: false })
  })

  it('clamps the slider range to 0..MAX_VOLUME', () => {
    expect(setVolume(9).volume).toBe(MAX_VOLUME)
    expect(setVolume(-1).volume).toBe(0)
  })

  it('persisted state is validated, not trusted', () => {
    expect(parseVolumeState({ volume: 0.5, muted: true })).toEqual({ volume: 0.5, muted: true })
    expect(parseVolumeState({ volume: 7, muted: false }).volume).toBe(MAX_VOLUME)
    for (const junk of [undefined, null, 'loud', { volume: 'x' }, { volume: NaN }]) {
      expect(parseVolumeState(junk)).toEqual({ volume: DEFAULT_VOLUME, muted: false })
    }
  })
})
