Proposed 2026-11-11 (papa-1011)

# When the sprite loader cannot be read, a sprite with extra bit 2 or 3 is boxed

## Question

When the app cannot read a ROM's sprite loader routing (the `LoadClass` table is `unavailable`), what does it do with a list sprite whose extra bit 2 or 3 is set, goal tapes included? CodeRabbit threads 4505953790 and 4505953787 on PR #1273 (issue #1011) showed the bit-2 gate drew such a sprite with vanilla art while the bit-3 gate boxed it.

## Options considered

1. (A) Box it with its own reason, `loaderUnreadable`, whose words say the app could not read the loader. Never vanilla art, never hidden.
2. (B) Keep drawing a bit-2-only sprite as vanilla when the loader is unreadable (the old behavior), and say so in the doc comment.
3. (C) Hide it.

## Ruling

wording not recorded. Option A was taken as [PROP] by papa-1011 and accepted by Overwatch for night shift, 2026-11-11, and is not ruled; owner ruling pending.

When the loader cannot be read, a sprite with extra bit 2 or 3 is boxed with the reason `loaderUnreadable`, goal tapes included. It is never drawn with vanilla art and never hidden. A caller that supplies no routing at all (it never routes) is not an unreadable loader and is unchanged. The frames gate gives the same reason, and the frames fallback that looks for a parent routes as the map does.

## Why

The ROM rule is to fail closed when the routine that reads a table cannot be shown to be the one the ROM uses, and to say why (`.claude/rules/rom-interpretation.md`; `docs/decisions/2026-10-15-interpret-else-warn.md`). With bit 2 set the loader may re-route an id, and nothing says it was not checked.

Cost, measured by counting list entries of all 512 slot pointers (parse only, nothing rendered; one machine, 2026-11-11): Kaizo Kindergarten v1.09 has 8 entries with bit 2 alone (3 of them goal tapes) newly boxed, and Seven_Vanilla_Levels has 10 (5 goal tapes). Their 26 and 4 entries with bit 3 were already boxed and only change reason. Both loaders are refused on the current build (the call goes elsewhere; the run for id $00 never reads the list entry), so on those two hacks every extra-bit sprite is a box.

## Applies to

`theia/extension/src/node/map-sprites.ts` (`extraBitsBlock`, `framesGate`, `drawnByParent`), `theia/extension/src/browser/sprite-props.ts`, `docs/rom/map-data-mechanics.md`.
