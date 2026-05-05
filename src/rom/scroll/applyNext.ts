/**
 * applyNext.ts — the end-of-frame "commit" step.
 *
 * SMW's main loop runs `ProcScreenScrollCmds` (which mutates
 * `NextLayer{1,2}{X,Y}Pos`) and then commits `Next* → Layer*` so the
 * BG2/BG1 PPU registers see the new viewport position. The commit
 * lives in bank_00 around `UpdateScreenPosition` — the agent decode
 * placed it at line 13650 (`Layer1YPos` ← `NextLayer1YPos` at frame
 * start).
 *
 * For our simulator, we model it as the LAST step of `tick`. That
 * means at the start of frame N+1, `Layer*Pos === NextLayer*Pos` from
 * frame N's cmd-handler output. cmd handlers in turn read the *current*
 * `NextLayer*Pos` (which is the previous frame's commit) and write a
 * new target.
 */

import type { ScrollState } from '../scrollSim'

export function applyNext(s: ScrollState): ScrollState {
  return {
    ...s,
    layer1XPos: s.nextLayer1XPos,
    layer1YPos: s.nextLayer1YPos,
    layer2XPos: s.nextLayer2XPos,
    layer2YPos: s.nextLayer2YPos,
  }
}
