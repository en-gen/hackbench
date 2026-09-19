/**
 * SpritePriorityLoader.ts -- OBJ (sprite) priority, read from the cart.
 *
 * Two live reads: the per-level default from `LevXYPPCCCTtbl`
 * (bank_05.asm:505-509, stored at :542-543) and the per-handler lowering,
 * read as opcodes off the handler the cart's own pointer table names.
 * Derivation, measurements and the honest-degradation rule:
 * `docs/obj-priority.md`.
 */

import type { RomFile } from './RomFile'

/** 32 bytes indexed by level mode. SMW_U.sym; bank_05.asm:505. */
export const LEV_XYPPCCCT_TBL_ADDR = 0x0584B7
/** `dw` table after `CallSpriteMain`'s `JSL ExecutePtr`. bank_01.asm:893-896. */
export const SPRITE_MAIN_PTR_ADDR = 0x0185CC
/** `SpriteProperties` direct page -- the `STA $64` we look for. rammap.asm:521. */
const SPRITE_PROPERTIES_DP = 0x64
/** `SpriteBehindScene`; `LDA.W $1632,X` is `BD 32 16`. SMW_U.sym. */
const SPRITE_BEHIND_SCENE = 0x1632

/** Used only when the cart cannot be read. bank_05.asm:506 entry 0. */
export const DEFAULT_OBJ_PRIORITY = 2

export type ObjPrioritySource =
  | 'level'        // LevXYPPCCCTtbl[levelMode]
  | 'handler'      // an immediate the sprite's own handler stores to $64
  | 'runtimeGated' // handler lowers it, but only under SpriteBehindScene

export interface SpriteObjPriority {
  /** 0..3, the PPU OBJ priority this sprite composites at. */
  value: number
  /**
   * `runtimeGated` means `value` is the level default and the real answer
   * is unknown for a still frame -- callers must not present it as the
   * game's. See docs/obj-priority.md section 3.
   */
  source: ObjPrioritySource
}

/** OBJ priority is bits 5:4 of an XYPPCCCT byte. rammap.asm:518-527. */
const priorityBits = (xyppccct: number): number => (xyppccct >> 4) & 0x03

/** Per-level default. Null when the table read fails, so callers can say so. */
export function readLevelObjPriority(rom: RomFile, levelMode: number): number | null {
  const b = rom.readByte(LEV_XYPPCCCT_TBL_ADDR + (levelMode & 0x1F))
  return b === null ? null : priorityBits(b)
}

/**
 * 65816 operand length per opcode, 8-bit A and index -- how sprite handlers
 * run. 'm'/'x' are the immediates that widen under REP; the walker tracks
 * SEP/REP to resolve them. Rows are opcode high nibbles $0. through $F..
 */
const OPERAND_LEN = (
  '111111110m002223' + '1111111102002223' + '213111110m002223' + '1111111102002223' +
  '011121110m002223' + '1111211102003223' + '012111110m002223' + '1111111102002223' +
  '112111110m002223' + '1111111102002223' + 'x1x111110m002223' + '1111111102002223' +
  'x11111110m002223' + '1111111102002223' + 'x11111110m002223' + '1111211102002223'
)

/** Ends straight-line flow: RTI RTS RTL, the JMP/JML forms, BRA, BRL. */
const STOPS = new Set([0x40, 0x60, 0x6B, 0x4C, 0x5C, 0x6C, 0x7C, 0xDC, 0x80, 0x82])

/** Vanilla's longest handler entry block is 156 instructions (measured, USA cart). */
const MAX_INSTRUCTIONS = 400

/**
 * Walk from `entry` to the first unconditional transfer looking for
 * `LDA #imm : STA $64`. Branches are not followed: what this reads is the
 * lowering applied on the way to the handler's first draw call.
 */
function findPriorityStore(
  rom: RomFile,
  entry: number,
): { imm: number; behindSceneGated: boolean } | null {
  let pc = entry
  let m8 = true
  let x8 = true
  let sinceBehindScene = 99
  for (let n = 0; n < MAX_INSTRUCTIONS; n++) {
    const op = rom.readByte(pc)
    if (op === null) return null
    const code = OPERAND_LEN[op]!
    const len = code === 'm' ? (m8 ? 1 : 2) : code === 'x' ? (x8 ? 1 : 2) : Number(code)
    if (op === 0xE2 || op === 0xC2) {
      const flags = rom.readByte(pc + 1) ?? 0
      const on = op === 0xE2
      if (flags & 0x20) m8 = on
      if (flags & 0x10) x8 = on
    }
    if (op === 0xBD && rom.readWord(pc + 1) === SPRITE_BEHIND_SCENE) sinceBehindScene = 0
    if (op === 0xA9 && rom.readByte(pc + 2) === 0x85 && rom.readByte(pc + 3) === SPRITE_PROPERTIES_DP) {
      return { imm: rom.readByte(pc + 1) ?? 0, behindSceneGated: sinceBehindScene <= 2 }
    }
    if (STOPS.has(op)) return null
    sinceBehindScene++
    pc += 1 + len
  }
  return null
}

/** Resolve one sprite's OBJ priority against the level's default. */
export function readSpriteObjPriority(
  rom: RomFile,
  spriteId: number,
  levelDefault: number,
): SpriteObjPriority {
  const handlerLow = rom.readWord(SPRITE_MAIN_PTR_ADDR + spriteId * 2)
  if (handlerLow === null) return { value: levelDefault, source: 'level' }
  const store = findPriorityStore(rom, 0x010000 | handlerLow)
  if (store === null) return { value: levelDefault, source: 'level' }
  if (store.behindSceneGated) return { value: levelDefault, source: 'runtimeGated' }
  return { value: priorityBits(store.imm), source: 'handler' }
}
