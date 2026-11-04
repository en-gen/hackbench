import { describe, it, expect } from 'vitest'
import { tideBgX } from '../../../src/rom/L3TideX'

describe('tideBgX (bank_05.asm:5624-5629)', () => {
  it('adds one per frame with a still camera', () => {
    expect(tideBgX(0, 0, 0)).toBe(0x100)
    expect(tideBgX(0, 1, 0)).toBe(0x101)
    expect(tideBgX(0, 40, 0)).toBe(0x128)
  })
  it('adds a positive camera step on top', () => {
    expect(tideBgX(0, 10, 3)).toBe(0x10d)
  })
  it('subtracts a negative camera step', () => {
    expect(tideBgX(0x20, 5, -9)).toBe(0x11c)
    expect(tideBgX(0, 0, -1)).toBe(0x1ff)
  })
  it('wraps the low byte at 256 and keeps the high byte at 1', () => {
    expect(tideBgX(0xff, 1, 0)).toBe(0x100)
    expect(tideBgX(0, 256, 0)).toBe(0x100)
    for (let n = 0; n < 700; n += 7) expect(tideBgX(5, n, n % 3) >> 8).toBe(1)
  })
  // Numbers read from layers_v5 captures (vanilla, one machine, BG3HOFS of the
  // per-window ppu json); they are register values, not ROM bytes. The DX term
  // is ASM only: no capture exercises a nonzero Layer1DXPos here.
  it('matches $002 reading 502 (=$1F6) 502 frames after its first GM14 frame', () => {
    expect(tideBgX(0, 502, 0)).toBe(0x1f6)
  })
  it('matches $0BE reading 430 (=$1AE) at 15 + 159 frames', () => {
    expect(tideBgX(15, 159, 0)).toBe(0x1ae)
  })
})
