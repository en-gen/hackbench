/**
 * RenderPass.ts -- the compositor's pass list, which is the PPU's mode-1
 * priority table rather than a hand-kept draw order.
 *
 * "Backgrounds, then sprites, then foreground" cannot express mode 1: OBJ.1
 * belongs under every BG1 and BG2 tile, OBJ.3 over all of them, and BG3's
 * priority-1 position moves with the header bit. Evidence, and the one link
 * in the chain that is hardware documentation rather than `SMWDisX`:
 * `docs/obj-priority.md` section 1.
 */

export type PassLayer = 'l1' | 'l2' | 'l3' | 'sprites'

export interface RenderPass {
  layer: PassLayer
  /** 0..1 for a BG layer's tile priority bit, 0..3 for OBJ priority. */
  priority: number
}

const p = (layer: PassLayer, priority: number): RenderPass => ({ layer, priority })

/** Back to front, BG3 priority bit SET. docs/snes-superfamicom-selected.md:501-514. */
const BG3_PRI_SET: readonly RenderPass[] = [
  p('l3', 0), p('sprites', 0), p('sprites', 1), p('l2', 0), p('l1', 0),
  p('sprites', 2), p('l2', 1), p('l1', 1), p('sprites', 3), p('l3', 1),
]

/** Back to front, bit CLEAR: BG3.1 drops to just under OBJ.0 (:516-518). */
const BG3_PRI_CLEAR: readonly RenderPass[] = [
  p('l3', 0), p('sprites', 0), p('l3', 1), p('sprites', 1), p('l2', 0),
  p('l1', 0), p('sprites', 2), p('l2', 1), p('l1', 1), p('sprites', 3),
]

/** The full mode-1 pass list for a level, back to front. */
export function ppuDrawOrder(bg3Priority: boolean): readonly RenderPass[] {
  return bg3Priority ? BG3_PRI_SET : BG3_PRI_CLEAR
}

/** Which `(layer, priority)` pairs a level actually has content for. */
export interface PassOccupancy {
  l1: ReadonlySet<number>
  l2: ReadonlySet<number>
  l3: ReadonlySet<number>
  sprites: ReadonlySet<number>
}

/**
 * The level's live passes, in PPU order. A compositor iterates this
 * directly; a later per-pass-canvas stage allocates one canvas per entry.
 */
export function livePasses(bg3Priority: boolean, occupancy: PassOccupancy): RenderPass[] {
  return ppuDrawOrder(bg3Priority).filter(pass => occupancy[pass.layer].has(pass.priority))
}
