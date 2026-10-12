/**
 * Which planes each SNES screen draws, and in what order (#562). The main ($212C)
 * and sub ($212D) designations pick the layers; `ppuDrawOrder` gives the BG mode 1
 * priority order once, and each screen is that table filtered to its own layers.
 * OBJ (bit 4, #564) is four entries on each screen that designates it, one per OAM
 * priority (#795): OBJ.0, OBJ.1 and OBJ.3 at their slots in the table
 * (docs/rom/obj-priority.md section 1); OBJ.2 just before BG1's priority plane (the
 * owner's ruling, #564), or on a screen with no layer 1 at the table's slot, the one
 * between BG1's low and high planes.
 * BG4 (bit 3) does not exist in mode 1. Tables: SMWDisX bank_05.asm:480-504 (OBJ is
 * TM/TS bit $10, :485-494).
 */
import { ppuDrawOrder } from './RenderPass'

export type PlaneKey = 'l2Low' | 'l1Low' | 'l2High' | 'l1High' | 'l3Low' | 'l3High'
/** The sprite layer's pixels of one OAM priority, 0-3. */
export type SpriteKey = 'sprites0' | 'sprites1' | 'sprites2' | 'sprites3'
export const SPRITE_KEYS: readonly SpriteKey[] = ['sprites0', 'sprites1', 'sprites2', 'sprites3']
/** A source a screen's list can name: a BG plane, or one priority of the sprite layer. */
export type ListKey = PlaneKey | SpriteKey
export interface ScreenPlanes {
  main: ListKey[]
  sub: ListKey[]
}

const BIT = { l1: 0x01, l2: 0x02, l3: 0x04 } as const
const OBJ_BIT = 0x10

/** The pre-#561 stacking: BG1 and BG2 on one screen, nothing on the other; OBJ as `screenPlanes` places it. */
export const FALLBACK_SCREENS: ScreenPlanes = {
  main: ['sprites0', 'sprites1', 'l2Low', 'l1Low', 'l2High', 'sprites2', 'l1High', 'sprites3'],
  sub: [],
}

export function screenPlanes(main: number, sub: number, bg3Priority: boolean): ScreenPlanes {
  const order = ppuDrawOrder(bg3Priority)
  const on = (mask: number): ListKey[] => {
    const obj = !!(mask & OBJ_BIT)
    const list = order.flatMap((p): ListKey[] => {
      if (p.layer === 'sprites') return obj && p.priority !== 2 ? [`sprites${p.priority}` as SpriteKey] : [] // prettier-ignore
      return mask & BIT[p.layer] ? [`${p.layer}${p.priority ? 'High' : 'Low'}` as PlaneKey] : []
    })
    if (!obj) return list
    // OBJ.2: before l1High (the ruling); with no layer 1, after the planes the table draws before it.
    const slot = order.findIndex(p => p.layer === 'sprites' && p.priority === 2)
    const below = order.slice(0, slot).filter(p => p.layer === 'sprites' || mask & BIT[p.layer])
    const at = list.includes('l1High') ? list.indexOf('l1High') : below.length
    return [...list.slice(0, at), 'sprites2', ...list.slice(at)]
  }
  return { main: on(main), sub: on(sub) }
}
