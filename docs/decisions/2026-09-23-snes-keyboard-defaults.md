Ruled 2026-09-23 (Brian)

## Question

What are the default SNES keyboard bindings in the emulator view?

## Options considered

The most common emulator layout (ZSNES, RetroArch, BizHawk); Select was a 2-2 tie between RShift and Space.

## Ruling

Owner decision 2026-09-23, wording not recorded. D-pad arrows; B=Z, A=X, Y=A, X=S; L=Q, R=W; Start=Enter; Select=RShift and Space. More than one key per button is allowed (button to list of keys). A rebinding UI is required; defaults are the reset state. `[INF]`

## Why

- Matches muscle memory; Q/W is the only shoulder pair used by more than one emulator; Select tied so both keys are bound. `[EST]`

## Applies to

- HackBench's own shortcuts stay off Tab, F1-F4 and Esc while the game view has focus (rule in `ui-conventions.md`).
- Defaults shipped in `theia/extension/src/browser/emulator-input.ts` (Space as second Select plus per-key HeldButtons, PR #474, 2026-09-23). `[EST]`
- Rebinding UI not built as of 2026-09-23; check `emulator-input.ts` and the controller session code (#433, gamepads merged). `[OPEN]`
- The research survey stays in the owner's notes repository, not in `docs/`. The rebinding-UI feature PR carries only what the code needs: the defaults and the Tab/F1-F4/Esc rule in `ui-conventions.md`.
