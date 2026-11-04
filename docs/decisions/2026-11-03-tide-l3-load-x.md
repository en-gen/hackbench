Proposed 2026-11-03 (BA, #808)

# No load step sets tide X; HackBench draws phase 0

## Question

On tide maps $0BE and $0C1 the `layers_v5` capture's first frame reads BG3 X 271, but the map view draws a tide at X 0. Should the load X become 271, and what should the tide range code and labels say?

## Options considered

1. Keep load X at 0 for every tide. Acceptance (1) of #808 is RE-SCOPED as a capture artifact: 271 is leftover phase from ticks that ran before the capture's frame 0, not a value the load sets. Relabel bytes $02-$7F as tides in the core and correct the comments that claimed a tide scrolls 1:1. `[PROP]`
2. Draw the X as an unknown phase in $100-$1FF with a "phase unknown" flag. Deferred: it needs a model field and UI wording, for a picture that cannot show a phase (see Why). `[PROP]`
3. Re-define the capture's first frame for tide maps (the first GM14 frame) and re-capture. Deferred: it changes the capture harness for one map family. `[PROP]`

Option A's text includes a pure rule function. It is NOT built on this branch: the tide X rule is in comment and docs only (`docs/rom/level-rendering.md`, "Tide X"), and whether any code expresses it, a `tideBgX` function or an `xPhase` field in `computeL3ScrollRange` and the range payload, is D160 call 3, open. A prepared function with tests (hand cases, plus $002 reading $1F6 and $0BE reading $1AE from the captures) sits on local branch `wip/808-tidebgx`, unmerged. Nothing in the shipped app reads the range or kind. `[PROP]`

Second call, decided with option 1: bytes $02-$7F are relabeled `tide` in the core (`classifyL3Routine`, `computeL3ScrollRange`) because they run the same X code as $01 with static Y. Swept for all 127 tide bytes ($01-$7F) in `test/suite/unit/L3TideClassify.test.ts`. No picture or range number changes. `[PROP]`

## Ruling

wording not recorded. Taken as a proposal only (2026-11-03, BA). `[PROP]`

## Why

- The game adds 1 + Layer1DXPos to BG3 X's low byte and sets the high byte to 1, while Layer3ScrollType is 0 and the game is not paused (`bank_05.asm:5624-5629`). No load step writes it on a tide (`bank_00.asm:4139-4164`, `bank_05.asm:4784-4798`). `ClearMemory` runs only at reset and GM03 (`bank_00.asm:42, 2615`), so X 0 is a post-clear default, not "the game's state": re-entering a level keeps the old value (ASM only, not run).
- The 271 mechanism: on every load the first strip build falls one frame after the first GM14 frame ($002 GM14 497, strip 498; $102 498/499; $127 492/493; $0BE and $0C1 room 493/494). $0BE and $0C1 build that strip at frame 981 after the reload, so the real level's first GM14 frame is 980, and the anchor at 995 is 15 frames later (995 - 980 = 15 on both). The anchor lags because PlayerAnimation stays $0A. The entrance room runs no tide code (Layer3ScrollType is nonzero there: `bank_05.asm:7465-7466`, `bank_00.asm:4145-4146, 4191`, `bank_05.asm:4482-4484`, cleared at `bank_00.asm:2640`). Cross-check: EffFrame is 16 on $002 at X 0 and 47 = 32 + 15 on $0BE and $0C1 (`bank_00.asm:4891-4899`).
- Evidence scope: 5 `layers_v5` captures ($002, $102, $127, $0BE, $0C1), read once, one machine. 980 is inferred from the strip offset, not logged. $0BE's room index in DATA_05D78A was not traced. Later windows read `$100` + (15 on $0BE and $0C1) + frames since the anchor ($002 window 11: $1F6; $0BE window 3: $1AE); no capture exercises a nonzero Layer1DXPos term (ASM only).
- Why the picture is safe: a tide draws 32 columns on a 256 px repeat, so X 0 and $100 draw the same.
- Known mismatch, out of scope: load X 0 does not fully match the game on $0C1. It enters at camera X 652, so the world phase differs (`drawL3Planes` uses xOff 0, `theia/extension/src/node/map-screen.ts:264`). Filed as a bug draft.
- Reference extension: the VS Code extension code (`src/webview/`, `src/providers/`) is not edited and already prints "tide (stationary)" for a tide that is not up/down. It is not unchanged in effect: its range overlay now draws byte $02 with no label (`src/webview/mapEditor/overlays/drawL3Range.ts:50-55, 86-94`; it used to show "L3 range - fixed").

## Applies to

`src/rom/L3Loader.ts` (`classifyL3Routine`, `computeL3ScrollRange`), `src/rom/model/L3Layer.ts` (comment), `docs/rom/level-rendering.md` (Tide X), and acceptance (1) of #808.
