/**
 * RipVanFishAppearance - locks the Z snore trail wiring for sprite $3D.
 *
 * The Zs are minor extended sprites of type $06 spawned by CODE_02C0D9
 * (bank_02.asm:8604) only from the sleeping branch CODE_02C044
 * (bank_02.asm:8530). Per-particle update CODE_028DDB (bank_02.asm:1784)
 * picks a tile from `RipVanFishZsTiles` (`db $F1,$F0,$E1,$E0`,
 * bank_02.asm:1781) indexed by `(timer >> 5) & 3` over the timer's
 * $7F → $00 countdown - yielding cycle $E0 → $E1 → $F0 → $F1.
 *
 * The editor exposes that cycle as `Z_TILES` and resolves the four
 * 8x8 chars in `fromTables`. Pose chars (sleep/awake) are tested
 * elsewhere; this file pins the trail.
 *
 * Test tree
 * ─────────
 *   Z_TILES is the ROM-derived cycle order
 *   fromTables builds 4 zParts from the OBJ char window
 *   - palette/charHigh propagate to every zPart
 *   - chars resolve at OBJ_BASE + charHigh + tile
 *   - dx/dy/flips default to zero/false (positions computed at render)
 */
import { describe, expect, it } from 'vitest'
import { Char } from '../../../src/rom/model/chars/Char'
import {
  RIP_VAN_FISH_FRAMES,
  RipVanFishAppearance,
  Z_LIFETIME_FRAMES,
  Z_TILES,
  Z_TRAJECTORY,
} from '../../../src/rom/model/sprites/appearances/RipVanFishAppearance'

const OBJ_BASE = 0x400

function syntheticChar(id: number): Char {
  return new Char(id, { getPixels: () => new Uint8Array(64) })
}
const placeholder = syntheticChar(-1)

function buildChars(): Map<number, Char> {
  const map = new Map<number, Char>()
  for (let id = 0; id < 0x800; id++) map.set(id, syntheticChar(id))
  return map
}

describe('RipVanFishAppearance Z snore trail', () => {
  it('Z_TILES matches the ROM cycle $E0 → $E1 → $F0 → $F1', () => {
    expect([...Z_TILES]).toEqual([0xe0, 0xe1, 0xf0, 0xf1])
  })

  it('fromTables builds 4 zParts from the OBJ char window', () => {
    const palette = 9
    const charHigh = 0x000
    const a = RipVanFishAppearance.fromTables(buildChars(), palette, charHigh, placeholder)

    expect(a.zParts).toHaveLength(4)
    for (let i = 0; i < 4; i++) {
      const p = a.zParts[i]
      expect(p.char.id).toBe(OBJ_BASE + charHigh + Z_TILES[i])
      expect(p.palette).toBe(palette)
      expect(p.flipX).toBe(false)
      expect(p.flipY).toBe(false)
      expect(p.dx).toBe(0)
      expect(p.dy).toBe(0)
    }
  })

  it('charHigh routes Z chars to the upper VRAM page', () => {
    const a = RipVanFishAppearance.fromTables(buildChars(), 9, 0x100, placeholder)
    expect(a.zParts.map(p => p.char.id)).toEqual([
      OBJ_BASE + 0x100 + 0xe0,
      OBJ_BASE + 0x100 + 0xe1,
      OBJ_BASE + 0x100 + 0xf0,
      OBJ_BASE + 0x100 + 0xf1,
    ])
  })

  it('falls back to the placeholder when a Z char is missing from the map', () => {
    const sparseChars = new Map<number, Char>()
    sparseChars.set(OBJ_BASE + 0xe0, syntheticChar(OBJ_BASE + 0xe0))
    // Pose chars (8C/AC) also missing - fromTables will fall back for those
    // too; we only assert the trail behavior here.
    const a = RipVanFishAppearance.fromTables(sparseChars, 9, 0x000, placeholder)
    expect(a.zParts[0].char.id).toBe(OBJ_BASE + 0xe0)
    expect(a.zParts[1].char).toBe(placeholder)
    expect(a.zParts[2].char).toBe(placeholder)
    expect(a.zParts[3].char).toBe(placeholder)
  })

  it('tickAnimation advances without throwing (drives the trail forward)', () => {
    const a = RipVanFishAppearance.fromTables(buildChars(), 9, 0x000, placeholder)
    // Just smoke-test: the timer must accept many ticks without growing
    // unboundedly (it's wrapped mod the spawn cycle). A handful of ticks
    // exceeds the wrap point (120 / 7.5 = 16 ticks per full cycle).
    for (let i = 0; i < 100; i++) a.tickAnimation()
    // No assertion on internal state - that's an implementation detail.
    // The contract is "doesn't throw, doesn't drift to NaN".
    expect(a.zParts).toHaveLength(4)
  })
})

describe('RipVanFishAppearance Z trajectory (ROM physics simulation)', () => {
  it('lifetime matches the ROM kill-check at timer $14', () => {
    // CODE_028DDB:1834 - slot is killed when decremented timer == $14,
    // so visible frames are timer values $7E..$15 = 106 frames.
    expect(Z_LIFETIME_FRAMES).toBe(106)
    expect(Z_TRAJECTORY).toHaveLength(106)
  })

  it('first frame matches CODE_02C0F2 spawn + one CODE_028DDB step', () => {
    // Spawner: dx=$06, dy=0, XSpeed=$FA. After first CODE_028DDB step:
    //   timer 7F → 7E (bit 4 set), XSpeed += 1 → -5
    //   sub += ($FB << 4) & $FF = $B0 = 176, no carry
    //   intHigh = $0F sign-ext to -1, dx += -1 → 5
    //   timer & 3 = 2, dy unchanged
    //   tile: (timer>>5)&3 = 3, ROM table[3] = $E0, our tileIdx = 0
    expect(Z_TRAJECTORY[0]).toEqual({ tileIdx: 0, dx: 5, dy: 0 })
  })

  it('cycles through all four stages E0 → E1 → F0 → F1', () => {
    const e0 = Z_TRAJECTORY.filter(f => f.tileIdx === 0)
    const e1 = Z_TRAJECTORY.filter(f => f.tileIdx === 1)
    const f0 = Z_TRAJECTORY.filter(f => f.tileIdx === 2)
    const f1 = Z_TRAJECTORY.filter(f => f.tileIdx === 3)
    // ROM `(timer >> 5) & 3` slices the timer's $7E..$15 lifetime into:
    //   $7E..$60 (31 frames) → $E0
    //   $5F..$40 (32 frames) → $E1
    //   $3F..$20 (32 frames) → $F0
    //   $1F..$15 (11 frames) → $F1 (end-of-life "pop" sparkle)
    expect(e0).toHaveLength(31)
    expect(e1).toHaveLength(32)
    expect(f0).toHaveLength(32)
    expect(f1).toHaveLength(11)
    expect(Z_TRAJECTORY.findIndex(f => f.tileIdx === 0)).toBe(0)
    expect(Z_TRAJECTORY.findIndex(f => f.tileIdx === 1)).toBe(31)
    expect(Z_TRAJECTORY.findIndex(f => f.tileIdx === 2)).toBe(63)
    expect(Z_TRAJECTORY.findIndex(f => f.tileIdx === 3)).toBe(95)
    expect(Z_TILES[3]).toBe(0xf1)
  })

  it('drift forms a near-vertical column (matching the Mesen reference)', () => {
    // ROM XSpeed wobbles between $FA and $09 every 16 frames; net X
    // motion stays within ~10 px of spawn. ROM Y stair-steps -1 every
    // 4 frames, drifting up the full lifetime.
    const dxs = Z_TRAJECTORY.map(f => f.dx)
    const dys = Z_TRAJECTORY.map(f => f.dy)
    // X stays within a tight band - no runaway leftward linear drift.
    expect(Math.min(...dxs)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...dxs)).toBeLessThanOrEqual(20)
    expect(Math.max(...dxs) - Math.min(...dxs)).toBeLessThanOrEqual(15)
    // Y drifts strictly upward (smaller-or-equal each frame).
    for (let i = 1; i < dys.length; i++) {
      expect(dys[i]).toBeLessThanOrEqual(dys[i - 1])
    }
    // Final Y is roughly -lifetime/4 (one stair-step every 4 frames).
    expect(Z_TRAJECTORY.at(-1)!.dy).toBeLessThan(-20)
    expect(Z_TRAJECTORY.at(-1)!.dy).toBeGreaterThan(-30)
  })
})

describe('RipVanFishAppearance body-frame animation', () => {
  const palette = 9
  const charHigh = 0x100 // matches the in-game spriteAttr & 1 routing

  it('exposes a 2-frame pair for both sleep and awake states', () => {
    const a = RipVanFishAppearance.fromTables(buildChars(), palette, charHigh, placeholder)
    expect(a.sleepFrames).toHaveLength(2)
    expect(a.awakeFrames).toHaveLength(2)
    // Each frame is a 16x16 big-tile expanded to 4 corners.
    expect(a.sleepFrames[0]).toHaveLength(4)
    expect(a.sleepFrames[1]).toHaveLength(4)
    expect(a.awakeFrames[0]).toHaveLength(4)
    expect(a.awakeFrames[1]).toHaveLength(4)
  })

  it('sleep[0] = sleepB ($8E), sleep[1] = sleepA ($8C)', () => {
    // fromTables puts sleepB first so $8C (eyes-blink frame) is the initial
    // display at romFrame=0 (the `(romFrame & $30) == 0` branch picks index 1).
    // misc1602 dispatch (CODE_02C07B): 2 → $8C, 3 → $8E.
    expect(RIP_VAN_FISH_FRAMES.sleepA).toBe(0x8c)
    expect(RIP_VAN_FISH_FRAMES.sleepB).toBe(0x8e)
    const a = RipVanFishAppearance.fromTables(buildChars(), palette, charHigh, placeholder)
    expect(a.sleepFrames[0][0].char.id).toBe(OBJ_BASE + charHigh + 0x8e)
    expect(a.sleepFrames[1][0].char.id).toBe(OBJ_BASE + charHigh + 0x8c)
  })

  it('awake[0] = awakeA ($AE), awake[1] = awakeB ($AC)', () => {
    // misc1602 dispatch (CODE_02C0BB): 0 → $AE, 1 → $AC.
    expect(RIP_VAN_FISH_FRAMES.awakeA).toBe(0xae)
    expect(RIP_VAN_FISH_FRAMES.awakeB).toBe(0xac)
    const a = RipVanFishAppearance.fromTables(buildChars(), palette, charHigh, placeholder)
    expect(a.awakeFrames[0][0].char.id).toBe(OBJ_BASE + charHigh + 0xae)
    expect(a.awakeFrames[1][0].char.id).toBe(OBJ_BASE + charHigh + 0xac)
  })

  it('big-tile expansion places corners at base, base+1, base+$10, base+$11', () => {
    const a = RipVanFishAppearance.fromTables(buildChars(), palette, charHigh, placeholder)
    // sleepB = $8E (index 0) → corners $8E, $8F, $9E, $9F at TL/TR/BL/BR.
    const sleepB = a.sleepFrames[0]
    expect(sleepB.map(p => p.char.id - OBJ_BASE - charHigh)).toEqual([0x8e, 0x8f, 0x9e, 0x9f])
    expect(sleepB.map(p => ({ dx: p.dx, dy: p.dy }))).toEqual([
      { dx: 0, dy: 0 },
      { dx: 8, dy: 0 },
      { dx: 0, dy: 8 },
      { dx: 8, dy: 8 },
    ])
  })
})
