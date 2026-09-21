/**
 * cameraMarioX.ts - port of `UpdateScreenPosition` horizontal camera X
 * tracking (bank_00.asm:13658-13691 + CODE_00F8AB:13873-13895).
 *
 * Runs once per frame BEFORE `applyParallaxDerivation` so the camera-
 * adjusted `Layer1XPos` flows into the parallax copy (`Layer1XPos →
 * NextLayer1XPos`). Modifies only `layer1XPos`.
 *
 * Algorithm (horizontal levels, ScreenMode bit 0 clear):
 *   CameraLeftBuffer  = CameraMoveTrigger − $000C
 *   CameraRightBuffer = CameraMoveTrigger + $000C
 *   relX = PlayerXPosNext − Layer1XPos  (signed 16-bit)
 *
 *   Direction: relX ≥ CameraMoveTrigger → right (Y=2), else left (Y=0)
 *   buffer = right ? CameraRightBuffer : CameraLeftBuffer
 *   dist   = relX − buffer
 *
 *   Gate via DATA_00F6A3[Y]: right → EOR $FFFF (skip if positive dist),
 *                             left  → EOR $0000 (skip if positive dist)
 *   Effectively: skip when Mario is still inside the dead zone.
 *
 *   CODE_00F8AB adjusts dist by +1 (right) or −1 (left) in normal play
 *   when CameraIsScrolling = 0 (no L/R button press active).
 *   DATA_00F6BF / DATA_00F6CF tables, indexed by yIdx = 8 (normal
 *   CameraMoveTrigger range) or 10 (extreme trigger, won't apply while
 *   trigger stays at $0080).
 *
 *   Layer1XPos += dist, clamped to [0, (LastScreenHoriz − 1) × 256].
 *
 * L/R button scrolling (CODE_00CDDD / CODE_00CE4C, which modify
 * CameraMoveTrigger and set CameraIsScrolling) is NOT modelled. The
 * editor assumes CameraMoveTrigger stays at its level-entry value ($0080
 * for all tested levels) throughout playback. CameraIsScrolling is
 * therefore always 0 and CODE_00F8AB always applies the ±1 adjustment.
 */

import type { ScrollState } from '../scrollSim'
import { wrap16 } from '../scrollSim'

// ── ROM data tables (constants, no ROM read needed) ──────────────────────────

// DATA_00F6A3 - EOR gate mask: Y=0 (left)→$0000, Y=2 (right)→$FFFF
// bank_00.asm:13607-13608
const F6A3: Readonly<Record<0 | 2, number>> = { 0: 0x0000, 2: 0xffff }

// DATA_00F6B3 - CameraMoveTrigger threshold for yIdx selection inside
// CODE_00F8AB: X=0 (left)→$0090, X=2 (right)→$0060.
// bank_00.asm:13616-13617
const F6B3: Readonly<Record<0 | 2, number>> = { 0: 0x0090, 2: 0x0060 }

// DATA_00F6BF - sign-check values (16-bit LE, byte offsets):
//   offset 0 → $0000, offset 2 → $FFFE, offset 8 → $FFFE, offset 10 → $0002
// bank_00.asm:13620-13621
const F6BF: Readonly<Record<number, number>> = { 0: 0x0000, 2: 0xfffe, 8: 0xfffe, 10: 0x0002 }

// DATA_00F6CF - delta adjustment (16-bit LE, byte offsets):
//   offset 8 → +1, offset 10 → −1 ($FFFF)
// bank_00.asm:13627-13628
const F6CF: Readonly<Record<number, number>> = {
  0: 0x00d0,
  2: 0x0000,
  4: 0x0020,
  6: 0x00d0,
  8: 0x0001,
  10: 0xffff,
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Apply one frame of horizontal camera X tracking.
 * Vertical levels (ScreenMode bit 0 set) are a no-op - they use a
 * different tracking path (CODE_00F75C) not yet ported.
 */
export function applyCameraHorizX(s: ScrollState): ScrollState {
  if (s.screenMode & 0x01) return s // vertical level - skip
  if (!s.horizLayer1Setting) return s // HorizLayer1Setting == 0 - skip

  const cmt = s.cameraMoveTrigger // CameraMoveTrigger, init $0080

  // Compute dead-zone buffers. bank_00.asm:13636-13642
  const bufLeft = wrap16(cmt - 0x000c) // CameraLeftBuffer
  const bufRight = wrap16(cmt + 0x000c) // CameraRightBuffer

  // relX = PlayerXPosNext − Layer1XPos (signed 16-bit). 13661-13664
  const relX = wrap16(s.playerXPosNext - s.layer1XPos)

  // Direction: relX ≥ CameraMoveTrigger → right (Y=2), else left (Y=0).
  // Both values are < $8000 so unsigned ≥ equals signed ≥. 13665-13668
  const xIdx: 0 | 2 = relX >= cmt ? 2 : 0
  const buffer = xIdx === 2 ? bufRight : bufLeft

  // dist = relX − buffer. 13670-13673
  const dist0 = wrap16(relX - buffer)
  if (dist0 === 0) return s // BEQ CODE_00F75A

  // EOR gate: skip when Mario is inside the dead zone. 13674-13675
  // right: $FFFF XOR positive-dist → negative (bit15=1) → continue
  //  left: $0000 XOR negative-dist → negative (bit15=1) → continue
  if (wrap16(dist0 ^ F6A3[xIdx]) < 0x8000) return s // BPL CODE_00F75A

  // CODE_00F8AB: dist ± 1 adjustment for normal gameplay (CameraIsScrolling=0).
  // bank_00.asm:13873-13895
  let dist = dist0
  {
    // yIdx: 8 if CameraMoveTrigger ≥ F6B3 threshold, else 10.
    const yIdx = cmt >= F6B3[xIdx] ? 8 : 10

    const chy = wrap16(F6BF[yIdx] ^ dist0)
    const chx = wrap16(F6BF[xIdx] ^ dist0)
    if (chy >= 0x8000 && chx >= 0x8000) {
      // Both sign checks pass - apply delta.
      const adjusted = wrap16(dist0 + F6CF[yIdx])
      if (adjusted !== 0) dist = adjusted
      // CameraProperMove = yIdx (not tracked - no L/R button model)
    }
  }

  // Layer1XPos += dist, then clamp. 13677-13691
  let newX = wrap16(s.layer1XPos + dist)

  // Clamp low: negative wrap-around → 0
  if (newX >= 0x8000) newX = 0

  // Clamp high: (LastScreenHoriz − 1) << 8, with overflow guard
  let maxX = wrap16((s.lastScreenHoriz - 1) << 8)
  if (maxX >= 0x8000) maxX = 0x0080 // BPL guard: extreme screens

  if (newX > maxX) newX = maxX // clamp to level end

  return { ...s, layer1XPos: newX }
}
