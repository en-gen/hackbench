/**
 * Whether a cart's line-guided grinder ($67) still dispatches in the vanilla order: draw, then the
 * line step. A hack that rewrites the handler gets the runner's generic rule. The gate reads the
 * dispatch shape and the addresses of the routines it calls, not those routines' bodies.
 */
import type { RomFile } from '../../RomFile'
import { mirror } from '../../addressing'
import { spanFingerprint } from '../../SubmapFlagGate'

/**
 * LineGrinder to its JMP (SMWDisX bank_01.asm:11837-11846): 17 bytes, recognized by `DispatchShape.entry`
 * (SHA-256 with the three free operands zeroed). The JMP target follows at +17.
 */
export const ENTRY_LEN = 17
const ENTRY_OPERANDS = [12, 14, 15]

/** Offsets of the entry's pinned bytes (the rest are operands that name a constant or a register). */
export const ENTRY_PINNED = Array.from({ length: ENTRY_LEN }, (_, i) => i).filter(
  i => !ENTRY_OPERANDS.includes(i),
)

/**
 * CODE_01D9A7's dispatch, 41 bytes (bank_01.asm:12182-12204), is over the literal limit
 * (docs/rom/level-table-gate.md), so its opcodes, immediates and branch displacements are pinned as
 * the SHA-256 of the span with the call and jump target operands zeroed, and each target is compared
 * on its own as a FastROM-folded 24-bit address. So the draw JSR (23) stays ahead of the JMP to the
 * line step (38), and every call names the shape's routine.
 */
export const DISPATCH_LEN = 41
/** Offset of each JSR / JSL / JMP opcode in the span, and its operand width. */
const CALLS: readonly (readonly [number, 2 | 3])[] = [[14, 2], [23, 2], [26, 2], [31, 2], [34, 3], [38, 2]] // prettier-ignore
export const DISPATCH_OPERANDS = CALLS.flatMap(([at, w]) => [at + 1, at + 2, ...(w === 3 ? [at + 3] : [])]) // prettier-ignore
export const DISPATCH_PINNED = Array.from({ length: DISPATCH_LEN }, (_, i) => i).filter(
  i => !DISPATCH_OPERANDS.includes(i),
)

/** `entry`: the digest of the handler's first 17 bytes; `sha`: the masked-span digest; `targets`: each call's folded 24-bit target, in span order. */
export interface DispatchShape {
  entry: string
  sha: string
  targets: readonly number[]
}

/**
 * Vanilla's. Targets: CODE_01DBD4 (bank_01.asm:12190, the $68 arm), CODE_01DC0B (12196, the $67 draw),
 * MarioSprInteractRt (12198 and 12202; label at 5385, $01A7E4), CODE_03C263 (12203), CODE_01D74D (12204,
 * the line step). Digest and targets matched on 25 of 152 ROMs probed (vanilla US, .magic, Seven_Vanilla_Levels
 * and 22 SMW Central hacks; the runner refuses the other 127 before this gate), one machine, 2026-10-10.
 */
export const VANILLA_DISPATCH: DispatchShape = {
  entry: '12e5d92f198bc3c96032950e43e56d72bee31a09cde8dca4d23fe1e8defeaf96',
  sha: '5ab0b410faae1acff4783cfef08df9beeca77bf750f71d8bdb8dbb1f434f7961',
  targets: [0x01dbd4, 0x01dc0b, 0x01a7e4, 0x01a7e4, 0x03c263, 0x01d74d],
}

/** `handler`: the 24-bit address from the ROM's own MAIN pointer table for $67; `shape`: the dispatch to accept. */
export function grinderDrawsBeforeSnap(
  rom: RomFile,
  handler: number,
  shape = VANILLA_DISPATCH,
): boolean {
  const entry = rom.readAt(handler, ENTRY_LEN + 2)
  if (!entry || spanFingerprint(entry.subarray(0, ENTRY_LEN), ENTRY_OPERANDS) !== shape.entry)
    return false
  const at = (handler & 0xff0000) | entry[ENTRY_LEN]! | (entry[ENTRY_LEN + 1]! << 8)
  const span = rom.readAt(at, DISPATCH_LEN)
  if (span?.length !== DISPATCH_LEN || spanFingerprint(span, DISPATCH_OPERANDS) !== shape.sha)
    return false
  return CALLS.every(([o, w], k) => {
    const bank = w === 3 ? span[o + 3]! << 16 : at & 0xff0000
    return mirror(bank | span[o + 1]! | (span[o + 2]! << 8)) === shape.targets[k]
  })
}
