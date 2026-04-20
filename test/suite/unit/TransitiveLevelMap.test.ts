import { describe, it, expect } from 'vitest'
import { buildTransitiveLevelMap } from '../../../src/rom/LevelTree'

// Subarea range is outside overworld ranges ($000-$024 main, $101-$13B submaps).
// Using $0C0-$0FF and $1C0-$1FF as fake subareas.

describe('buildTransitiveLevelMap', () => {
  it('walks a 3-deep chain: root -> A -> B -> C', () => {
    const exitGraph = new Map<number, number[]>([
      [0x001, [0x0C0]],
      [0x0C0, [0x0C1]],
      [0x0C1, [0x0C2]],
    ])
    const result = buildTransitiveLevelMap([0x001], exitGraph)
    expect(result.get(0x001)).toEqual([0x0C0, 0x0C1, 0x0C2])
  })

  it('descends through a child that is not in the classified subarea set', () => {
    // Dedup-drop case from vanilla SMW: $0DB -> $0D9 where $0D9 was
    // skipped by classifyLevels because it shares an L1 pointer with an
    // earlier level. BFS must still reach it (no subareaSet gate).
    const exitGraph = new Map<number, number[]>([
      [0x00E, [0x0DC]],
      [0x0DC, [0x0DB]],
      [0x0DB, [0x0D9]],
    ])
    const result = buildTransitiveLevelMap([0x00E], exitGraph)
    expect(result.get(0x00E)).toEqual([0x0DC, 0x0DB, 0x0D9])
  })

  it('terminates on a back-edge cycle: root -> A -> B -> A', () => {
    const exitGraph = new Map<number, number[]>([
      [0x001, [0x0C0]],
      [0x0C0, [0x0C1]],
      [0x0C1, [0x0C0]],
    ])
    const result = buildTransitiveLevelMap([0x001], exitGraph)
    expect(result.get(0x001)).toEqual([0x0C0, 0x0C1])
  })

  it('terminates on a self-loop: root -> A -> A', () => {
    const exitGraph = new Map<number, number[]>([
      [0x001, [0x0C0]],
      [0x0C0, [0x0C0]],
    ])
    const result = buildTransitiveLevelMap([0x001], exitGraph)
    expect(result.get(0x001)).toEqual([0x0C0])
  })

  it('does not descend into overworld-classified children', () => {
    // Main-map indices ($000-$024, $101-$13B) must be gated out.
    const exitGraph = new Map<number, number[]>([
      [0x001, [0x0C0, 0x002]],   // $002 is overworld, must be skipped
      [0x0C0, [0x101]],           // $101 is overworld (submap range), must be skipped
    ])
    const result = buildTransitiveLevelMap([0x001], exitGraph)
    expect(result.get(0x001)).toEqual([0x0C0])
  })

  it('returns empty array for a root with no exits', () => {
    const exitGraph = new Map<number, number[]>()
    const result = buildTransitiveLevelMap([0x001], exitGraph)
    expect(result.get(0x001)).toEqual([])
  })

  it('handles multiple roots independently', () => {
    const exitGraph = new Map<number, number[]>([
      [0x001, [0x0C0]],
      [0x002, [0x0D0, 0x0D1]],
    ])
    const result = buildTransitiveLevelMap([0x001, 0x002], exitGraph)
    expect(result.get(0x001)).toEqual([0x0C0])
    expect(result.get(0x002)).toEqual([0x0D0, 0x0D1])
  })

  it('does not double-add a subarea reachable via multiple paths', () => {
    const exitGraph = new Map<number, number[]>([
      [0x001, [0x0C0, 0x0C1]],
      [0x0C0, [0x0C2]],
      [0x0C1, [0x0C2]],
    ])
    const result = buildTransitiveLevelMap([0x001], exitGraph)
    expect(result.get(0x001)).toEqual([0x0C0, 0x0C1, 0x0C2])
  })
})
