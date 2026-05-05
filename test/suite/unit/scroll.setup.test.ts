/**
 * scroll.setup.test.ts — branch coverage for applyCmdSetup / applyCmd0001Setup
 * (src/rom/scroll/setup.ts, CODE_05BD36 / CODE_05BD4C port).
 *
 * Test tree:
 *   applyCmdSetup dispatch
 *     - cmd $00 → delegates to applyCmd0001Setup
 *     - cmd $01 → delegates to applyCmd0001Setup
 *     - any other cmd → passthrough (default branch)
 *   applyCmd0001Setup
 *     - bits=0: l1Type=DATA_05CA61[0]=0x01, l1Timer=DATA_05CA68[0]=0x16
 *     - bits=1: l1Type=0x18, l1Timer=0x05
 *     - L2 bits independent of L1 bits
 *     - all speed + posUpd fields zeroed regardless of input
 *     - out-of-range bits: ?fallback to 0 (covers ?? branches)
 */

import { describe, it, expect } from 'vitest'
import { applyCmdSetup, applyCmd0001Setup } from '../../../src/rom/scroll/setup'
import { DATA_05CA61, DATA_05CA68 } from '../../../src/rom/scrollData'
import type { ScrollState } from '../../../src/rom/scrollSim'

const base: ScrollState = {
  frame: 0,
  layer1XPos: 0, layer1YPos: 0, layer2XPos: 0, layer2YPos: 0,
  layer1ScrollCmd: 0x01, layer2ScrollCmd: 0x01,
  layer1ScrollBits: 0, layer2ScrollBits: 0,
  layer1ScrollType: 0xFF, layer2ScrollType: 0xFF,
  layer1ScrollTimer: 0xFF, layer2ScrollTimer: 0xFF,
  layer1ScrollXSpeed: 0x1234, layer1ScrollYSpeed: 0xABCD,
  layer2ScrollXSpeed: 0x5678, layer2ScrollYSpeed: 0xDEAD,
  layer1ScrollXPosUpd: 0x0100, layer1ScrollYPosUpd: 0x0200,
  layer2ScrollXPosUpd: 0x0300, layer2ScrollYPosUpd: 0x0400,
  scrollLayerIndex: 0, layer1ScrollDir: 0,
  nextLayer1XPos: 0, nextLayer1YPos: 0,
  nextLayer2XPos: 0, nextLayer2YPos: 0,
  playerXPosNext: 0, playerYPosNext: 0,
  screenShakeYOffset: 0,
  horizLayer2Setting: 0, vertLayer2Setting: 0,
}

// ── applyCmdSetup dispatch ────────────────────────────────────────────────

describe('applyCmdSetup — cmd dispatch', () => {
  it('cmd $00 applies the shared $00/$01 setup', () => {
    // ASM: CODE_05BCE9 dispatches cmd $00 to CODE_05BD36
    const r = applyCmdSetup({ ...base, layer1ScrollCmd: 0x00 })
    expect(r.layer1ScrollType).toBe(DATA_05CA61[0])
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68[0])
  })

  it('cmd $01 applies the shared $00/$01 setup', () => {
    const r = applyCmdSetup({ ...base, layer1ScrollCmd: 0x01 })
    expect(r.layer1ScrollType).toBe(DATA_05CA61[0])
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68[0])
  })

  it('unported cmd passes state through unchanged (default branch)', () => {
    // ASM: cmds without a ported setup routine are held at their initial values.
    const s = { ...base, layer1ScrollCmd: 0x05 }
    const r = applyCmdSetup(s)
    expect(r).toBe(s)                              // identity — same reference
    expect(r.layer1ScrollType).toBe(0xFF)          // unchanged
    expect(r.layer1ScrollXSpeed).toBe(0x1234)      // unchanged
  })
})

// ── applyCmd0001Setup — table lookups ─────────────────────────────────────

describe('applyCmd0001Setup — ScrollType and ScrollTimer from ROM tables', () => {
  it('bits=0 → type=DATA_05CA61[0], timer=DATA_05CA68[0]', () => {
    const r = applyCmd0001Setup({ ...base, layer1ScrollBits: 0, layer2ScrollBits: 0 })
    expect(r.layer1ScrollType).toBe(DATA_05CA61[0])    // 0x01
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68[0])   // 0x16
  })

  it('bits=1 → type=DATA_05CA61[1], timer=DATA_05CA68[1]', () => {
    const r = applyCmd0001Setup({ ...base, layer1ScrollBits: 1, layer2ScrollBits: 1 })
    expect(r.layer1ScrollType).toBe(DATA_05CA61[1])    // 0x18
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68[1])   // 0x05
  })

  it('bits=2: third entry in each table', () => {
    const r = applyCmd0001Setup({ ...base, layer1ScrollBits: 2, layer2ScrollBits: 2 })
    expect(r.layer1ScrollType).toBe(DATA_05CA61[2])
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68[2])
  })

  it('L2 bits are independent of L1 bits', () => {
    const r = applyCmd0001Setup({ ...base, layer1ScrollBits: 0, layer2ScrollBits: 1 })
    expect(r.layer1ScrollType).toBe(DATA_05CA61[0])
    expect(r.layer2ScrollType).toBe(DATA_05CA61[1])
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68[0])
    expect(r.layer2ScrollTimer).toBe(DATA_05CA68[1])
  })

  it('out-of-range bits fall back to 0 (covers ?? 0 branches)', () => {
    // DATA_05CA61 has 7 entries (indices 0-6); index 99 is undefined → ?? 0
    const r = applyCmd0001Setup({ ...base, layer1ScrollBits: 99, layer2ScrollBits: 99 })
    expect(r.layer1ScrollType).toBe(0)
    expect(r.layer1ScrollTimer).toBe(0)
    expect(r.layer2ScrollType).toBe(0)
    expect(r.layer2ScrollTimer).toBe(0)
  })
})

// ── applyCmd0001Setup — speed + accumulator zeroing ──────────────────────

describe('applyCmd0001Setup — clears speed and fractional accumulator fields', () => {
  it('zeros all four scroll speeds regardless of prior values', () => {
    // ASM: CODE_05BD4C clears LayerNScrollXSpeed/YSpeed for both layers
    const r = applyCmd0001Setup(base)
    expect(r.layer1ScrollXSpeed).toBe(0)
    expect(r.layer1ScrollYSpeed).toBe(0)
    expect(r.layer2ScrollXSpeed).toBe(0)
    expect(r.layer2ScrollYSpeed).toBe(0)
  })

  it('zeros all four posUpd accumulators', () => {
    const r = applyCmd0001Setup(base)
    expect(r.layer1ScrollXPosUpd).toBe(0)
    expect(r.layer1ScrollYPosUpd).toBe(0)
    expect(r.layer2ScrollXPosUpd).toBe(0)
    expect(r.layer2ScrollYPosUpd).toBe(0)
  })

  it('does not mutate fields unrelated to setup (positions, cmd, bits)', () => {
    const s = { ...base, layer1XPos: 0x1234, nextLayer1XPos: 0xABCD }
    const r = applyCmd0001Setup(s)
    expect(r.layer1XPos).toBe(0x1234)
    expect(r.nextLayer1XPos).toBe(0xABCD)
    expect(r.layer1ScrollCmd).toBe(s.layer1ScrollCmd)
  })
})
