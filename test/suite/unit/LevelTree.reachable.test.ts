import { describe, it, expect } from 'vitest'
import { reachableSlots } from '../../../src/rom/LevelTree'

const graph = (edges: Array<[number, number[]]>): Map<number, number[]> => new Map(edges)

describe('reachableSlots', () => {
  it('neither lists nor enters another root reached mid-walk', () => {
    const g = graph([
      [1, [0xc0]],
      [0xc0, [2]],
      [2, [0xc1]],
    ])
    expect(reachableSlots(1, g, i => i === 1 || i === 2)).toEqual([0xc0])
  })

  it('does not walk through a slot the boundary rejects, a non-map included', () => {
    const g = graph([
      [1, [0xc0, 0xff]],
      [0xff, [0xc9]],
    ])
    expect(reachableSlots(1, g, i => i === 0xff)).toEqual([0xc0])
  })

  it('returns ascending order when the walk visits slots descending', () => {
    const g = graph([
      [1, [0xc9]],
      [0xc9, [0xc5]],
      [0xc5, [0xc2]],
    ])
    expect(reachableSlots(1, g, () => false)).toEqual([0xc2, 0xc5, 0xc9])
  })

  it('excludes the root and terminates on a cycle', () => {
    const g = graph([
      [1, [0xc0]],
      [0xc0, [0xc1]],
      [0xc1, [0xc0, 1]],
    ])
    expect(reachableSlots(1, g, () => false)).toEqual([0xc0, 0xc1])
  })
})
