/**
 * RopeLength.ts -- the rope ($64) at the length the game draws it (#1230, D152 / Decision 103 E).
 * The draw tests the slot it runs in (bank_01.asm:12583-12589) and the loader picks the slot (SlotPick.ts), so the picture
 * is the ROM's own draw run in the slot the loader would give. Where the slot depends on what else is loaded, the draw is
 * run in the long slot and in the short one, and the short one is shown (the screen door for the extra length comes later).
 */
import type { RomFile } from '../../RomFile'
import type { CodeFingerprint } from './InitLatches'
import { slotWalk } from './SlotPick'
import { VANILLA_DISPATCH } from './LineGuided'
import { drawnParts, type SpriteModel, type SpritePart } from './SpriteRunner'

/** The coordinate the loader tests: Y in a vertical map, X in a horizontal one (the stores at bank_02.asm:5236 and 5245, compared at 5278-5281, the `$00` the pick reads). */
export const alongScroll = (x: number, y: number, vertical: boolean): number => (vertical ? y : x)

/** The ids whose line-guided arm calls the rope draw (`VANILLA_DISPATCH`, hash-gated in the runner), not an id list of this module. */
export const isRopeId = (id: number): boolean =>
  VANILLA_DISPATCH.byId?.[id]?.includes('rope') === true

export interface RopeAt {
  id: number
  /** $1692 of the loader image. */
  setting: number
  x: number
  y: number
  vertical: boolean
  /** A test hook: a synthetic cart's own loader fingerprint. */
  spec?: CodeFingerprint
}

const DIFFERENT_SPOT =
  'the rope starts at a different spot in the two slots it can load into, so only the short length is shown'
const key = (p: SpritePart) => `${p.dx},${p.dy}`

/**
 * The rope's model. `runAt(slot)` runs the sprite in that slot. A loader or setting the pick cannot read keeps slot 0 and
 * says so; a pick whose two slots draw the same parts (setting 0, the reserved slots) is one solid run.
 */
export function ropeModel<M extends SpriteModel>(
  rom: RomFile,
  at: RopeAt,
  runAt: (slot: number) => M,
): M {
  const w = slotWalk(rom, at.setting, at.id, alongScroll(at.x, at.y, at.vertical), at.spec)
  if (w.status !== 'ok') {
    const m = runAt(0)
    // Only a draw the line-guided gate confirmed as the rope is flagged; any other handler is left as it was.
    return !m.snaps
      ? m
      : {
          ...m,
          unverifiedReason:
            m.unverifiedReason ?? `${w.reason}, so the rope is shown at its short length`,
          lengthNote: `The rope is shown at its short length: ${w.reason}.`,
        }
  }
  const long = runAt(w.long)
  // The gate (hashed draw, dispatch order) did not confirm the rope: the run is as it was before #1230, in slot 0; the gate's
  // own reason is the panel note, so a rope that lost the gate does not just draw short in silence.
  if (!long.snaps) {
    const m = runAt(0)
    return m.lineGateReason
      ? { ...m, lengthNote: `Not checked against the loader's sprite slot: ${m.lineGateReason}.` }
      : m
  }
  if (w.short === w.long) return long
  const short = runAt(w.short)
  if (short.chosen !== long.chosen || short.anchor?.x !== long.anchor?.x || short.anchor?.y !== long.anchor?.y)
    return { ...short, unverifiedReason: short.unverifiedReason ?? DIFFERENT_SPOT, lengthNote: 'The rope is shown at its short length: it starts at a different spot in the two slots it can load into.' } // prettier-ignore
  // The same positions: the picture is the loader's first pick (its motor tile comes from that slot), not the walk's far end.
  const spots = (m: SpriteModel) =>
    m.passes[m.chosen ?? -1] && new Set(drawnParts(m.passes[m.chosen!]!).map(key))
  const [a, b] = [spots(short), spots(long)]
  if (a && b && a.size === b.size && [...a].every(k => b.has(k))) return long
  return short
}
