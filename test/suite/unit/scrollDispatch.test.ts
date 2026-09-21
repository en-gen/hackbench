/**
 * Tests for `simulateScrollSetup` - the bank_05 L1 setup dispatch port.
 *
 * Validates against live-game captures from Mesen for vanilla SMW levels:
 *   - $009 (cmd $01 Auto-Scroll): captured Layer2ScrollCmd=$01, Layer2ScrollBits=$00.
 *   - $0DC (cmd $0B On/Off):     captured Layer2ScrollCmd=$0B.
 *
 * ROM-dependent (reads real DATA tables from bank_05). Skipped when the
 * vanilla ROM isn't present.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { simulateScrollSetup } from '../../../src/rom/scrollDispatch'
import { SmwRom } from '../../../src/rom/SmwRom'

const ROM_PATH = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

describe.skipIf(!romPresent)('simulateScrollSetup (ROM-only)', () => {
  it('returns null for non-scroll sprite ids', () => {
    const rom = SmwRom.open(ROM_PATH)
    expect(simulateScrollSetup(rom.rom, 0x10, 0x00)).toBeNull()
    expect(simulateScrollSetup(rom.rom, 0xe6, 0x00)).toBeNull()
  })

  it('$009 sprite ($E8, b0=$00) -> Layer2ScrollCmd=$01 Layer2ScrollBits=$00', () => {
    // Cmd $01 dispatches to CODE_05BD36 (bank_05.asm:4623), which reads
    // DATA_05C9D1[Layer1ScrollBits*2..+1] (16-bit) and 16-bit-STAs to
    // Layer1ScrollCmd. b0=$00 → Layer1ScrollBits=0 → reads $0101 → splits
    // to Layer1ScrollCmd=$01, Layer2ScrollCmd=$01.
    //
    // Verified against live capture: OneDrive/maps/009/l2_scroll.csv
    // shows l2cmd=$01 and l2bits=$00 across all 7787 frames.
    const rom = SmwRom.open(ROM_PATH)
    const state = simulateScrollSetup(rom.rom, 0xe8, 0x00)
    expect(state).not.toBeNull()
    expect(state!.layer2ScrollCmd).toBe(0x01)
    expect(state!.layer2ScrollBits).toBe(0x00)
    // L1 side falls out of the same 16-bit STA: low byte of $0101 is $01.
    expect(state!.layer1ScrollCmd).toBe(0x01)
    // DATA_05C9DB[0..1] = $0001 -> low byte $01 to Layer1ScrollBits.
    expect(state!.layer1ScrollBits).toBe(0x01)
  })

  it('$0DC sprite ($F2, any b0) -> Layer2ScrollCmd=$0B', () => {
    // Cmd $0B dispatches to CODE_05BFF6 (bank_05.asm:4953):
    //   REP #$20 / LDA #$0B00 / BRA CODE_05BFD2 / ... / STA Layer1ScrollCmd
    // → Layer1ScrollCmd=$00, Layer2ScrollCmd=$0B.
    //
    // Verified against live capture: OneDrive/maps/0dc/l2_scroll.csv shows
    // l2cmd=$0B across all 1264 frames.
    const rom = SmwRom.open(ROM_PATH)
    const state = simulateScrollSetup(rom.rom, 0xf2, 0x00)
    expect(state).not.toBeNull()
    expect(state!.layer2ScrollCmd).toBe(0x0b)
    expect(state!.layer1ScrollCmd).toBe(0x00)
  })

  it('cmd $0E (sprite $F5) -> Layer2ScrollCmd=$0E (sink/rise)', () => {
    // CODE_05C036 (bank_05.asm:4990) loads #$0E00 → L2Cmd=$0E.
    const rom = SmwRom.open(ROM_PATH)
    const state = simulateScrollSetup(rom.rom, 0xf5, 0x00)
    expect(state!.layer2ScrollCmd).toBe(0x0e)
  })

  it('cmd $0C (sprite $F3) -> Layer2ScrollCmd=$00 (auto-scroll level)', () => {
    // CODE_05C005 loads #$000C → L1Cmd=$0C, L2Cmd=$00 (no L2 motion despite
    // having a scroll sprite).
    const rom = SmwRom.open(ROM_PATH)
    const state = simulateScrollSetup(rom.rom, 0xf3, 0x00)
    expect(state!.layer1ScrollCmd).toBe(0x0c)
    expect(state!.layer2ScrollCmd).toBe(0x00)
  })

  it('cmd $0D (sprite $F4) -> Layer2ScrollCmd=$0D (fast BG scroll)', () => {
    // CODE_05C01A loads #$0D00 → L2Cmd=$0D.
    const rom = SmwRom.open(ROM_PATH)
    const state = simulateScrollSetup(rom.rom, 0xf4, 0x00)
    expect(state!.layer2ScrollCmd).toBe(0x0d)
  })

  it('cmd $07 (sprite $EE) -> no-op (Return05BD35)', () => {
    // Cmd $07 is unused in vanilla - Return05BD35 doesn't change cmd bytes.
    // Pre-state: L1Cmd=$07, L2Cmd=$00. Post-state: same.
    const rom = SmwRom.open(ROM_PATH)
    const state = simulateScrollSetup(rom.rom, 0xee, 0x00)
    expect(state!.layer1ScrollCmd).toBe(0x07)
    expect(state!.layer2ScrollCmd).toBe(0x00)
  })

  it('cmd $0B output is independent of b0 (immediate write)', () => {
    // CODE_05BFF6 doesn't read Layer1ScrollBits - it's an unconditional
    // LDA #$0B00 / STA. Verify by trying a few b0 values.
    const rom = SmwRom.open(ROM_PATH)
    for (const b0 of [0x00, 0x10, 0x40, 0x80]) {
      const state = simulateScrollSetup(rom.rom, 0xf2, b0)
      expect(state!.layer2ScrollCmd).toBe(0x0b)
    }
  })
})
