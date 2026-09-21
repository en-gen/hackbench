import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  isLmExAnimInstalled,
  loadExAnimData,
  mergeAnimationData,
} from '../../../src/rom/ExAnimationLoader'
import type { AnimationData } from '../../../src/rom/AnimationLoader'

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

describe('isLmExAnimInstalled', () => {
  if (!romPresent) {
    it.skip('ROM not available', () => {})
    return
  }

  const rom = SmwRom.open(ROM_PATH)

  it('returns false for vanilla ROM', () => {
    expect(isLmExAnimInstalled(rom.rom)).toBe(false)
  })
})

describe('loadExAnimData', () => {
  if (!romPresent) {
    it.skip('ROM not available', () => {})
    return
  }

  const rom = SmwRom.open(ROM_PATH)

  it('returns null for vanilla ROM (no LM ExAnim installed)', () => {
    expect(loadExAnimData(rom.rom, 0)).toBeNull()
    expect(loadExAnimData(rom.rom, 0x24)).toBeNull()
  })
})

describe('mergeAnimationData', () => {
  function makeAnimData(frameCount: number, charBases: number[]): AnimationData {
    const frames = Array.from({ length: frameCount }, (_, f) =>
      charBases.map(charBase => ({
        charBase,
        tiles: Array.from({ length: 4 }, () => new Uint8Array(64).fill(f + 1)),
      })),
    )
    return { frameCount, frames, intervalMs: 133 }
  }

  it('produces LCM frame count from two 4-frame sets', () => {
    const a = makeAnimData(4, [0x000])
    const b = makeAnimData(4, [0x100])
    const merged = mergeAnimationData(a, b)
    expect(merged.frameCount).toBe(4)
    expect(merged.frames.length).toBe(4)
  })

  it('produces LCM frame count when one is 4 and other is 8', () => {
    const a = makeAnimData(4, [0x000])
    const b = makeAnimData(8, [0x100])
    const merged = mergeAnimationData(a, b)
    expect(merged.frameCount).toBe(8)
    expect(merged.frames.length).toBe(8)
  })

  it('each frame contains slots from both sources', () => {
    const a = makeAnimData(4, [0x000])
    const b = makeAnimData(4, [0x100])
    const merged = mergeAnimationData(a, b)
    for (const frame of merged.frames) {
      const charBases = frame.map(s => s.charBase)
      expect(charBases).toContain(0x000)
      expect(charBases).toContain(0x100)
    }
  })

  it('b slots appear after a slots in each frame (override wins in collectAnimFrames)', () => {
    const a = makeAnimData(2, [0x080])
    const b = makeAnimData(2, [0x080]) // same charBase, b overrides a
    const merged = mergeAnimationData(a, b)
    // Both charBase 0x080 present; b's entry (fill=2) is last in frame array
    const frame0 = merged.frames[0]
    const last080 = [...frame0].reverse().find(s => s.charBase === 0x080)!
    expect(last080.tiles[0][0]).toBe(1) // frame 0 fill = f+1 = 1 for b
  })

  it('tiles shorter source across the LCM period', () => {
    const a = makeAnimData(2, [0x000]) // 2-frame source
    const b = makeAnimData(4, [0x100]) // 4-frame source → LCM = 4
    const merged = mergeAnimationData(a, b)
    expect(merged.frameCount).toBe(4)
    // a's char $000 at frame 2 should use a's frame 0 (tiled: 2 % 2 = 0)
    const aSlotAtFrame2 = merged.frames[2].find(s => s.charBase === 0x000)!
    const aSlotAtFrame0 = merged.frames[0].find(s => s.charBase === 0x000)!
    expect(aSlotAtFrame2.tiles[0]).toEqual(aSlotAtFrame0.tiles[0])
  })

  it('uses minimum intervalMs', () => {
    const a: AnimationData = { frameCount: 4, frames: [[], [], [], []], intervalMs: 200 }
    const b: AnimationData = { frameCount: 4, frames: [[], [], [], []], intervalMs: 133 }
    expect(mergeAnimationData(a, b).intervalMs).toBe(133)
  })
})
