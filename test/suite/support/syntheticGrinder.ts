/**
 * The synthetic cart's ids 31, 32 and 103 (the line-guided grinder): see the Ids list in syntheticSpriteRom.ts.
 * Split out to keep that file under the content gate's byte-token limit. Hand-written test opcodes: the id 103
 * handler is an entry of our own and a dispatch of our own, and `grinderDrawsBeforeSnap` RUNS them and watches the
 * calls (it does not read their bytes).
 */
import { fingerprint } from '../../../src/rom/Fingerprint'
import type { RomFile } from '../../../src/rom/RomFile'
import type { DispatchShape } from '../../../src/rom/sprites/interp/LineGuided'
import type { SyntheticOptions } from './syntheticSpriteRom'

/** Where id 103's handler sits, its dispatch block, and the calls the gate expects of this cart: draw, interact, line step. */
export const GRINDER_HANDLER = 0x019200
export const GRINDER_DISPATCH_AT = 0x019220

/**
 * The shape this cart's dispatch is expected to have, fingerprinted from the cart as it stands NOW (call it after any
 * edit that should still be accepted): draw at $019400, interact at $019282, step at $019290. A test plants a defect
 * by editing the cart AFTER taking the shape from a pristine one.
 */
export const grinderShape = (rom: RomFile): DispatchShape => {
  const at = (a: number, len: number) => ({ len, sha: fingerprint(rom.readAt(a, len))! })
  return {
    routines: { draw67: at(0x019400, 8), interact: at(0x019282, 4), step: at(0x019290, 8) },
    arm: ['draw67', 'interact', 'step'],
  }
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
  put(0x019282, [0xea, 0xea, 0xea, 0x6b])
  put(0x019280, [0x60])
  // id 103 handler: an entry of our own (SpriteLock/TrueFrame test, JMP), then a dispatch block of our own;
  // the step here is the +4 move.
  // Our own entry: LDA SpriteLock / ORA flag,X / STA $0C / LDA TrueFrame / AND #7 / ORA $0C / STA $000C / JMP.
  const handler = (dispatchAt: number) => [
    ...[0xa5, 0x9d, 0x1d, 0x26, 0x16, 0x85, 0x0c, 0xa5, 0x13, 0x29, 0x07, 0x05, 0x0c, 0x8d, 0x0c, 0x00],
    ...[0x4c, dispatchAt & 0xff, (dispatchAt >> 8) & 0xff],
  ] // prettier-ignore
  // Our own dispatch: JSR draw, JSL interact (an RTL), JMP step; `alteredGrinder` calls the interact first.
  const draw = [0x20, 0x00, 0x94]
  const interact = [0x22, 0x82, 0x92, 0x01]
  const dispatch = [
    ...(o.alteredGrinder ? [...interact, ...draw] : [...draw, ...interact]),
    0x4c,
    0x90,
    0x92,
  ]
  put(GRINDER_HANDLER, handler(GRINDER_DISPATCH_AT))
  put(GRINDER_DISPATCH_AT, dispatch)
  // A second copy for id 31, whose MAIN can point at the grinder handler (id31IsGrinder).
  put(0x019500, handler(0x019520))
  put(0x019520, dispatch)
}
