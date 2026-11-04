Proposed 2026-11-03 (BA, #808)

# Tide layer 3 loads at X 0; the capture's 271 is not a load value

## Question

On tide maps $0BE and $0C1 the `layers_v5` capture's first frame reads BG3 X 271, but the map view draws a tide at X 0. Should the load X become 271, and what should the tide range indicator and tide labels say?

## Options considered

1. Keep load X at 0 for every tide. Acceptance (1) of #808 is RE-SCOPED as a capture artifact. The range indicator states the real X rule, and bytes $02-$7F are labeled tides. `[PROP]`
2. Draw the X as an unknown phase in $100-$1FF with a "phase unknown" flag. Deferred: needs a new model field and a UI wording, for a picture that cannot show a phase anyway. `[PROP]`
3. Re-run the headless capture on $0BE with write callbacks on $22 and $23 to count the GM14 frames and reproduce the 15. Deferred: it would document the artifact, not change what the model does. `[PROP]`
4. Re-define the capture's first frame for tide maps (the first GM14 frame) and re-capture. Deferred: it changes the capture harness for one map family. `[PROP]`

A second call, decided with option 1: bytes $02-$7F are relabeled `tide` in the core (`classifyL3Routine`, `computeL3ScrollRange`) because they run the same X code as $01 with static Y. The reference VS Code extension (`src/webview/`, `src/providers/`) is left alone; it already prints "tide (stationary)" for a tide that is not up/down. `[PROP]`

## Ruling

wording not recorded. Taken as a proposal only (2026-11-03, BA). `[PROP]`

## Why

- The game adds one pixel per frame plus the camera's movement to BG3 X and sets the high byte to 1 (`bank_05.asm:5624-5629`); no load step writes it on a tide (`bank_00.asm:4139-4164`, `bank_05.asm:4784-4798`). At the first GM14 frame the routine has not run, so X is 0. Maps $002, $102 and $127 read X 0 at their first captured frame, which is the first GM14 frame (capture anchor equals GM14 start). `[EST]` from the capture summaries, one machine.
- Maps $0BE and $0C1 have identical timelines: GM14 at frame 493, an entrance animation held for 502 frames, a level reload in the middle (`reloadDuringWait`), anchor at frame 995. 271 is `$100` + 15 of leftover phase from that wait, not a property of the level. The exact 15 is not reproduced: the logs do not show the reload's non-GM14 frames, which would have to total 231 or 487. `[EST]`
- Evidence scope: SMWDisX, and `layers_v5` captures of vanilla maps $002, $102, $127, $0BE and $0C1, one machine, 2026-09-25 captures. BG3 X on $002 and $0BE read `$100` + frames since the anchor in later windows.
- Hardcoding 15, or any per-map constant, would be a number the model cannot derive.

## Applies to

`src/rom/L3Loader.ts` (`classifyL3Routine`, `computeL3ScrollRange`), `src/rom/L3TideX.ts`, `docs/rom/level-rendering.md` (Tide X), and acceptance (1) of #808.
