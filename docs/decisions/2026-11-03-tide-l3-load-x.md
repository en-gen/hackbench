Ruled 2026-11-03 (Brian)

# No load step sets tide X; HackBench draws phase 0

## Question

On tide maps $0BE and $0C1 the `layers_v5` capture's first frame reads BG3 X 271, but the map view draws a tide at X 0. Should the load X become 271, and what should the tide range code and labels say?

## Options considered

Lettered as in the walk (Decision 127).

- A. Keep load X at 0 for every tide. Acceptance (1) of #808 is RE-SCOPED as a capture artifact: 271 is the 15 frames between the real level's first GM14 frame and the capture anchor, not a value the load sets. Deliver the stated rule; the map picture does not change.
- B. Add an "unknown phase" flag and draw at a nominal phase. Not taken: a model field and UI wording for a picture that cannot show a phase (see Why).
- C. Emulator run to prove the 15, documentation only. Withdrawn: the 15 is explained from the existing captures and the ASM (see Why).
- D. Re-anchor those two captures at the first gameplay frame and re-capture. Not taken.

Call 2 (Decision 128): bytes $02-$7F are relabeled `tide` in the core (`classifyL3Routine`, `computeL3ScrollRange`) because they run the same X code as $01 with static Y. Swept for all 127 tide bytes ($01-$7F) in `test/suite/unit/L3TideClassify.test.ts`. No picture or range number changes.

Call 3 (Decision 129): where the rule lives. The pure rule function (`tideBgX`) and the range field (`xPhase`) are not built: the rule is documented in `docs/rom/level-rendering.md` ("Tide X") and not expressed in code, and code comments carry at most a pointer. Nothing in the shipped app reads the range or kind.

## Ruling

Relayed by the BA, not the owner's own message. Call 1: "127A". After the evidence was corrected, the owner added: "D127 - tide covers the whole horizontal space of the map, so an X coordinate of the tide doesn't make a lot of sense"; the queue reads this as 127A standing. Call 2: "128A". Call 3: "12A, but docs only. doesn't need to be in code comments", read as 129A as the queue says (only Decision 129 fits "docs only"). #1213 (the $0C1 phase difference): "130A", close #1213; a still map view has no single right tide offset, so the default stays.

## Why

- The game adds 1 + Layer1DXPos to BG3 X's low byte and sets the high byte to 1, while Layer3ScrollType is 0 and the game is not paused (`bank_05.asm:5624-5629`). No load step writes it on a tide (`bank_00.asm:4139-4164`, `bank_05.asm:4784-4798`). `[EST]` from the disassembly.
- `ClearMemory` runs only at reset and GM03 (`bank_00.asm:42, 2615`), so X 0 is a post-clear default, not "the game's state": re-entering a level keeps the old value. `[INF]` from the disassembly alone; not run.
- The 271 mechanism: on every load the first strip build falls one frame after the first GM14 frame ($002 GM14 497, strip 498; $102 498/499; $127 492/493; $0BE and $0C1 room 493/494). `[EST]` from the capture summaries and `map16_pipe_writes.json`.
- $0BE and $0C1 build that strip at frame 981 after the reload, so the real level's first GM14 frame is 980, and the anchor at 995 is 15 frames later (995 - 980 = 15 on both). `[INF]`: 980 is inferred from the strip offset, not logged. The anchor lags because PlayerAnimation stays $0A. `[EST]`
- The entrance room runs no tide code. `[INF]` from the ASM (Layer3ScrollType is nonzero there: `bank_05.asm:7465-7466`, `bank_00.asm:4145-4146, 4191`, `bank_05.asm:4482-4484`, cleared at `bank_00.asm:2640`); $0BE's room index in DATA_05D78A was not traced.
- Cross-check: EffFrame is 16 on $002 at X 0 and 47 = 32 + 15 on $0BE and $0C1 (`bank_00.asm:4891-4899`). `[EST]` from the capture ppu json. Later windows read `$100` + (15 on $0BE and $0C1) + frames since the anchor ($002 window 11: $1F6; $0BE window 3: $1AE); no capture exercises a nonzero Layer1DXPos term (ASM only). `[EST]`
- Scope of the captures: 5 `layers_v5` captures ($002, $102, $127, $0BE, $0C1), read once, one machine.
- Why the picture is safe: a tide draws 32 columns on a 256 px repeat, so X 0 and $100 draw the same. `[INF]` from `drawL3Planes`.
- The decision does not rest on the corrected evidence alone: the owner's own reason for 127A is that a tide covers the whole horizontal space of the map, so an X coordinate for it makes little sense.
- Load X 0 does not fully match the game on $0C1. It enters at camera X 652, so the world phase differs (`drawL3Planes` uses xOff 0, `theia/extension/src/node/map-screen.ts:264`). Ruled not a bug: #1213 closed by 130A (closing the issue is Planning's job).
- Reference extension: the VS Code extension code (`src/webview/`, `src/providers/`) is not edited and already prints "tide (stationary)" for a tide that is not up/down. It is not unchanged in effect: its range overlay now draws byte $02 with no label (`src/webview/mapEditor/overlays/drawL3Range.ts:50-55, 86-94`; it used to show "L3 range - fixed").

## Applies to

`src/rom/L3Loader.ts` (`classifyL3Routine`, `computeL3ScrollRange`, comments), `src/rom/model/L3Layer.ts` and `src/rom/model/MapPayload.ts` (comments), `theia/extension/src/node/map-screen.ts` (comment), `docs/rom/level-rendering.md` (Tide X), and acceptance (1) of #808.
