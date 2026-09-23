import { describe, it, expect } from 'vitest'
import { buildLevelAnimation } from '../../../src/rom/PaletteAnimationView'
import type {
  PaletteAnimContext,
  PaletteAnimDetection,
  PaletteAnimTarget,
} from '../../../src/rom/PaletteAnimationDetect'

const timing = { maskAddr: 0x00a423, mask: 0x1c, shift: 1, counterDp: 0x14 }

function target(over: Partial<PaletteAnimTarget> = {}): PaletteAnimTarget {
  return {
    cgramIdx: 0x64,
    cgramIdxAddr: 0x00a41a,
    tableAddr: 0x00b60c,
    phaseCount: 4,
    frameStride: 4,
    colors: [0x001f, 0x03e0, 0x7c00, 0x001f],
    frameAddrs: [0x00b60c, 0x00b60e, 0x00b610, 0x00b60c],
    timing,
    kernelAddr: 0x00a41e,
    ...over,
  }
}

const ctx = (c: Partial<PaletteAnimContext>): PaletteAnimContext => ({
  context: 'level',
  available: true,
  targets: [],
  notes: [],
  ...c,
})

const detection = (
  level: PaletteAnimContext,
  overworld = ctx({ context: 'overworld' }),
): PaletteAnimDetection => ({
  level,
  overworld,
})

describe('buildLevelAnimation', () => {
  it('gives every frame its own color and ROM address, in counter order', () => {
    const v = buildLevelAnimation(detection(ctx({ targets: [target()] })))
    expect(v.available).toBe(true)
    expect(v.targets[0]!.frames.map(f => f.romAddr)).toEqual([
      0x00b60c, 0x00b60e, 0x00b610, 0x00b60c,
    ])
    expect(v.targets[0]!.frames[0]!.color).toEqual([255, 0, 0, 255])
    expect(v.targets[0]!.timing).toEqual(timing)
    expect(v.targets[0]!.intervalMs).toBe(67)
  })

  it('reports unavailable with the detector notes and no targets when the level context is blind', () => {
    const v = buildLevelAnimation(
      detection(ctx({ available: false, notes: ['$00A418 holds 0x60, wanted SEP #$20'] })),
    )
    expect(v).toEqual({
      available: false,
      notes: ['$00A418 holds 0x60, wanted SEP #$20'],
      targets: [],
    })
  })

  it('never emits targets for an unavailable context even if the detector left some behind', () => {
    const v = buildLevelAnimation(detection(ctx({ available: false, targets: [target()] })))
    expect(v.targets).toEqual([])
  })

  it('flags a target whose frame words another target also reads', () => {
    const ow = ctx({
      context: 'overworld',
      targets: [target({ cgramIdx: 0x6d, frameAddrs: [0x00b610] })],
    })
    const v = buildLevelAnimation(detection(ctx({ targets: [target()] }), ow))
    expect(v.targets[0]!.sharedWithOtherTargets).toBe(true)
  })

  it('does not flag a target whose words no other target reads', () => {
    const ow = ctx({
      context: 'overworld',
      targets: [target({ cgramIdx: 0x6d, frameAddrs: [0x00b700] })],
    })
    const v = buildLevelAnimation(detection(ctx({ targets: [target()] }), ow))
    expect(v.targets[0]!.sharedWithOtherTargets).toBe(false)
  })

  // Stock $64 and overworld $6D read the same words (bank_00.asm:4664-4676,
  // reached for $6D by JSR CODE_00A41C at :4780), so a blind overworld is
  // exactly the case where "no other reader" cannot be claimed.
  it('reports unknown, not false, when the overworld context could not be read', () => {
    const ow = ctx({ context: 'overworld', available: false, notes: ['moved'] })
    const v = buildLevelAnimation(
      detection(ctx({ targets: [target({ frameAddrs: [0x00b700] })] }), ow),
    )
    expect(v.targets[0]!.sharedWithOtherTargets).toBe('unknown')
  })

  it('still reports true when another level target shares a word, overworld blind or not', () => {
    const ow = ctx({ context: 'overworld', available: false })
    const v = buildLevelAnimation(
      detection(
        ctx({ targets: [target(), target({ cgramIdx: 0x65, frameAddrs: [0x00b610] })] }),
        ow,
      ),
    )
    expect(v.targets[0]!.sharedWithOtherTargets).toBe(true)
  })
})
