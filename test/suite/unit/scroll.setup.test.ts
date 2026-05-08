/**
 * scroll.setup.test.ts — branch coverage for the per-layer cmd setup
 * dispatch in `src/rom/scroll/setup.ts`.
 *
 * Test tree:
 *   applyCmdSetup dispatch
 *     - (l1cmd=1, l2cmd=1) → both L1 and L2 cmd $00/$01 bodies run
 *     - (l1cmd=1, l2cmd=0) → L1 body runs, L2 BEQ early-return preserves
 *       l2type=0/l2timer=0 (mirrors `CODE_05BD0E:4600 BEQ Return05BD35`)
 *     - (l1cmd=0, l2cmd=8) → cmd $08 setup body for both layers
 *     - (l1cmd=0, l2cmd=3) → cmd $03 prelude clears vertL2; both bodies run
 *     - any other (cmd) pair → passthrough
 *   Per-layer body details (cmd $00/$01)
 *     - bits=0..2: type=DATA_05CA61[bits], timer=DATA_05CA68[bits]
 *     - L2 bits independent of L1 bits
 *     - speed/posUpd zeroed regardless of input
 *     - out-of-range bits fall back to 0 (covers `?? 0` branches)
 */

import { describe, it, expect } from 'vitest'
import { applyCmdSetup } from '../../../src/rom/scroll/setup'
import {
  ADDR_DATA_05CA61,
  ADDR_DATA_05CA68,
  readByte,
} from '../../../src/rom/scrollData'
import type { ScrollState } from '../../../src/rom/scrollSim'
import { loadVanillaRom, vanillaRomPresent } from './scrollSim_capture'

const rom = vanillaRomPresent ? loadVanillaRom() : null
const DATA_05CA61 = (i: number): number => rom ? readByte(rom, ADDR_DATA_05CA61, i) : 0
const DATA_05CA68 = (i: number): number => rom ? readByte(rom, ADDR_DATA_05CA68, i) : 0

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
  backgroundVertOffset: 0,
  onOffSwitch: 0,
  lastScreenHoriz: 0x1F,
}

// ── Pair dispatch ────────────────────────────────────────────────────────

describe.skipIf(!vanillaRomPresent)('applyCmdSetup — (l1cmd, l2cmd) pair dispatch', () => {
  it('(cmd 1, cmd 1): both L1 and L2 cmd $00/$01 bodies run', () => {
    const r = applyCmdSetup({ ...base, layer1ScrollCmd: 0x01, layer2ScrollCmd: 0x01 }, rom!)
    expect(r.layer1ScrollType).toBe(DATA_05CA61(0))
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68(0))
    expect(r.layer2ScrollType).toBe(DATA_05CA61(0))
    expect(r.layer2ScrollTimer).toBe(DATA_05CA68(0))
  })

  it('(cmd 1, cmd 0): L1 body runs, L2 BEQ early-return holds l2type/timer at 0', () => {
    // Sprite $E8 b0=$0C → post-remap (l1cmd=1, l2cmd=0). L2 dispatch
    // BEQs out at CODE_05BD0E:4600 — l2type / l2timer must stay at the
    // pre-setup value (which is 0 in makeInitialState).
    const s: ScrollState = {
      ...base,
      layer1ScrollCmd: 0x01, layer2ScrollCmd: 0x00,
      layer2ScrollType: 0, layer2ScrollTimer: 0,
    }
    const r = applyCmdSetup(s, rom!)
    expect(r.layer1ScrollType).toBe(DATA_05CA61(0))
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68(0))
    expect(r.layer2ScrollType).toBe(0)        // unchanged
    expect(r.layer2ScrollTimer).toBe(0)       // unchanged
  })

  it('(cmd 0, cmd 8): cmd $08 setup body produces type=1 / timer=$FF / yposupd=$60', () => {
    // Sprite $EF b0=$00 → post-remap (l1cmd=0, l2cmd=8, bits=0).
    // L2 setup writes l1timer=$01 via 16-bit STA side effect.
    const r = applyCmdSetup({
      ...base,
      layer1ScrollCmd: 0x00, layer2ScrollCmd: 0x08,
    }, rom!)
    expect(r.layer1ScrollType).toBe(0x01)
    expect(r.layer2ScrollType).toBe(0x01)
    expect(r.layer1ScrollTimer).toBe(0x01)    // ← side effect from L2 setup's 16-bit STA
    expect(r.layer2ScrollTimer).toBe(0xFF)
    expect(r.layer1ScrollYPosUpd).toBe(0x60)
    expect(r.layer2ScrollYPosUpd).toBe(0x60)
  })

  it('(cmd 0, cmd 3): cmd $03 prelude clears vertLayer2Setting; bodies run', () => {
    // Sprite $EA b0=$00 → post-remap (l1cmd=0, l2cmd=3, bits=0).
    // CODE_05BF0A clears VertLayer2Setting before falling into CODE_05BF20.
    // L2 setup's 16-bit STA writes l1timer=$00 (DATA_05CA5C[1]=$00).
    const r = applyCmdSetup({
      ...base,
      layer1ScrollCmd: 0x00, layer2ScrollCmd: 0x03,
      vertLayer2Setting: 1,                      // pre-setup non-zero
    }, rom!)
    expect(r.vertLayer2Setting).toBe(0)          // cleared by prelude
    expect(r.layer2ScrollType).toBe(0x01)
    expect(r.layer1ScrollTimer).toBe(0x00)       // ← side effect from L2 setup's 16-bit STA
    expect(r.layer2ScrollTimer).toBe(0xFF)
  })

  it('unported pair (cmd 5, cmd 5): pass-through', () => {
    const s: ScrollState = { ...base, layer1ScrollCmd: 0x05, layer2ScrollCmd: 0x05 }
    const r = applyCmdSetup(s, rom!)
    expect(r.layer1ScrollType).toBe(0xFF)        // unchanged
    expect(r.layer1ScrollXSpeed).toBe(0x1234)    // unchanged
  })
})

// ── cmd $00/$01 body details ────────────────────────────────────────────

describe.skipIf(!vanillaRomPresent)('applyCmdSetup — cmd $00/$01 body table lookups', () => {
  it('bits=0 → type=DATA_05CA61(0), timer=DATA_05CA68(0)', () => {
    const r = applyCmdSetup({
      ...base,
      layer1ScrollCmd: 0x01, layer2ScrollCmd: 0x01,
      layer1ScrollBits: 0, layer2ScrollBits: 0,
    }, rom!)
    expect(r.layer1ScrollType).toBe(DATA_05CA61(0))      // 0x01
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68(0))     // 0x16
  })

  it('bits=1 → type=DATA_05CA61(1), timer=DATA_05CA68(1)', () => {
    const r = applyCmdSetup({
      ...base,
      layer1ScrollCmd: 0x01, layer2ScrollCmd: 0x01,
      layer1ScrollBits: 1, layer2ScrollBits: 1,
    }, rom!)
    expect(r.layer1ScrollType).toBe(DATA_05CA61(1))      // 0x18
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68(1))     // 0x05
  })

  it('bits=6 → type=DATA_05CA61(6)=0x47, timer=DATA_05CA68(6)=0x09 (extended-table entry)', () => {
    // bits=6 reads beyond the 6-byte labeled DATA_05CA68 region into
    // DATA_05CA6E[0]=$09. Test the extension explicitly.
    const r = applyCmdSetup({
      ...base,
      layer1ScrollCmd: 0x01, layer2ScrollCmd: 0x01,
      layer1ScrollBits: 6, layer2ScrollBits: 6,
    }, rom!)
    expect(r.layer1ScrollType).toBe(0x47)
    expect(r.layer1ScrollTimer).toBe(0x09)
    expect(r.layer2ScrollType).toBe(0x47)
    expect(r.layer2ScrollTimer).toBe(0x09)
  })

  it('L2 bits independent of L1 bits', () => {
    const r = applyCmdSetup({
      ...base,
      layer1ScrollCmd: 0x01, layer2ScrollCmd: 0x01,
      layer1ScrollBits: 0, layer2ScrollBits: 1,
    }, rom!)
    expect(r.layer1ScrollType).toBe(DATA_05CA61(0))
    expect(r.layer2ScrollType).toBe(DATA_05CA61(1))
    expect(r.layer1ScrollTimer).toBe(DATA_05CA68(0))
    expect(r.layer2ScrollTimer).toBe(DATA_05CA68(1))
  })

  it('out-of-range bits read whatever bytes follow DATA_05CA61/68 in ROM', () => {
    // Pre-refactor this asserted `?? 0` fallback semantics from JS
    // arrays. Now that we read from ROM, OOB reads return the next
    // bytes after the labeled tables — undefined territory but
    // deterministic. The assertion is kept loose: the read must not
    // throw and the returned values must equal what ROM has at
    // (ADDR + bits).
    const r = applyCmdSetup({
      ...base,
      layer1ScrollCmd: 0x01, layer2ScrollCmd: 0x01,
      layer1ScrollBits: 99, layer2ScrollBits: 99,
    }, rom!)
    expect(r.layer1ScrollType).toBe(rom!.readByte(0x05CA61 + 99))
    expect(r.layer1ScrollTimer).toBe(rom!.readByte(0x05CA68 + 99))
    expect(r.layer2ScrollType).toBe(rom!.readByte(0x05CA61 + 99))
    expect(r.layer2ScrollTimer).toBe(rom!.readByte(0x05CA68 + 99))
  })

  it('zeros all four scroll speeds and posUpd accumulators', () => {
    const r = applyCmdSetup({ ...base, layer1ScrollCmd: 0x01, layer2ScrollCmd: 0x01 }, rom!)
    expect(r.layer1ScrollXSpeed).toBe(0)
    expect(r.layer1ScrollYSpeed).toBe(0)
    expect(r.layer2ScrollXSpeed).toBe(0)
    expect(r.layer2ScrollYSpeed).toBe(0)
    expect(r.layer1ScrollXPosUpd).toBe(0)
    expect(r.layer1ScrollYPosUpd).toBe(0)
    expect(r.layer2ScrollXPosUpd).toBe(0)
    expect(r.layer2ScrollYPosUpd).toBe(0)
  })

  it('does not mutate fields unrelated to setup', () => {
    const s: ScrollState = {
      ...base,
      layer1ScrollCmd: 0x01, layer2ScrollCmd: 0x01,
      layer1XPos: 0x1234, nextLayer1XPos: 0xABCD,
    }
    const r = applyCmdSetup(s, rom!)
    expect(r.layer1XPos).toBe(0x1234)
    expect(r.nextLayer1XPos).toBe(0xABCD)
    expect(r.layer1ScrollCmd).toBe(s.layer1ScrollCmd)
  })
})
