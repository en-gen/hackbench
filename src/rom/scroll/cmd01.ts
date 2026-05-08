/**
 * cmd01.ts — port of the cmd $01 per-frame handlers.
 *
 * Sprite $E8 (`SCROLL_SPRITE_BASE + 1`) writes `Layer1ScrollCmd = $01`
 * via the cmd setup dispatcher (`CODE_05BCE9`). Once set, the per-frame
 * loop dispatches:
 *
 *   - **L1 cmd $01** → direct `CODE_05C04D` call (parallax core).
 *     ASM dispatch: `CODE_05BC76` at bank_05.asm:4518-4541 maps cmd
 *     index 1 to the parallax routine.
 *
 *   - **L2 cmd $01** → `CODE_05C198` at bank_05.asm:5186-5196:
 *
 *         JSR CODE_05C04D              ; run parallax for L2
 *         REP #$20                     ; A → 16-bit
 *         LDA.W NextLayer2XPos         ; mirror L2 X target onto L1
 *         STA.W NextLayer1XPos         ; (the autoscroll X-lock)
 *         LDA.B Layer2YPos
 *         CLC
 *         ADC.W ScreenShakeYOffset     ; layer 2 + screen shake
 *         STA.B Layer2YPos
 *         SEP #$20
 *         RTS
 *
 *     The X-lock side effect makes Layer1XPos auto-scroll at L2's
 *     parallax pace — for `$009`, L2's parallax-target table drives
 *     forward motion from `$0000` up through ~`$0ACC` (= 2764 px,
 *     observed as `l1x.max` in the capture).
 *
 * Strategy boundaries: the dispatcher (`scrollSim.tick`) sets
 * `scrollLayerIndex` before invoking each strategy, so these handlers
 * just call `parallaxTick` for the right layer. They do not read
 * `scrollLayerIndex` themselves.
 */

import type { RomFile } from '../RomFile'
import type { ScrollState } from '../scrollSim'
import { wrap16 } from '../scrollSim'
import { parallaxTick } from './parallaxCore'

/** L1 cmd $01: bare parallax tick on layer 1. */
export function cmd01L1(s: ScrollState, rom: RomFile, screenMode: number): ScrollState {
  return parallaxTick(s, rom, 'l1', screenMode)
}

/**
 * L2 cmd $01: parallax tick on layer 2, then mirror `NextLayer2XPos`
 * into `NextLayer1XPos`, then add `screenShakeYOffset` to `Layer2YPos`.
 */
export function cmd01L2(s: ScrollState, rom: RomFile, screenMode: number): ScrollState {
  let s2 = parallaxTick(s, rom, 'l2', screenMode)
  s2 = { ...s2, nextLayer1XPos: s2.nextLayer2XPos }
  s2 = { ...s2, layer2YPos: wrap16(s2.layer2YPos + s2.screenShakeYOffset) }
  return s2
}
