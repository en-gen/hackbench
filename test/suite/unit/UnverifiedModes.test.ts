import { describe, expect, it } from 'vitest'
import { isUnverifiedMode, UNVERIFIED_MODES } from '../../../src/rom/model/UnverifiedModes'

describe('UnverifiedModes', () => {
  it('holds mode 1E and nothing else (#617)', () => {
    expect([...UNVERIFIED_MODES]).toEqual([0x1e])
  })

  it('flags 1E and no other mode in 00-1F', () => {
    for (let mode = 0; mode <= 0x1f; mode++) {
      expect(isUnverifiedMode(mode), `mode ${mode.toString(16)}`).toBe(mode === 0x1e)
    }
  })

  it('treats a missing mode as verified', () => {
    expect(isUnverifiedMode(undefined)).toBe(false)
  })
})
