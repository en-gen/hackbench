/**
 * Whether a cart's line-guided sprite ($62, $65-$68) still dispatches in the vanilla order: draw, then the
 * line step. A hack that rewrites the handler gets the runner's generic rule. The gate reads the
 * dispatch shape and the addresses of the routines it calls, not those routines' bodies.
 * All six MAINs end in the one dispatch CODE_01D9A7 (bank_01.asm:12182-12204), reached three ways (#792).
 */
import type { RomFile } from '../../RomFile'
import { mirror } from '../../addressing'
import { spanFingerprint } from '../../SubmapFlagGate'

/** LineGrinder to its JMP (SMWDisX bank_01.asm:11837-11846), under the ~32-byte literal limit; null = free operand. */
const ENTRY: readonly (number | null)[] = [0xa5, 0x13, 0x29, 0x07, 0x1d, 0x26, 0x16, 0x05, 0x9d, 0xd0, 0x05, 0xa9, null, 0x8d, null, null, 0x4c] // prettier-ignore

/**
 * How each id's MAIN reaches the dispatch: `grinder` is LineGrinder itself ($67); `chainsaw` is
 * LineRope_Chainsaw (bank_01.asm:11817-11830), a 33-byte prelude that falls into LineGrinder ($65, $66);
 * `jmp` is LineFuzzy_Plats, a bare JMP to the dispatch (bank_01.asm:11845-11846; $62, $68).
 */
const ROUTES: Readonly<Record<number, 'grinder' | 'chainsaw' | 'jmp'>> = { 0x62: 'jmp', 0x65: 'chainsaw', 0x66: 'chainsaw', 0x67: 'grinder', 0x68: 'jmp' } // prettier-ignore
/** The prelude's length and its free operands: the DATA_01D717 table address and the JSR target. */
export const PRELUDE_LEN = 33
const PRELUDE_OPERANDS = [22, 23, 31, 32]

/** Offsets of ENTRY's pinned bytes (the rest are operands that name a constant or a register). */
export const ENTRY_PINNED = ENTRY.flatMap((v, i) => (v === null ? [] : [i]))

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

/** `sha`: the masked-span digest; `targets`: each call's folded 24-bit target, in span order. */
export interface DispatchShape {
  sha: string
  targets: readonly number[]
  /** Digests (operands masked as below) of the chainsaw prelude and of the platform arm. */
  prelude: string
  plat: string
}

/**
 * The platform arm, CODE_01DAA2 (shift, JSR CODE_01B2DF draw, restore, JSR to the line step: bank_01.asm:12323-12354):
 * its length and the offsets of the draw and step JSR operands. $64 stays out: InitLineRope runs the line step twice
 * in INIT (bank_01.asm:11766-11786), so its first MAIN draw is already on the track and the generic rule is right.
 */
export const PLAT_ARM = { len: 68, draw: 46, step: 66 } as const

/**
 * Vanilla's. Targets: CODE_01DBD4 (bank_01.asm:12190, the $68 arm), CODE_01DC0B (12196, the $67 draw),
 * MarioSprInteractRt (12198 and 12202; label at 5385, $01A7E4), CODE_03C263 (12203), CODE_01D74D (12204,
 * the line step). Digest and targets matched on 25 of 152 ROMs probed (vanilla US, .magic, Seven_Vanilla_Levels
 * and 22 SMW Central hacks; the runner refuses the other 127 before this gate), one machine, 2026-10-10.
 */
export const VANILLA_DISPATCH: DispatchShape = {
  sha: '5ab0b410faae1acff4783cfef08df9beeca77bf750f71d8bdb8dbb1f434f7961',
  targets: [0x01dbd4, 0x01dc0b, 0x01a7e4, 0x01a7e4, 0x03c263, 0x01d74d],
  prelude: '9c92bcff29e279e68e2fd3a3bd96019ab63515c8169a6c590f624d6ca6503af9',
  plat: 'd8df7298dd161113eb32459a1400fca35a6e6a8385677c22f7f93887f6c57c7c',
}

/** `handler`: the 24-bit address from the ROM's own MAIN pointer table for `id`; `shape`: the dispatch to accept. */
export function lineDrawsBeforeSnap(
  rom: RomFile,
  id: number,
  handler: number,
  shape = VANILLA_DISPATCH,
): boolean {
  const route = ROUTES[id]
  if (!route) return false
  if (route === 'chainsaw') {
    const pre = rom.readAt(handler, PRELUDE_LEN)
    if (pre?.length !== PRELUDE_LEN || spanFingerprint(pre, PRELUDE_OPERANDS) !== shape.prelude)
      return false
  }
  const pattern = route === 'jmp' ? [0x4c] : ENTRY
  const head = route === 'chainsaw' ? PRELUDE_LEN : 0
  const entry = rom.readAt(handler + head, pattern.length + 2)
  if (!entry || pattern.some((v, i) => v !== null && entry[i] !== v)) return false
  const bank = handler & 0xff0000
  const at = bank | entry[pattern.length]! | (entry[pattern.length + 1]! << 8)
  const span = rom.readAt(at, DISPATCH_LEN)
  if (span?.length !== DISPATCH_LEN || spanFingerprint(span, DISPATCH_OPERANDS) !== shape.sha)
    return false
  const callsOk = CALLS.every(([o, w], k) => {
    const b = w === 3 ? span[o + 3]! << 16 : at & 0xff0000
    return mirror(b | span[o + 1]! | (span[o + 2]! << 8)) === shape.targets[k]
  })
  if (!callsOk || id !== 0x62) return callsOk
  // $62 takes the BCC at 8 (disp pinned by the digest) to a JMP to the platform arm.
  const jmp = rom.readAt(at + 10 + span[9]!, 3)
  if (jmp?.[0] !== 0x4c) return false
  const { len, draw, step } = PLAT_ARM
  const arm = bank | jmp[1]! | (jmp[2]! << 8)
  const body = rom.readAt(arm, len)
  if (body?.length !== len) return false
  const ops = [draw, draw + 1, step, step + 1]
  return (
    spanFingerprint(body, ops) === shape.plat &&
    mirror(bank | body[step]! | (body[step + 1]! << 8)) === shape.targets[5]
  )
}
