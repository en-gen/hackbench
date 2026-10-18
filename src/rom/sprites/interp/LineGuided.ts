/**
 * Whether a cart's line-guided grinder ($67) still dispatches in the vanilla order: draw, then the
 * line step. A hack that rewrites the handler gets the runner's generic rule. The gate reads the
 * dispatch shape and the addresses of the routines it calls, not those routines' bodies.
 */
import type { RomFile } from '../../RomFile'
import { mirror } from '../../addressing'
import { spanFingerprint } from '../../SubmapFlagGate'
import { nativeReset, Refusal, runUntil } from '../../cpu/call'
import { smwMachine } from './Machine'

/**
 * The handler's entry (LineGrinder, SMWDisX bank_01.asm:11837-11846) is run, not matched: from the handler, with
 * the cells zero and then all set, it must reach a JMP within `ENTRY_STEPS` instructions and both runs must land on
 * the same address. That address is the dispatch block the digest below then checks.
 */
const ENTRY_STEPS = 24
const JMP_ABS = 0x4c

/** Where a run from `handler` with WRAM filled with `fill` ends on its first JMP, or null (refused, spent, or off ROM). */
function entryJumpsTo(rom: RomFile, handler: number, fill: number): number | null {
  let m: ReturnType<typeof smwMachine>
  try {
    m = smwMachine(rom)
  } catch (e) {
    if (e instanceof Refusal) return null
    throw e
  }
  const { bus, cpu } = m
  bus.wram.fill(fill, 0, 0x2000)
  const guard = bus.onInstruction
  let last = 0
  bus.onInstruction = (addr, op) => {
    guard?.(addr, op)
    last = op
  }
  nativeReset(cpu)
  cpu.x = 3
  cpu.pb = handler >>> 16
  cpu.pc = handler & 0xffff
  const r = runUntil(cpu, ENTRY_STEPS, () => last === JMP_ABS)
  return r.kind === 'returned' ? (cpu.pb << 16) | cpu.pc : null
}

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
}

/**
 * Vanilla's. Targets: CODE_01DBD4 (bank_01.asm:12190, the $68 arm), CODE_01DC0B (12196, the $67 draw),
 * MarioSprInteractRt (12198 and 12202; label at 5385, $01A7E4), CODE_03C263 (12203), CODE_01D74D (12204,
 * the line step). Digest and targets matched on 25 of 152 ROMs probed (vanilla US, .magic, Seven_Vanilla_Levels
 * and 22 SMW Central hacks; the runner refuses the other 127 before this gate), one machine, 2026-10-10.
 */
export const VANILLA_DISPATCH: DispatchShape = {
  sha: '5ab0b410faae1acff4783cfef08df9beeca77bf750f71d8bdb8dbb1f434f7961',
  targets: [0x01dbd4, 0x01dc0b, 0x01a7e4, 0x01a7e4, 0x03c263, 0x01d74d],
}

/** `handler`: the 24-bit address from the ROM's own MAIN pointer table for $67; `shape`: the dispatch to accept. */
export function grinderDrawsBeforeSnap(
  rom: RomFile,
  handler: number,
  shape = VANILLA_DISPATCH,
): boolean {
  // A handler that gates on the lock and frame (cells set) and one that plays the sound (cells zero) must reach one block.
  const quiet = entryJumpsTo(rom, handler, 0)
  if (quiet === null || quiet !== entryJumpsTo(rom, handler, 0xff)) return false
  const at = quiet
  const span = rom.readAt(at, DISPATCH_LEN)
  if (span?.length !== DISPATCH_LEN || spanFingerprint(span, DISPATCH_OPERANDS) !== shape.sha)
    return false
  return CALLS.every(([o, w], k) => {
    const bank = w === 3 ? span[o + 3]! << 16 : at & 0xff0000
    return mirror(bank | span[o + 1]! | (span[o + 2]! << 8)) === shape.targets[k]
  })
}
