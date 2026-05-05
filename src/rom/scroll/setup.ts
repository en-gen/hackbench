/**
 * setup.ts — port of the cmd setup routines in bank_05.
 *
 * The scroll-sprite spawn (`bank_02.asm:5290+`) writes
 * `Layer1ScrollCmd` and triggers the dispatcher
 * `CODE_05BCE9 / CODE_05BCD6` which jumps to the per-cmd setup routine.
 * Setup runs ONCE per scroll-sprite spawn and:
 *
 *   1. Optionally re-maps the cmd byte via per-cmd lookup tables.
 *   2. Clears `Layer{N}Scroll{X,Y}Speed` and `Scroll{X,Y}PosUpd`.
 *   3. Initializes `Layer{N}ScrollType` and `Layer{N}ScrollTimer` from
 *      ROM tables indexed by `Layer{N}ScrollBits`.
 *
 * The simulator runs setup as part of `buildScrollSimulator` to convert
 * the post-`simulateScrollSetup` seed (raw cmd + bits) into the
 * INITIAL `ScrollState` the per-frame `tick` works against.
 */

import { DATA_05CA61, DATA_05CA68 } from '../scrollData'
import type { ScrollState } from '../scrollSim'
import { wrap8 } from '../scrollSim'

/**
 * `CODE_05BD36 → CODE_05BD4C` (bank_05.asm:4623-4653) — the setup
 * shared by cmds $00 and $01 (and several others that fall through
 * to `CODE_05BD4C`). For each of L1 and L2:
 *
 *   - Clear `Scroll{X,Y}Speed` and `Scroll{X,Y}PosUpd`.
 *   - Set `ScrollType  = DATA_05CA61[bits]`.
 *   - Set `ScrollTimer = DATA_05CA68[bits]`.
 *
 * The cmd-remap step (line 4625-4632 — `LDA DATA_05C9D1,Y / STA
 * Layer1ScrollCmd`) is already handled upstream by
 * `simulateScrollSetup` in `src/rom/scrollDispatch.ts`, so by the time
 * we get here the seed's `layer{1,2}ScrollCmd` and `layer{1,2}ScrollBits`
 * are post-remap.
 */
export function applyCmd0001Setup(s: ScrollState): ScrollState {
  // L1 init.
  const l1Type  = wrap8(DATA_05CA61[s.layer1ScrollBits] ?? 0)
  const l1Timer = wrap8(DATA_05CA68[s.layer1ScrollBits] ?? 0)
  // L2 init.
  const l2Type  = wrap8(DATA_05CA61[s.layer2ScrollBits] ?? 0)
  const l2Timer = wrap8(DATA_05CA68[s.layer2ScrollBits] ?? 0)
  return {
    ...s,
    layer1ScrollType:    l1Type,
    layer1ScrollTimer:   l1Timer,
    layer2ScrollType:    l2Type,
    layer2ScrollTimer:   l2Timer,
    layer1ScrollXSpeed:  0,
    layer1ScrollYSpeed:  0,
    layer2ScrollXSpeed:  0,
    layer2ScrollYSpeed:  0,
    layer1ScrollXPosUpd: 0,
    layer1ScrollYPosUpd: 0,
    layer2ScrollXPosUpd: 0,
    layer2ScrollYPosUpd: 0,
  }
}

/**
 * Pick the right setup routine for the cmd and apply it. Cmds that
 * haven't been ported yet pass through unchanged — the simulator's
 * `cmdHold` fallback handles their per-frame tick.
 */
export function applyCmdSetup(s: ScrollState): ScrollState {
  switch (s.layer1ScrollCmd) {
    case 0x00:
    case 0x01:
      return applyCmd0001Setup(s)
    default:
      return s
  }
}
