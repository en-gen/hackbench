/**
 * scrollData.ts - SNES address constants for ROM data tables consumed by
 * the scroll simulator, plus thin byte/word readers.
 *
 * Hackbench is a ROM editor: every value the simulator uses must come
 * from the open ROM. Hardcoded JS constants would silently mask any
 * hack that modifies these tables (or, worse, prevent us from offering
 * an "edit auto-scroll behavior" feature). All scroll handlers take a
 * `RomFile` and read tables via `readByte` / `readWord` against the
 * SNES addresses below.
 *
 * The labels match those in `C:\Projects\SMWDisX\bank_05.asm`. When the
 * disassembly labels only N bytes but the ASM reads past the label
 * (e.g. `LDA.W DATA_05CA68,Y` with Y=6 spilling into `DATA_05CA6E`),
 * ROM reads naturally produce the right value because the bytes are
 * consecutive in ROM - no extension table needed.
 */

import type { RomFile } from './RomFile'

// ── Generic readers ─────────────────────────────────────────────────────

/** Read one byte from ROM at `(snesAddr + index)`. Returns 0 for OOB. */
export function readByte(rom: RomFile, snesAddr: number, index: number = 0): number {
  return rom.readByte(snesAddr + index) ?? 0
}

/** Read a 16-bit little-endian word from ROM at `(snesAddr + index)`. */
export function readWord(rom: RomFile, snesAddr: number, index: number = 0): number {
  return rom.readWord(snesAddr + index) ?? 0
}

// ── Parallax / scroll-cmd table addresses (bank_05) ─────────────────────

/** X-target table. The byte at `DATA_05CA6E` is the "previous" sentinel
 *  ($09); subsequent bytes are the actual targets at `DATA_05CA6F`.
 *  Read as a single combined table indexed by `Layer{N}ScrollType`. */
export const ADDR_X_TARGETS = 0x05ca6e

/** Y-target table. Sentinel byte at `DATA_05CABE` ($50) followed by
 *  `DATA_05CABF` (80 Y targets). */
export const ADDR_Y_TARGETS = 0x05cabe

/** 80-byte divisor table indexed by `Layer{N}ScrollType` (CODE_05C04D). */
export const ADDR_DATA_05CB0F = 0x05cb0f

/** 28-byte (14 × 16-bit) speed-delta bias table for parallax tick. */
export const ADDR_DATA_05CB5F = 0x05cb5f

/** Initial ScrollType for cmd $00/$01 setup, indexed by Scroll{1,2}Bits. */
export const ADDR_DATA_05CA61 = 0x05ca61

/** Initial ScrollTimer for cmd $00/$01 setup, indexed by Scroll{1,2}Bits.
 *  Reads with Y=6 spill into `DATA_05CA6E` ($09) - ROM reads handle
 *  this automatically. */
export const ADDR_DATA_05CA68 = 0x05ca68

/** Initial ScrollType for cmd $08 setup. */
export const ADDR_DATA_05CA46 = 0x05ca46

/** Initial ScrollType for cmd $03 setup. */
export const ADDR_DATA_05CA5C = 0x05ca5c

/** Combined cmd $08 setup-step + per-frame-step table.
 *  Word read at offset Y=bits*2 returns the step. */
export const ADDR_DATA_05CBED = 0x05cbed

/** Per-frame step for cmd $08 (= DATA_05CBED + 1). */
export const ADDR_DATA_05CBEE = 0x05cbee

/** Speed-bias target for cmd $08/$03, indexed by Layer{N}ScrollType. */
export const ADDR_DATA_05CBF1 = 0x05cbf1

/** Speed-bias delta words for cmd $08/$03 (Y=0 → +1, Y=2 → -1). */
export const ADDR_DATA_05CBC3 = 0x05cbc3

/** Combined cmd $03 setup-step + per-frame-step table. */
export const ADDR_DATA_05CBF5 = 0x05cbf5

/** Per-frame step for cmd $03 (= DATA_05CBF5 + 1). */
export const ADDR_DATA_05CBF6 = 0x05cbf6

// ── Cmd $0C (auto-scroll level) ─────────────────────────────────────────

/** Cmd $0C speed cap, indexed by `Layer1ScrollBits * 2` as a word. */
export const ADDR_DATA_05C001 = 0x05c001

// ── Cmd $0E (Layer 2 sink/rise) setup + per-frame ───────────────────────

/** Cmd $0E setup: initial Layer1ScrollTimer, indexed by Layer1ScrollBits. */
export const ADDR_DATA_05C808 = 0x05c808

/** Cmd $0E setup: initial Layer2ScrollTimer, indexed by Layer1ScrollBits. */
export const ADDR_DATA_05C80B = 0x05c80b

/** Cmd $0E zone X-min table (6 × 16-bit). */
export const ADDR_DATA_05C7F0 = 0x05c7f0

/** Cmd $0E zone X-max table (6 × 16-bit). */
export const ADDR_DATA_05C7FC = 0x05c7fc

/** Cmd $0E sink/anchor Y target. Word reads at offset 0/2 spill into
 *  the start of `DATA_05C810` - ROM reads handle this naturally. */
export const ADDR_DATA_05C80E = 0x05c80e

/** Cmd $0E speed-update target Y, indexed by Y. */
export const ADDR_DATA_05C810 = 0x05c810

/** Cmd $0E speed cap, indexed by Y. */
export const ADDR_DATA_05C814 = 0x05c814

/** Cmd $0E per-frame speed step (NTSC), indexed by Y. */
export const ADDR_DATA_05C818 = 0x05c818

// ── Cmd $0B (L2 On/Off Switch Y) ────────────────────────────────────────

/** Y target positions indexed by On/Off switch state (X=0 or 2). */
export const ADDR_DATA_05C71B = 0x05c71b

/** Speed cap (signed magnitude) indexed by switch state. */
export const ADDR_DATA_05C71F = 0x05c71f

/** Per-frame speed step indexed by switch state. */
export const ADDR_DATA_05C723 = 0x05c723

// ── Cmd $02 (Layer 2 Smash) ─────────────────────────────────────────────

/** Smash-zone X minimum bounds. 36 bytes = 18 × 16-bit zone-min words. */
export const ADDR_DATA_05C880 = 0x05c880

/** Smash-zone X maximum bounds. 36 bytes = 18 × 16-bit zone-max words. */
export const ADDR_DATA_05C8A4 = 0x05c8a4

/** Smash Y-target table. Word read indexed by `(l1type + l2type)`. */
export const ADDR_DATA_05C8C8 = 0x05c8c8

/** Smash Y-EOR mask. Word read indexed by `(l1type + l2type)`. */
export const ADDR_DATA_05C8FE = 0x05c8fe

/** Smash timer-reset table (NTSC). Byte read indexed by
 *  `(l1type + l2type) >> 1`. PAL has different values at the address
 *  in PAL ROMs, so this points at whatever the open ROM has there. */
export const ADDR_DATA_05C934 = 0x05c934
