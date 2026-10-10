Ruled 2026-10-10 (Brian)

# Map editor scope: choose backgrounds, never edit them live

## Question

What does the map editor edit, and where do backgrounds get edited? (#851, owner decision D48.)

## Options considered

1. Edit backgrounds live inside the map editor. Not chosen: the owner ruled it out (below).
2. The map editor picks a background and places things over it; backgrounds are edited elsewhere (the GFX editor, or a separate editor added later). Chosen by the owner's ruling.

## Ruling

Two rulings, 2026-10-10, verbatim from Brian during D48:

> "You pick a background. Backgrounds would be edited either by editing gfx or we'd add a separate editor. Map editor is for choosing a background, background color, sprite and foreground tile placement"

> "There will be no live editing of backgrounds in the map editor"

## Why

The owner's words above are the only recorded reason. Backgrounds already have a home in the GFX editor, or in a separate editor if one is added; the map editor stays a chooser and a placement tool.

## Applies to

The map editor: choosing a background, background colour, sprite placement and foreground tile placement are in scope; live background editing is not. Header choices such as background colour, BG palette and the layer 3 routine (#20, #116) are choices, so the ruling allows them. Background image import (#39) belongs to the GFX editor, one of the routes the ruling names. The overworld editor (#43, #51) is not the map editor and is not covered. Checked against open issues at filing (#851): none plans background editing inside the map editor.

`[OPEN]` Not covered: whether a map whose layer 2 is an object stream counts as background or foreground for editing. The parallax spike (`docs/spikes/2026-10-10-parallax-map-view.md`, PR #850, #848) counts 26 vanilla maps with a layer 2 object stream, 14 of them interactive (`VerticalTable` bit 7, SMWDisX `bank_00.asm:11736-11738`). Those counts are the spike's vanilla-ROM survey, `[INF]` from its stated structure; this record did not re-measure them and does not know the spike's ROM or machine scope beyond that. The owner has not ruled on it; Decisions is putting it to the owner separately. Nothing here changes those maps.
