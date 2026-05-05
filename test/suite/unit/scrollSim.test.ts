/**
 * scrollSim — frame-based scroll simulator.
 *
 * Phase 1 tests cover the scaffolding only (state shape, initial-state
 * construction, no-op cmds, hold-fallback). Per-cmd correctness tests
 * live in companion files (`scrollCmd*.test.ts`) and validate against
 * Mesen captures in `tools/mesen/<level>/l2_scroll.csv`.
 */

import { describe, it, expect } from 'vitest'
import { buildScrollSimulator, type ScrollSimSeed } from '../../../src/rom/scrollSim'

const fakeRom = null as unknown as Parameters<typeof buildScrollSimulator>[0]

const baseSeed: ScrollSimSeed = {
  layer1XPos: 0x100,
  layer1YPos: 0x80,
  layer2XPos: 0x100,
  layer2YPos: 0xC0,
  layer1ScrollCmd:  0x07, // no-op
  layer2ScrollCmd:  0x07, // no-op
  layer1ScrollBits: 0,
  layer2ScrollBits: 0,
  horizLayer2Setting: 0,
  vertLayer2Setting:  1,
  marioSpawnX: 0x40,
  marioSpawnY: 0x60,
}

describe('buildScrollSimulator — initial state', () => {
  it('seeds positions and 8-bit fields with wrap-around', () => {
    const sim = buildScrollSimulator(fakeRom, {
      ...baseSeed,
      layer1XPos: 0x10100,           // wraps to $0100
      layer1ScrollCmd: 0x107,        // wraps to $07
    })
    expect(sim.initial.layer1XPos).toBe(0x100)
    expect(sim.initial.layer1ScrollCmd).toBe(0x07)
  })

  it('sets next* targets equal to starting positions so static cmds hold', () => {
    const sim = buildScrollSimulator(fakeRom, baseSeed)
    expect(sim.initial.nextLayer1XPos).toBe(baseSeed.layer1XPos)
    expect(sim.initial.nextLayer1YPos).toBe(baseSeed.layer1YPos)
    expect(sim.initial.nextLayer2XPos).toBe(baseSeed.layer2XPos)
    expect(sim.initial.nextLayer2YPos).toBe(baseSeed.layer2YPos)
  })

  it('zeroes per-axis accumulators (timers, types, speeds, fractional carries)', () => {
    const sim = buildScrollSimulator(fakeRom, baseSeed)
    expect(sim.initial.layer1ScrollType).toBe(0)
    expect(sim.initial.layer1ScrollTimer).toBe(0)
    expect(sim.initial.layer1ScrollXSpeed).toBe(0)
    expect(sim.initial.layer1ScrollYPosUpd).toBe(0)
    expect(sim.initial.layer2ScrollXSpeed).toBe(0)
    expect(sim.initial.scrollLayerIndex).toBe(0)
  })

  it('seeds Mario projection from the spawn fields', () => {
    const sim = buildScrollSimulator(fakeRom, baseSeed)
    expect(sim.initial.playerXPosNext).toBe(0x40)
    expect(sim.initial.playerYPosNext).toBe(0x60)
  })
})

describe('buildScrollSimulator — no-op cmds', () => {
  it('cmd $07 holds positions exactly across many frames', () => {
    const sim = buildScrollSimulator(fakeRom, {
      ...baseSeed,
      layer1ScrollCmd: 0x07,
      layer2ScrollCmd: 0x07,
    })
    for (let f = 0; f < 60; f++) {
      const s = sim.stateAtFrame(f)
      expect(s.layer1XPos).toBe(baseSeed.layer1XPos)
      expect(s.layer1YPos).toBe(baseSeed.layer1YPos)
      expect(s.layer2XPos).toBe(baseSeed.layer2XPos)
      expect(s.layer2YPos).toBe(baseSeed.layer2YPos)
    }
  })

  it('cmd $09 is also a no-op', () => {
    const sim = buildScrollSimulator(fakeRom, {
      ...baseSeed,
      layer1ScrollCmd: 0x09,
      layer2ScrollCmd: 0x09,
    })
    expect(sim.stateAtFrame(120).layer1YPos).toBe(baseSeed.layer1YPos)
  })
})

describe('buildScrollSimulator — hold fallback', () => {
  it('returns state unchanged for unported cmds (and warns once)', () => {
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => { warns.push(msg) }
    try {
      const sim = buildScrollSimulator(fakeRom, {
        ...baseSeed,
        layer1ScrollCmd: 0xFE, // arbitrary unported cmd
        layer2ScrollCmd: 0x07,
      })
      const s = sim.stateAtFrame(10)
      expect(s.layer1YPos).toBe(baseSeed.layer1YPos)
      expect(warns.some(m => m.includes('cmd $fe not yet ported'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })
})

describe('buildScrollSimulator — memoization', () => {
  it('stateAtFrame(N) returns the same reference across calls', () => {
    const sim = buildScrollSimulator(fakeRom, baseSeed)
    const a = sim.stateAtFrame(5)
    const b = sim.stateAtFrame(5)
    expect(a).toBe(b)
  })

  it('frame counter increments by 1 per tick', () => {
    const sim = buildScrollSimulator(fakeRom, baseSeed)
    expect(sim.stateAtFrame(0).frame).toBe(0)
    expect(sim.stateAtFrame(1).frame).toBe(1)
    expect(sim.stateAtFrame(7).frame).toBe(7)
  })
})
