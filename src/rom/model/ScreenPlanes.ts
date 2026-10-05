/**
 * Which planes each SNES screen draws, and in what order (#562). The main ($212C)
 * and sub ($212D) designations pick the layers; `ppuDrawOrder` gives the BG mode 1
 * priority order once, and each screen is that table filtered to its own layers.
 * OBJ (bit 4) is dropped until the sprite toggle exists (#564); BG4 (bit 3) does
 * not exist in mode 1. Tables: SMWDisX bank_05.asm:480-504.
 */
import { ppuDrawOrder } from './RenderPass'

export type PlaneKey = 'l2Low' | 'l1Low' | 'l2High' | 'l1High' | 'l3Low' | 'l3High'
export interface ScreenPlanes {
  main: PlaneKey[]
  sub: PlaneKey[]
}

const BIT = { l1: 0x01, l2: 0x02, l3: 0x04 } as const

/** The pre-#561 stacking: BG1 and BG2 on one screen, nothing on the other. */
export const FALLBACK_SCREENS: ScreenPlanes = {
  main: ['l2Low', 'l1Low', 'l2High', 'l1High'],
  sub: [],
}

export function screenPlanes(main: number, sub: number, bg3Priority: boolean): ScreenPlanes {
  const order = ppuDrawOrder(bg3Priority)
  const on = (mask: number) =>
    order.flatMap(p =>
      p.layer !== 'sprites' && mask & BIT[p.layer]
        ? [`${p.layer}${p.priority ? 'High' : 'Low'}` as PlaneKey]
        : [],
    )
  return { main: on(main), sub: on(sub) }
}
