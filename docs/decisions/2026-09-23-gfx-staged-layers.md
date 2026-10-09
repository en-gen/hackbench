Ruled 2026-09-23 (Brian)

## Question

Is a GFX pixel edit a layer in the same stack as palette and Map16 edits, and when does it commit?

## Options considered

Immediate commit per pixel; one layer per editing session; staged per 8x8 character.

## Ruling

Owner ruling 2026-09-23, wording not recorded. Staged per 8x8 character, committed on Save or on moving to another character. `[INF]`

## Why

- A character is the unit the system already cites (a Map16 quadrant names "character N"; the gfx preview shows the 8x8 tile). `[EST]`
- Stack readability: "Edited GFX16 tile $2A" is recognisable 40 edits later; 300 single-pixel layers are not. `[EST]`
- Per-pixel layers make the scope line meaningless, each reporting the same whole-arena shift. `[EST]`
- Re-encode cost is the fold's problem: the LC_LZ2 arena re-encodes per file, and consecutive gfx layers on one file fold into one pass. `[EST]`

## Applies to

- Immediate kinds: palette, map16 (commit on change). Staged kind: gfx (commit on Save). `[EST]`
- A staged editor needs a dirty indicator and a prompt or auto-commit on close. `[PROP]`
- The scratch buffer is never a layer. Undo inside a character is editor-local; after commit, Ctrl+Z pops the whole character. `[EST]`
- See `architecture/project-format.md` and `layer-previews.md`.
