Proposed 2026-11-11 (papa-1011)

# When the sprite loader cannot be read, a sprite with extra bit 2 or 3 is boxed

Queued for the owner as D204.

## Question

When the app cannot read a ROM's sprite loader routing (the `LoadClass` table is `unavailable`), what does it do with a list sprite whose extra bit 2 or 3 is set, goal tapes included? CodeRabbit threads 4505953790 and 4505953787 on PR #1273 (issue #1011) showed the bit-2 gate drew such a sprite with vanilla art while the bit-3 gate boxed it.

## Options considered

1. (A) Box it with its own reason, `loaderUnreadable`, whose words say the app could not read the loader. Never vanilla art, never hidden. Cost: on a hack whose loader is refused, every extra-bit sprite is a box with no picture, even where the vanilla art would have been right (see Why for the counts). Nothing is shown that could be wrong.
2. (B) Run this ROM's code for the sprite anyway and mark it unverified with the reason `loaderUnreadable`. Benefit: the picture comes from this ROM, so it is not a vanilla fallback, and `.claude/rules/rom-interpretation.md:106-109` ("Viewers draw; they do not blank") favors it. Cost: the code that runs is the code the loader may have re-routed, so the picture may be of the wrong sprite; the unverified note must carry that, and the box that bit 3 already gives would then disagree with bit 2 unless it changes too.
3. (C) Hide it. Rejected: a placed sprite vanishing from the map is the worst case for an editor.
4. (D) Keep drawing a bit-2-only sprite as vanilla when the loader is unreadable (the pre-fix behavior). Rejected: it is the confident-but-unchecked output the ROM rules forbid.

## Ruling

wording not recorded. Option A was taken as [PROP] by papa-1011 and accepted by Overwatch for night shift, 2026-11-11, and is not ruled; owner ruling pending. [INF]

When the loader cannot be read, a sprite with extra bit 2 or 3 is boxed with the reason `loaderUnreadable`, goal tapes included. It is never drawn with vanilla art and never hidden. A caller that supplies no routing at all (it never routes) is not an unreadable loader and is unchanged. The frames gate gives the same reason, and the frames fallback that looks for a parent routes as the map does.

## Why

The ROM rule is to say why when a table cannot be read, and not to emit vanilla-shaped output for a patched ROM (`.claude/rules/rom-interpretation.md`, "The one case where table-reading is not enough"). `docs/decisions/2026-10-15-interpret-else-warn.md` backs warning or erroring on unreadable data, which A does with its own reason; it does not by itself say "fail closed", and option B also warns. With bit 2 set the loader may re-route an id, and nothing says it was not checked.

Cost, measured by counting list entries of all 512 slot pointers (parse only, nothing rendered; one machine, 2026-11-11). Each count is over slots, so a list shared by several slots counts once per slot; the unique-list count (the same entries, each shared list once) is given after "unique", from the reviewer's recount, not mine:

- Kaizo Kindergarten v1.09: 8 entries with bit 2 alone newly boxed, 3 of them goal tapes; unique 7 and 2.
- Seven_Vanilla_Levels: 10 entries with bit 2 alone newly boxed, 5 of them goal tapes; unique 9 and 4.
- Their entries with bit 3 (26 and 4) were already boxed and only change reason.
- Seven_Vanilla_Levels' bit-2 counts equal vanilla's (10 entries, 5 goal tapes), so its new boxes are likely vanilla placements that the loader would route unchanged, which is the case A cannot tell apart from a real re-route.
- Both loaders are refused on the current build (Kaizo: the call goes elsewhere; Seven_Vanilla_Levels: the run for id $00 never reads the list entry), so on those two hacks every extra-bit sprite is a box.

## Applies to

`theia/extension/src/node/map-sprites.ts` (`extraBitsBlock`, `framesGate`, `drawnByParent`), `theia/extension/src/browser/sprite-props.ts`, `docs/rom/map-data-mechanics.md`.
