# What moves Layer 2 on maps $009 and $1EF

Scope: the phase 1 trace for en-gen/hackbench#1242. Vanilla ROM (`Super Mario World (USA).vanilla.sfc`),
SMWDisX `bank_00/02/05.asm` and `rammap.asm`. Every ROM claim cites `file:line`; every run claim states its
scope. No Lunar Magic anywhere.

**Evidence scope, whole document.** Captures: Mesen 2 (`--testrunner`, `rampoweronstate=AllZeros`,
`disableframeskipping=true`), headless, one machine, 2026-11-07, from a one-off Lua recorder in the session
scratchpad (not committed), force-loading the map through the ROM's own `OverworldOverride` route or, for
$1EF, a hook on `CODE_05D8B7`. Probe: `loadLevelState` plus two calls per frame on the repo's 65816 core
(`src/rom/cpu`, `src/rom/sprites/interp`), same machine and date. The brief asked for the libretro core;
Mesen was used because the validation repo already drives it headless (SRAM guard, determinism flags),
while the libretro core here runs only inside a browser page.

## Answers

| | $009 (Donut Plains 2) | $1EF (Vanilla Dome 1 sub area) |
| --- | --- | --- |
| What moves Layer 2 | Layer 2's own waypoint path (`CODE_05C04D`, run for Layer 2 by cmd $01) | Sink routine `CODE_05C81C`, Layer 2 Y only |
| Camera | Follows Layer 2's X path: L1 X is overwritten with L2 X every frame. L1 Y has its own path | Not touched: Mario drives it. L2 X equals L1 X (parallax setting 1) |
| Repeats | No. About 7,780 frames, then freezes at the last waypoint | No. Sinks to a floor and stops; nothing raises it for this map's setting |
| Mario | None. Same positions for 6 Mario placements; the follower reads no Mario cell | Yes: moves only while Mario stands on Layer 2 (`Layer2Touched`) and camera X is outside the rest window |
| Load-time state | $1A/$1E = 0, $1C/$20 = $C0, scroll block seeded by the sprite loader | $1A/$1E = 0, $1C/$20 = $C0, L1 cmd 0, L2 cmd $0E |

## Claims in the issue that are wrong or loose

- `L2Loader.ts` says `Layer2ScrollCmd` "is never set" (comment near `:442`) and "always 0 in vanilla play"
  (near `:580`); the issue quotes older line numbers (`:425-432`, `:567`). The literal writes outside bank
  $0C are only the clear at `bank_02.asm:5834` (smw-mcp `get_ram_writes`: 26 sites, 25 in bank $0C =
  credits). But `Layer1ScrollCmd` ($143E) and `Layer2ScrollCmd` ($143F) are adjacent bytes and the setups
  store 16 bits into the first: `CODE_05BD36` (`bank_05.asm:4628-4632`), `CODE_05BFD5` (`:4938-4940`,
  entered with the command in the high byte by `CODE_05C036`, `:4990-4997`), and the stores at `:4660`,
  `:4707`, `:4753`, `:4807`, `:4853`, `:4918`. The high byte lands in $143F. Measured: $009 reads
  $143E/$143F = 1/1 and $1EF reads 0/$0E on the first level frame. The reference extension accounts for
  this (`MapEditorProvider.ts:457-478`).
- "Layer 2 scroll setting $3 may explain $009." It moves nothing. `bank_05.asm:7268-7277` turns the header's
  high nibble into `HorizLayer2Setting` and `VertLayer2Setting`; for $009 both are 0 after load (probe and
  capture), so the parallax derivation in `UpdateScreenPosition` (`bank_00.asm:13726-13740`) is skipped
  and L2 stays where the scroll routine put it.
- The table #114 pointed at (`bank_05.asm:4551-4565`) does fire: it is the Layer 2 dispatch `CODE_05BCA5`,
  reached every frame by `ProcScreenScrollCmds`.
- The brief's "$146A" is `Layer3HorizOffset`; Layer 2 Y's `NextLayer` word is $1468 (`rammap.asm`).

## The frame, in the ROM's order

`CODE_00A28A` (`bank_00.asm:4498-4506`) runs `UpdateScreenPosition` (`:13631`) then `ProcScreenScrollCmds`
(`bank_05.asm:4451`). The boss rooms call the same pair (`bank_00.asm:3046-3047`).

1. `UpdateScreenPosition` copies the four `NextLayer*Pos` words ($1462-$1468) into `Layer1/2 X/Y`
   ($1A, $1C, $1E, $20; `bank_00.asm:13631-13655`). Mario-dependent camera code follows, gated by
   `HorizLayer1Setting` (`:13658`, `:13701`) and `VertLayer1Setting` (`CODE_00F7F4` returns at once on 0,
   `:13776-13779`). Then the Layer 2 parallax from the two Layer 2 settings (`:13726-13740`).
2. `ProcScreenScrollCmds` runs `CODE_05BC76` (Layer 1 dispatch, `:4518-4540`), then `CODE_05BCA5` (Layer 2
   dispatch, `:4542-4565`), `ScrollLayerIndex` 0 and 4. Both return at once while `SpriteLock` ($9D) is
   nonzero (`:4520-4521`, `:4547-4548`): Mario's death freezes the screen. Then `CODE_05BC4A` and the delta
   words.

So the stored $1A..$20 lag the `NextLayer*` words by one frame; both are in every capture row below.

## $009: sprite $E8, command $01

**Setup, once at load.** The level data loader calls `CODE_02A751` (`bank_05.asm:72`), which sweeps the
sprite list (`CODE_02AC5C`, `bank_02.asm:5837-5895`). The scroll sprite is read in `CODE_02A84C`
(`bank_02.asm:5282-5306`): sprite number minus $E7 goes to `Layer1ScrollCmd`, the sprite's first byte
shifted right twice goes to `Layer1ScrollBits`, then `CODE_05BCD6` runs (`bank_05.asm:4567-4577`): the
Layer 1 setup `CODE_05BCE9` and the Layer 2 setup `CODE_05BD0E`, both table-dispatched (`:4579-4618`).
Command $01 is `CODE_05BD36` (`:4623-4632`): it zeroes `HorizLayer1Setting`, then loads
`Layer1ScrollCmd`/`Layer2ScrollCmd` and `Layer1ScrollBits`/`Layer2ScrollBits` as 16-bit pairs from
`DATA_05C9D1` and `DATA_05C9DB`, indexed by the sprite's bits. `CODE_05BD4C` (`:4633-4653`) zeroes the
speeds and loads each layer's path type and waypoint count from `DATA_05CA61`/`DATA_05CA68`. For $009's
sprite the bits are 0, giving Layer 1 cmd 1 and Layer 2 cmd 1. Measured on the first level frame: cmds 1/1,
bits 1/0, types 24/1, counts 5/22.

**Per frame.** Both layers run the same path follower, `CODE_05C04D` (`:5000-5185`), each on its own state
(index 0 and 4 into the $1442.. block):

- The type indexes a waypoint list (`DATA_05CA6E..`, `DATA_05CABE..`, targets in 16 px units) and a speed
  limit (`DATA_05CB0F`); the waypoints left are the timer. At 0 the X speed is zeroed and the routine
  returns, so the layer freezes (`:5004-5009`).
- The vector to the next waypoint is split between the axes with the CPU divide unit (`HW_WRDIV`,
  `:5092-5105`), speeds ramp one unit per frame (`DATA_05CB5F`, `:5156-5176`), positions advance in 8.8
  fixed point (`CODE_05C4F9`, `:5632-5649`).

Layer 2's command 1 is `CODE_05C198` (`:5186-5195`, dispatch `:4552`): it runs the follower for Layer 2,
then **copies `NextLayer2XPos` into `NextLayer1XPos`** and adds `ScreenShakeYOffset` to Layer 2 Y. Layer 1's
handler runs first and Layer 2's overwrites its X, so the camera's X is Layer 2's path and the camera's Y is
Layer 1's own path. Answer to the owner's question: Layer 2 has its own routine, and the camera follows it
in X. On this map Play cannot move Layer 2 without the camera frame; the frame is the same motion.

**Mario.** `HorizLayer1Setting` is 0 after setup (`:4624`), so the Mario camera code at `bank_00.asm:13658`
is skipped; `VertLayer1Setting` is 0 on a horizontal map. The WRAM cells the per-frame pair reads before
writing (probe, 8,000 frames): $5B/$5C, $9D (SpriteLock), $13D5, $1403, $1411-$1414 (the four layer
settings), $142A/B (camera trigger), the scroll block $143E-$1457, $1462-$1469, $1888/9, $1931. No Mario
cell ($94-$97, $7B, $7D) is among them.

### Capture, $009

Map force-loaded, no input, from the first level frame (game mode $14).

- Idle Mario is pushed off the left of the screen and dies at record ~330, which sets SpriteLock and freezes
  the camera at L1 X 120. The first capture therefore shows 330 frames of motion and then a freeze: the same
  idle-window trap as #114.
- To see the whole path Mario was held (a Lua write of his position each frame, star timer set, death
  animation undone). Run `r009`: 8,000 records, no refusal.
- The path: L1 X 0 to 2810, L1 Y 192 down to 80, L2 X always equal to L1 X, L2 Y between 14 and 210,
  waypoint counts falling from 5 to 0 (L1) and 22 to 0 (L2). The last record where any of the four positions
  changes is 7,785; after it they are constant. At 60.1 frames per second that is about 130 s.
- Mario independence: six runs with Mario held at six different offsets from the camera give identical
  L1/L2 X/Y to `r009` for the whole length of each run until that run's Mario dies (identical prefixes of
  407, 489, 1,081, 1,191, 1,217 and 2,220 frames). The idle run matches `r009` over its first 300 frames.
- Repeatability: a second 8,000-frame run is byte-identical to the first (SHA-256 of the CSV).
- Layer 2 Y swings between waypoints while the camera Y barely moves, so Layer 2 does move relative to
  Layer 1 (#114's observation of $20 changing).

## $1EF: sprite $F5, command $0E

**Setup.** `CODE_05C036` (`bank_05.asm:4990-4997`, dispatch `:4597`) loads two small values from
`DATA_05C808`/`DATA_05C80B` by the sprite's bits, then enters `CODE_05BFD5` (`:4938-4953`) with $0E00:
Layer 1 cmd 0, Layer 2 cmd $0E, `Layer1ScrollType` 0, all speeds zero. `HorizLayer1Setting` is not zeroed, so
the camera keeps tracking Mario (capture: Horiz L1 = 1, Horiz L2 = 1). The Layer 2 dispatch for $0E is
`CODE_05C81C` (`:4565`, `:6034-6068`).

**Per frame.** `CODE_05C81C` loops over rest windows (`DATA_05C7F0` low edge, `DATA_05C7FC` high edge; the
first value is the start offset, the second the loop length). If `NextLayer2XPos` is inside a window it clears
`Layer1ScrollType`, sets `NextLayer2YPos` to the rest height (`DATA_05C80E`) and zeroes the Y speed. It then
ORs `Layer2Touched` ($140E) into `Layer1ScrollType` (`:6060-6062`). If that is nonzero and `NextLayer2YPos`
is not at the floor (`DATA_05C810`), the Y speed steps toward its limit (`DATA_05C814`, `DATA_05C818`) and the
position moves (`CODE_05C4F9`, index 6). For this sprite's bits the rest window is the first 8 px of X and
the floor is 0.

**Who sets `Layer2Touched`.** Mario's interaction code: cleared in `CODE_00EAA6` (`bank_00.asm:11928`),
incremented at `:12581` when the solid under Mario is a Layer 2 tile (`TempScreenMode` bit 7). It needs Mario
standing on Layer 2. `Layer1ScrollType` is a latch (stored back at `:6062`): once touched it stays nonzero
until the camera next enters a rest window, so the sink would continue after Mario steps off. The latch is
read from the ASM only; the captures below force `Layer2Touched` on every frame and cannot show it.

### Capture, $1EF

$1EF is out of reach of the `OverworldOverride` route (low byte $EF is above the $DB limit; the validation
repo's `capture/mesen/README.md`, "Reachability"), so the recorder hooks execution at `CODE_05D8B7`
(`bank_05.asm:7227`) and writes $0E, $0F and $13BF before it runs. That $1EF loaded: cmds 0/$0E, bits 1/0,
counts 6/1, Mario start (16,304) and settings 1/0 equal the probe's load of $1EF.

- Idle, 1,057 frames: L2 Y constant (192), L2 X constant (0), `Layer2Touched` never set.
- Pad held right, 909 frames: L2 X follows L1 X from 0 to 217, L2 Y constant, `Layer2Touched` never set
  (Mario falls instead of landing on Layer 2). No natural touch was reached.
- Pad held right with `Layer2Touched` forced to 1 at `CODE_05C81C`: L2 Y 192, then 191 at X 0 (inside the
  rest window, one step after the snap), then down to 141 as X leaves the window, with the Y speed at its
  limit, until Mario dies and SpriteLock stops the routine.

## Interpreter feasibility (D143, #1136)

The core is `Cpu65816` (`src/rom/cpu/Cpu65816.ts`) over `SpriteBus` (`src/rom/sprites/interp/SpriteBus.ts`);
`callSubroutine` (`src/rom/cpu/call.ts`) runs one routine to its return. `loadLevelState`
(`LevelLoader.ts:307`) runs the ROM's own loader to WRAM, including the sprite sweep that sets the scroll
commands. The bus models the CPU divide unit ($4204-$4206 in, $4214-$4217 out) the follower uses; the
routines write no other hardware register.

**Entry points** (JSL, DB 0, step cap 200,000 per call; observed maximum 888 steps per frame):
`UpdateScreenPosition` at `$00:F6DB`, then `ProcScreenScrollCmds` at `$05:BC00` (values from `SMW_U.sym`; a
build must resolve them from the ROM's own call sites as `LevelLoader.ts` does for the loader, and check the
instruction at each).

**Probe results** (vanilla, one machine, scratchpad script, not committed):

- $009: load, then 8,000 frames of the pair, no seeded Mario input. Against `r009`, the eight position words
  ($1A-$20, $1462-$1468) match on 7,999 of 7,999 compared frames, offset by one frame because the
  recorder's first row is the load state. No refusal, no budget stop. 8,000 frames take 2.4 s with the load.
- $1EF, idle: 1,500 frames, L2 Y 192 throughout, as captured.
- $1EF, `Layer2Touched` forced, the capture's `NextLayer1/2XPos` and SpriteLock fed per frame: L2 Y and
  NextLayer2 Y match on 449 of 449 frames. With only Mario's position and speed fed, the probe's camera X
  parts from the capture after about 125 frames (the capture scrolls 2-3 px per frame where the probe scrolls
  1). The missing camera input is unidentified, so the $1EF camera is not reproduced from Mario's position.
- Sweep, all 512 slots: each loads and runs 1,200 frames with no refusal (below).

**Verdict.** $009: the interpreter runs it from load with no seeded Mario state and no path in source.
$1EF: it runs the Layer 2 routine honestly, but the inputs are Mario's (`Layer2Touched`, and the camera X
that places the rest window). They come from the user (a "stand on Layer 2" switch) or Play must say it
needs Mario; the ROM does not supply them.

**Gaps a build must close.** (a) A hacked ROM may replace or hook either routine; the existing site checks
cover the loader only, so the two entries need "exists and is reached" checks (path and operand, not bytes).
(b) The $009 path is 7,783 frames; a loop restart is a reload of the load state (`loadLevelState` is about
0.2 s, or keep the post-load WRAM and `restore` the bus snapshot). (c) The scroll sprite is found by the
loader's sweep, so a scroll sprite far from the first screens would be loaded only when the camera reached
it; the probe uses what the level loader loads.

## Sweep (what moves with no Mario input, 1,200 frames)

One run, vanilla, 512 slots, `loadLevelState` then the pair, no Mario input; every slot loaded and ran with
no refusal. Slots with a scroll command whose positions changed: $009 (cmds 1/1), $00C (1/0), $0C8 (1/9), $01F,
$1C8, $1D4, $1FC (cmd $0C), $0D4, $115, $1D1, $1E3, $1F3 (cmd $03), $0DC (cmd $0B),
$0E7, $1CE (cmd $08, L2 X only), $1CF (cmd $02). $122 (cmd $0D) changes by one pixel. $01A, $111 (cmd $02)
and $1E2, $1EC, $1EF (cmd $0E) do not move idle; with `Layer2Touched` forced on, $1E2, $1EC and $1EF move
Layer 2 Y. No slot without a scroll command changed any of the four positions in 1,200 idle frames. Not
covered: motion needing a trigger (cmd $02 smash, the $0B switch, Mario on Layer 2), motion after frame
1,200, and a Mario-driven camera. The per-map range columns exist only in the scratch CSV; a committed sweep
is a later step.

## What the reference extension holds

`src/rom/scrollSim.ts` and `src/rom/scroll/*.ts` are a hand port of these routines (not the interpreter),
validated for $009, $00C and $0C8 against older Mesen `l2_scroll.csv` captures
(`test/suite/unit/scrollSim_009.test.ts`, 7,739 frames; the fixture folder is absent here, so it was not
re-run). `MapEditorProvider.ts:457-503` computes the post-setup command pair. `src/webview/mapEditor/main.ts`
draws the camera rectangle (`drawCameraRectOverlay`, `:545`; the parallax strip `compositeCameraViewport`,
`:416`) and a scroll tab with a frame slider and loop button (`:1255-1290`). Nothing in `theia/extension/src`
imports any of it (only compiled `.d.ts` files appear under `theia/extension/lib`). The camera rectangle
there is a user-dragged screen-sized box, not a ROM-driven one.

## Recommendation for Play

Run `UpdateScreenPosition` then `ProcScreenScrollCmds` per frame on a machine seeded by `loadLevelState`,
read the four positions after each frame, and draw the camera frame at ($1A, $1C) and Layer 2 at ($1E, $20)
relative to it. $009 needs no input and ends at frame ~7,783: show the end instead of looping silently, and
restart from the saved load state. For $1EF run the same pair with `Layer2Touched` as a visible user
control, default off (nothing moves), and say so. State needed beyond the loader image: SpriteLock 0.
Unknowns: the $1EF camera X reproduction, a natural Layer 2 touch on $1EF, hack ROMs, and sweep motion past
frame 1,200.

## Play, as built (phase 2)

Code: `src/rom/MapMotion.ts` (the run), `theia/extension/src/node/map-motion.ts` (the reply and the strips),
`theia/extension/src/browser/map-motion-play.ts` and `map-view-widget.tsx` (the view). Same evidence scope as
above; the figures in this section are from the run of the shipped `runMapMotion` on the vanilla ROM,
one machine, 2026-11-07.

**What is drawn.** Layer 1 stays still in the map view, so Layer 2 is drawn at its position against Layer 1:
the offset at a frame is (L1Y - L2Y) at that frame minus the same at the load frame. A positive offset moves
Layer 2 down. Frame 0 is the load state, so its offset is 0 and the picture is the at-rest one: the node side
checks that the at-rest `l2.dy` equals (L1Y - L2Y) at load and refuses otherwise (true for $009 and $1EF).

**Range.** $009: -101 to +66 rows (L1Y spans 112 rows, L2Y spans 196, so the camera and Layer 2 offset each
other in part; the absolute L2Y range alone would suggest the wrong figure). $1EF: 0 to +192. Both lie inside
the 512 px period. Relative X is 0 at every frame of both runs (checked on every frame, not assumed); a run
whose relative X changes is refused ("sideways"), so no horizontal shift exists.

**Compositing.** The view holds each screen's Layer 2 as two 256 x 432 planes baked at the at-rest offset
(`drawL2` in `node/map-screen.ts`, wrapped on BG2's 512 px period, `bank_00.asm:1270-1271`). A shift of up to
about 190 rows needs the 80 rows the screen does not hold, so the reply carries, per screen, the plane rows 432
to 511 drawn by the same code (`drawL2Strip`), and `shiftPlane` takes row r from row (r - shift) mod 512 of
the two joined. Horizontal maps only; a vertical map is refused ("horizontal maps only"). The shifted planes go
through `composeScreen` as the at-rest ones do, so priorities and color math are unchanged.

**Pass 2's stated inputs ($1EF).** When the routine moves nothing on its own, the run is repeated with these
cells set before every frame, and nothing else: `Layer2Touched` ($140E) = 1; `NextLayer1XPos` ($1462) and
`NextLayer2XPos` ($1466) = 256; Mario's X ($94) = 384 (camera X + 128). Mario's X has to move with the camera
because the camera code pulls the camera back to him otherwise. Probe, vanilla, one machine: this constant
camera gives the same sink as the capture's fed camera X on $1EF, 109 of 109 frames aligned at the first row
at or below 185, and the sink reaches its floor (0). The sink values come only from the ROM; the forced cells
are inputs, not a path. The camera frame is not shown for this kind (the forced camera is not the routine's).

**Run size and stall.** $009: 7,785 frames, 151 KB of JSON for the four position lists and the offsets, about
1 s on the backend thread for the whole run (load, pass 1), measured on the shipped function in node, one
machine. $1EF: 448 frames, 8.6 KB, 49 ms. A map with no routine: 17 ms. The reply is kept per working-copy
bytes, so it is paid once per edit. The 1 s is on the RPC thread; chunking was not needed.

**Entry checks.** `motionEntries` reads the JSL operands at the two call sites inside `CODE_00A28A`
(`bank_00.asm:4505-4506`) and requires each callee to open with PHB; a failed check is a refusal
("unrecognized-code") with the site named. No byte run is stored.

**Sweep.** `MapMotion.test.ts` runs every slot (no ROM, no run): every slot ends `ok`, `none`, or refused
with `no-motion` or `sideways`; none is refused by the loader, the entries or the interpreter. The switch,
trigger and timer maps land on `no-motion` or play as `needs-mario`.

**Cross-check against `scrollSim.ts`.** Not done: the hand port's fixtures (`MESEN_FIXTURES_DIR`) are absent
here, and the interpreter run already matches the Mesen capture frame for frame.
