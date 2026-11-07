Proposed 2026-11-07 (lima, #1242)

# Play on the map toolbar: the calls taken in #1242

## Question

#1242 asks for a play button that runs a map's own Layer 2 movement routine and loops it. Its brief took four calls as [PROP], and building it took three more that no ruling covers.

1. Does Play show what the routine moves: the camera frame if it moves the camera, only Layer 2 if not, the map staying still?
2. Where does the loop restart, when the routine does not repeat by itself?
3. Where does the button sit and what does it look like?
4. Do the Layer 2 and camera runs go on the interpreter (D143)?
5. For a routine that waits for Mario (a touch-driven sink, $1EF), what does Play do?
6. What does Play do on a vertical map, or when Layer 2 moves sideways against the screen?
7. What does Play do on a map whose motion depends on where Mario is?

D143 is cited in the issue as the interpreter ruling. Its record was not found in `docs/decisions/`; it appears only as a one-line report in the team registry (`.overwatch/team-registry.md`, 08:40Z entry: "whole-map simulation engine (#1094, #1116 simulate, #192, #1133) = the interpreter"). D148 B, in the same registry, dropped map-editor simulation (cursor-as-Mario and the like) and kept playing as the emulator panel at the map entrance. This run is neither: it steps two screen routines, with Mario as no input but the stated ones.

`.claude/rules/rom-interpretation.md`, third bounded use, ends: "Do not extend it to other routines without a decision of the same kind." Running `UpdateScreenPosition` and `ProcScreenScrollCmds` on the core is a routine beyond the sprite, block-spawn and collision uses, so this file asks for that decision (call 4).

## Options considered

1. (a) Show what the routine moves. (b) Always move the camera frame. (c) Always keep the map still and move Layer 2 only.
2. (a) The map's load state, as a loop of the whole frame list. (b) Where the routine settled, held. (c) Never restart; play once.
3. (a) A play/stop button on the existing map toolbar, in its style, after the collision toggle. (b) A new transport bar. (c) A panel.
4. (a) Run the ROM's two per-frame routines on the interpreter from the level loader's image, with step budgets, byte-checked call sites and a refusal with a reason. (b) A hand port of the routines (the reference extension's `scrollSim.ts`). (c) No Play.
5. (a) Run it with the Mario inputs it reads stated and fixed (Layer2Touched = 1, the camera a screen in with Mario 128 px into it), say so in the tooltip ("Shown as if Mario is standing on Layer 2."), and give no control for the inputs. (b) A toggle for "Mario on Layer 2". (c) Refuse.
6. (a) Refuse both in plain words and move nothing. (b) Build horizontal shift tonight. (c) Draw anyway.
7. (a) Refuse in plain words ("depends on where Mario is"). (b) Play the idle run. (c) Offer a Mario position control.

## Ruling

wording not recorded. All seven were taken as [PROP] by the implementer on Overwatch's word, 2026-11-06 and 2026-11-07, and are not ruled.

1. Option a. The camera frame is shown only for a run that moved the camera by itself ($009); Layer 1 stays still in the map view and Layer 2 is drawn at its position against Layer 1.
2. Option a. The result is the whole frame list; Play loops it from frame 0, the load state. A run ends when the positions have not changed for 180 frames, or at 20,000 frames.
3. Option a. Button `data-control="map-play"`, `hb-icon-btn`, play and stop codicons, after the collision toggle; disabled with the reason in the tooltip when the run is refused; absent when the map has no scroll routine.
4. Option a, pending this file. Entry call sites are the two JSLs inside `CODE_00A28A` (`bank_00.asm:4505-4506`), byte-checked with their destinations; nothing is hardcoded about paths or tables. Evidence: $009 matches a Mesen capture on 7,999 of 7,999 frames; one machine.
5. Option a. The inputs are stated in `docs/rom/map-layer2-motion.md` and in the tooltip; a camera-only run must move nothing, else call 7.
6. Option a. No horizontal shift is built; a vertical map or a run whose relative X changes refuses.
7. Option a. The run is repeated with Mario's X and Y moved; any difference in the four positions refuses. In vanilla that refuses 11 of the 22 slots with a scroll command ($01A, $0D4, $0DC, $111, $115, $122, $1CE, $1CF, $1D1, $1E3, $1F3), including 6 that loop on their own because the camera tracks Mario.

## Why

1. The map view keeps Layer 1 still, so what Play can honestly show is Layer 2 against Layer 1 and, where the routine moves it, the camera.
2. The routine does not repeat on its own ($009 ends at its last waypoint), so a loop must start from the load state to be the same show twice.
3. The owner asked for the existing map toolbar's look; no mockup tonight.
4. The routine's values must come from the ROM; a hand port is the modelling the rules rule out, and the interpreter already runs the level loader.
5. The sink is the ROM's; only the touch and the camera are not, and they are shown as stated, never as a path.
6. The strip and the shift are built for rows only; guessing beyond that would draw confidently wrong.
7. A loop that strobes at 20 Hz because the idle Mario sits still is not the map's motion.

## Applies to

docs/rom/map-layer2-motion.md, `src/rom/MapMotion.ts`, the map view's Play (#1242). Calls 5 to 7 and call 4 are the ones to rule first.
