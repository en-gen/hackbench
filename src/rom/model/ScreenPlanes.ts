/**
 * Which planes each SNES screen draws, and in what order (#562). The main ($212C)
 * and sub ($212D) designations pick the layers; `ppuDrawOrder` gives the BG mode 1
 * priority order once, and each screen is that table filtered to its own layers.
 * OBJ (bit 4, #564) is one `sprites` entry on each screen that designates it: just
 * before BG1's priority plane (the owner's ruling), or on a screen with no layer 1 at
 * the table's OBJ priority 2 slot (docs/rom/obj-priority.md section 1), the one between BG1's
 * low and high planes.
 * BG4 (bit 3) does not exist in mode 1. Tables: SMWDisX bank_05.asm:480-504 (OBJ is
 * TM/TS bit $10, :485-494).
 */
import { ppuDrawOrder } from './RenderPass'

export type PlaneKey = 'l2Low' | 'l1Low' | 'l2High' | 'l1High' | 'l3Low' | 'l3High'
/** A source a screen's list can name: a BG plane, or the sprite layer. */
export type ListKey = PlaneKey | 'sprites'
export interface ScreenPlanes {
  main: ListKey[]
  sub: ListKey[]
}

const BIT = { l1: 0x01, l2: 0x02, l3: 0x04 } as const
const OBJ_BIT = 0x10

/** The pre-#561 stacking: BG1 and BG2 on one screen, nothing on the other. */
export const FALLBACK_SCREENS: ScreenPlanes = {
  main: ['l2Low', 'l1Low', 'l2High', 'sprites', 'l1High'],
  sub: [],
}

export function screenPlanes(main: number, sub: number, bg3Priority: boolean): ScreenPlanes {
  const order = ppuDrawOrder(bg3Priority)
  const on = (mask: number): ListKey[] => {
    const bg = order.flatMap(p =>
      p.layer !== 'sprites' && mask & BIT[p.layer]
        ? [`${p.layer}${p.priority ? 'High' : 'Low'}` as PlaneKey]
        : [],
    )
    if (!(mask & OBJ_BIT)) return bg
    // Planes of this screen that the table draws before OBJ priority 2.
    const slot = order.findIndex(p => p.layer === 'sprites' && p.priority === 2)
    const below = order.slice(0, slot).filter(p => p.layer !== 'sprites' && mask & BIT[p.layer])
    const at = bg.includes('l1High') ? bg.indexOf('l1High') : below.length
    return [...bg.slice(0, at), 'sprites', ...bg.slice(at)]
  }
  return { main: on(main), sub: on(sub) }
}
