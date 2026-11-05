/**
 * RopeLength.ts -- the rope ($64) at the length the game draws it (#1230, D152 / Decision 103 E).
 * The draw tests the slot it runs in (bank_01.asm:12583-12589) and the loader picks the slot (SlotPick.ts), so the picture
 * is the ROM's own draw run in the slot the loader would give. Where the slot depends on what else is loaded, the draw is
 * run in the long slot and in the short one; the parts only the long run drew are tagged `door`.
 */
import type { RomFile } from '../../RomFile'
import type { CodeFingerprint } from './InitLatches'
import { slotWalk } from './SlotPick'
import { VANILLA_DISPATCH } from './LineGuided'
import { drawnParts, type SpriteModel, type SpritePart } from './SpriteRunner'

/** The coordinate the loader tests: Y in a vertical map, X in a horizontal one (bank_02.asm:5217-5240, the `$00` the pick reads). */
export const alongScroll = (x: number, y: number, vertical: boolean): number => (vertical ? y : x)

/**
 * Whether the screen door draws the extra length. The door itself lands with #1132; until then the extra parts are left
 * out and the rope shows its short length (as before), never a solid long one the ruling does not allow.
 */
export const DOOR_WIRED = false

/** The ids whose line-guided arm calls the rope draw (`VANILLA_DISPATCH`, hash-gated in the runner), not an id list of this module. */
export const isRopeId = (id: number): boolean => VANILLA_DISPATCH.byId?.[id]?.includes('rope') === true

export interface RopeAt {
  id: number
  /** $1692 of the loader image. */
  setting: number
  x: number
  y: number
  vertical: boolean
  /** A test hook: a synthetic cart's own loader fingerprint. */
  spec?: CodeFingerprint
  /** Test hook, default `DOOR_WIRED`. */
  door?: boolean
}

const key = (p: SpritePart) => `${p.dx},${p.dy}`

/** The short run's pass with the parts only the long run drew added, tagged `door` (the short run's own parts stay solid). */
function withExtras(short: SpriteModel, long: SpriteModel): SpriteModel {
  return {
    ...short,
    passes: short.passes.map((p, i) => {
      const have = new Set(drawnParts(p).map(key))
      const extra = drawnParts(long.passes[i] ?? p)
        .filter(q => !have.has(key(q)))
        .map((q): SpritePart => ({ ...q, door: true }))
      return extra.length ? { ...p, parts: [...p.parts, ...extra] } : p
    }),
  }
}

/**
 * The rope's model. `runAt(slot)` runs the sprite in that slot. A loader or setting the pick cannot read keeps slot 0 and
 * says so; a pick whose two slots draw the same parts (setting 0, the reserved slots) is one solid run.
 */
export function ropeModel<M extends SpriteModel>(rom: RomFile, at: RopeAt, runAt: (slot: number) => M): M {
  const w = slotWalk(rom, at.setting, at.id, alongScroll(at.x, at.y, at.vertical), at.spec)
  if (w.status !== 'ok') {
    const m = runAt(0)
    return { ...m, unverifiedReason: m.unverifiedReason ?? `${w.reason}, so the rope is shown at its short length` }
  }
  const long = runAt(w.long)
  if (w.short === w.long) return long
  const short = runAt(w.short)
  const [a, b] = [short.anchor, long.anchor]
  if (short.chosen !== long.chosen || a?.x !== b?.x || a?.y !== b?.y)
    return { ...short, unverifiedReason: short.unverifiedReason ?? 'the rope starts at a different spot in the two slots it can load into, so only the short length is shown' } // prettier-ignore
  if (!(at.door ?? DOOR_WIRED)) return short
  return { ...short, ...withExtras(short, long) } as M
}
