Proposed 2026-11-03 (Overwatch, #842) D159

# A hook in GM12PrepLevel before the $0D9B test is not checked

D159, `[PROP]`, for Brian to confirm or course-correct after the merge of #1050.

## Question

The level loader reads IRQNMICommand ($0D9B) bit 7 after the level data loader and uses it to run or skip the Layer 3 reset and handler. The game reads it later, at `LDA IRQNMICommand` in GM12PrepLevel (SMWDisX bank_00.asm:4861), after `ClearOutLayer3`, `NoButtons`, `STZ UploadMarioStart`, `SetUpScreen`, `UploadStaticBar` and `JSL CODE_05809E` (bank_00.asm:4855-4860). A hack that hooks that window with code that writes $0D9B would make the game and the loader disagree. CodeRabbit raised it on #1050 (finding at LevelLoader.ts:406). What does the loader do?

## Options considered

1. Do nothing for this window: no site checks, no warning. Vanilla and every store hack in the corpus agree. `[PROP]` (proposed, not ruled)
2. Add single-instruction sites for the window and refuse the load when it is not vanilla-shaped. It newly refuses 9 of the 22 store hacks the loader accepts today, which then lose their level state.
3. Warn and still load: a hook in the window is reported as unverified on the map view and the sprite report, and the load goes ahead. It needs a warn path the loader does not have; proposed as a follow-up for Planning to file if the owner agrees.
4. Follow or run the hook. Out of scope for #1050 (a scope change, #1182).

## Ruling

Pending the owner's ruling. Nothing is decided. Overwatch proposes option 1 for #1050 (no code change meanwhile) and option 3 as a follow-up. `[PROP]`

## Why

- In vanilla, nothing between the level data loader and the test writes $0D9B. The only write sites are `CODE_0584E3` (the header loader, which the loader runs), `CODE_0093EA`, `GM04PrepTitleScreen` and `CODE_00A11B`. `[EST]`
- Of the 22 store hacks the loader accepts, 13 equal vanilla in all 20 bytes at $00:A59C-$A5AF. The other 9 replace the `STZ` at $00:A5A2 with a `JML` into one hook body (a `STZ`, one `JSR` to a straight-line run of PPU register stores ending in `RTS`, then `JML $00:A5A8`). That body has no $0D9B write, absolute or long. So 0 of the 22 can differ from what the loader read. `[EST]`
- Tension with D57 (interpret or warn): a future hook in this window that does write $0D9B would run with neither interpretation nor a warning. Option 3 would close that; it is not rejected.
- Evidence scope: a static read of those hacks' bytes, one machine, 2026-11-03. Not captured on hardware or in an emulator, and the hook was followed one level deep (no indirect jumps or data pointers were met).

## Applies to

`src/rom/sprites/interp/LevelLoader.ts` (the $0D9B gate before the Layer 3 steps) and the follow-up warn path (`SpriteSeed`, `SpriteRunner`, `map-sprites.ts`).
