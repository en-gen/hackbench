/**
 * The synthetic cart's ids 31, 32 and 103 (the line-guided grinder): see the Ids list in syntheticSpriteRom.ts.
 * Split out to keep that file under the content gate's byte-token limit. Hand-written test opcodes; the
 * id 103 handler has the opcode SKELETON of the vanilla grinder's (operands that name a label are free), which
 * is what `lineDrawsBeforeSnap` reads. Ids 98, 104 (a bare JMP to the dispatch), 101, 102 (a 33-byte prelude, then the grinder entry)
 * and 100 (the prelude, but not admitted) reach the same dispatch, whose arms mirror vanilla's layout (#792).
 */
import {
  DISPATCH_OPERANDS,
  PLAT_ARM,
  PLAT_OPERANDS,
  PRELUDE_LEN,
  PRELUDE_OPERANDS,
  type DispatchShape,
} from '../../../src/rom/sprites/interp/LineGuided'
import { spanFingerprint } from '../../../src/rom/SubmapFlagGate'
import type { SyntheticOptions } from './syntheticSpriteRom'

/** Where id 103's handler sits, and the shape of its dispatch block (the gate's expected shape here, not vanilla's). */
export const GRINDER_HANDLER = 0x019200
export const GRINDER_DISPATCH_AT = 0x019220
/** Handlers: id 98 and 104 (JMP) and the chainsaw ids 100-102 (prelude); the platform arm the BCC's JMP reaches. */
export const JMP_HANDLER = 0x019600
export const CHAINSAW_HANDLER = 0x019610
const PLAT_ARM_AT = 0x019700
/** The dispatch of CODE_01D9A7's layout with synthetic targets: $68 and $67 draw at $019400, $65/$66 JSL $0194F0 to it. */
const dispatchBytes = (altered: boolean): number[] => [0xb5, 0x9e, 0xc9, altered ? 0x63 : 0x64, 0xf0, 0x26, 0xc9, 0x65, 0x90, 0x1f, 0xc9, 0x68, 0xd0, 0x05, 0x20, 0x00, 0x94, 0x80, 0x07, 0xc9, 0x67, 0xd0, 0x08, 0x20, 0x00, 0x94, 0x20, 0x80, 0x92, 0x80, 0x07, 0x20, 0x80, 0x92, 0x22, 0xf0, 0x94, 0x01, 0x4c, 0x90, 0x92] // prettier-ignore
/** The platform arm: draw JSR at 45, step JSR at 65, as in vanilla's (the digest below is this cart's own). */
const PLAT_ARM_BYTES = [...Array(45).fill(0xea), 0x20, 0x00, 0x94, ...Array(17).fill(0xea), 0x20, 0x90, 0x92, 0x60] // prettier-ignore
const PRELUDE_BYTES: number[] = Array(PRELUDE_LEN).fill(0xea)
export const GRINDER_DISPATCH: DispatchShape = {
  sha: spanFingerprint(Buffer.from(dispatchBytes(false)), DISPATCH_OPERANDS),
  targets: [0x019400, 0x019400, 0x019280, 0x019280, 0x0194f0, 0x019290],
  prelude: spanFingerprint(Buffer.from(PRELUDE_BYTES), PRELUDE_OPERANDS),
  plat: spanFingerprint(Buffer.from(PLAT_ARM_BYTES.slice(0, PLAT_ARM.len)), PLAT_OPERANDS),
}

/** `drawSub`: the shared one-piece draw routine, ending in RTS. */
export function putGrinderRoutines(
  put: (snes: number, bytes: number[]) => void,
  o: SyntheticOptions,
  drawSub: number[],
): void {
  // id 31: draw one 16x16 piece at the sprite's X, THEN move X by +4, as the grinder's MAIN draws before its line step.
  const move = [0xb5, 0xe4, 0x18, 0x69, 0x04, 0x95, 0xe4, 0x60]
  put(0x019300, [...drawSub.slice(0, -1), ...move])
  put(0x019290, move)
  // id 32: as 31 but draws only from its second MAIN ($1650,X counts MAINs), so its first draw is on pass 1.
  put(
    0x0192a0,
    [
      0xfe, 0x50, 0x16, 0xbd, 0x50, 0x16, 0xc9, 0x02, 0x90, 0x03, 0x20, 0x00, 0x94, 0x4c, 0x90,
      0x92,
    ],
  )
  // The draw subroutine; id 103 may draw on its first MAIN only (count in $1650,X).
  const gate = o.grinderDrawsOnce
    ? [0xc9, 0x02, 0x90, 0x01, 0x60] // draws while the count is below 2: pass 0 only
    : o.grinderDrawsTwice
      ? [0xc9, 0x03, 0x90, 0x01, 0x60] // draws while the count is below 3: passes 0 and 1
      : o.grinderDrawsOnPass1
        ? [0xc9, 0x02, 0xf0, 0x01, 0x60] // draws when the count is exactly 2: pass 1 only
        : o.grinderDrawsFromPass1
          ? [0xc9, 0x02, 0xb0, 0x01, 0x60] // draws once the count reaches 2: pass 1 onward
          : null
  put(0x019400, [...(gate ? [0xfe, 0x50, 0x16, 0xbd, 0x50, 0x16, ...gate] : []), ...drawSub])
  put(0x019282, [0x6b])
  put(0x019280, [0x60])
  // id 103 handler: LineGrinder's 17 shape bytes (TrueFrame/SpriteLock test, sound, JMP), then the dispatch block of
  // CODE_01D9A7 around its draw JSR and the JMP to the line step; the step here is the +4 move.
  const handler = (dispatchAt: number) => [
    0xa5,
    0x13,
    0x29,
    0x07,
    0x1d,
    0x26,
    0x16,
    0x05,
    0x9d,
    0xd0,
    0x05,
    0xa9,
    0x00,
    0x8d,
    0xf9,
    0x1d,
    0x4c,
    dispatchAt & 0xff,
    (dispatchAt >> 8) & 0xff,
  ]
  const dispatch = (platAt: number) => [...dispatchBytes(o.alteredGrinder === true), 0x4c, platAt & 0xff, platAt >> 8, 0x60] // prettier-ignore
  put(GRINDER_HANDLER, handler(GRINDER_DISPATCH_AT))
  put(GRINDER_DISPATCH_AT, dispatch(PLAT_ARM_AT))
  // The shared platform arm, the JSL target the $65/$66 arm reaches, and the three kinds of MAIN entry.
  put(PLAT_ARM_AT, PLAT_ARM_BYTES)
  put(0x0194f0, [0x20, 0x00, 0x94, 0x6b])
  put(JMP_HANDLER, [0x4c, GRINDER_DISPATCH_AT & 0xff, GRINDER_DISPATCH_AT >> 8])
  put(CHAINSAW_HANDLER, [...PRELUDE_BYTES, ...handler(GRINDER_DISPATCH_AT)])
  // A second copy for id 31: its $9E is 31, so it takes the `< $65` branch to the platform arm.
  put(0x019500, handler(0x019520))
  put(0x019520, dispatch(PLAT_ARM_AT))
}
