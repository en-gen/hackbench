# Map facts in the Properties panel

Design for how the map view presents a map's facts, decoded header and warnings. Issue #1009.

## Ruling

- D80 call 2, owner, 2026-10-17: "remove both 1 and 2 / this isn't how I'd want to present this information. file an issue to design this screen for presentation of this information". #1008 removed the facts strip and the folded Header panel. `[EST]`
- D111, owner, 2026-10-17: picked Option A from a three-option mockup round (A: Properties side panel, B: hover card, C: notes bar with a settings tab). `[EST]`
- The mockup is the design of record: https://claude.ai/artifact/GoZ2RRUnDGq4uBkwem6RuE (private to the owner; not copied into the repository). Every value on it is a made-up example.
- The five calls under "Provisional calls" are Proposed, not ruled. `[PROP]`

## The design

The map's information lives in the Properties side panel, a Theia view with a title bar, collapse and close buttons, reopened from View > Properties. It is the same view the sprite properties pane (#984) uses, so there is one panel, not two.

With nothing selected the panel describes the map:

1. **Name and slot** at the top, as the old title did.
2. **Notes**, in two groups: "This map" and "This ROM". Each note is a row with a warning icon, a plain title and a one-line reason.
3. **Overview**: Size (screens and orientation), Objects, Sprites, Start.
4. **Look**: Tile graphics, Sprite graphics, Background color, Foreground palette, Background palette, Sprite palette. Colors and palettes show swatches.
5. **Sound and time**: Music, Time limit.
6. **Behaviour**: Layout, Vertical scroll, Collected items remembered, Layer 3 in front of sprites.
7. **Entrance and scrolling (later)**: greyed, closed, no controls. It marks the room the old editor's Scroll tab needs.
8. **Header bytes**: collapsed. A "Show header bytes" link reveals the raw bytes. Nothing in the panel shows hex until it is clicked.

With a sprite selected, the panel shows that sprite. A one-line notes summary sits above the sprite breadcrumb so warnings stay in view, and Back returns to the map description.

Cost: the panel takes a column of width from the map while open. The map name and counts live in the panel and the tab only, not the status bar.

## Warnings

- One warning count sits in the status bar. It counts every active note; a ROM note counts once however many maps share it.
- Clicking it opens Problems. Problems groups ROM notes under "This ROM" and map notes under the map.
- Picking a note opens the Properties panel if it is closed or collapsed, expands the section, and flashes the row. For undrawn objects it flashes the red ! marks on the map instead.
- Closing the panel keeps the count. The warnings do not depend on the panel being open.

## Where each piece of old information goes

The old facts strip is `renderFacts` and the Header panel is `renderDecode` in `theia/extension/src/browser/map-view-widget.tsx`. The 13 header fields come from the `header` list in `theia/extension/src/node/map-details.ts`. The label column is what the user sees.

| Old piece | New home | Label |
| --- | --- | --- |
| Title (slot and name) | Panel top, and the map tab | Slot and name |
| Screens | Overview, Size | Size ("12 screens, horizontal") |
| Orientation | Overview, Size | Size |
| Object count | Overview | Objects |
| Sprite count | Overview | Sprites |
| Start | Overview, with a Notes entry when unavailable | Start |
| GFX note | Notes, This ROM; warning icon on both graphics rows | Graphics may not match the game |
| Header: Screens | Overview, Size | Size |
| Header: Level mode | Behaviour | Layout |
| Header: Object tileset | Look | Tile graphics |
| Header: Sprite tileset | Look | Sprite graphics |
| Header: FG palette | Look, with swatches | Foreground palette |
| Header: BG palette | Look, with swatches | Background palette |
| Header: Sprite palette | Look, with swatches | Sprite palette |
| Header: Back area color | Look, with a swatch | Background color |
| Header: Music | Sound and time | Music |
| Header: Time limit | Sound and time | Time limit |
| Header: Item memory | Behaviour | Collected items remembered |
| Header: Vertical scroll | Behaviour | Vertical scroll |
| Header: Layer 3 priority | Behaviour | Layer 3 in front of sprites |
| Header: raw bytes | Header bytes, collapsed | Show header bytes |

Every value reads in words first (for example "Underground", "Palette 3", "No"). Hex appears only behind Show header bytes.

## Where today's notes go

Rule: notes about how the map is drawn stay as lines above the map and are also listed. Nothing is left only in a tooltip or hover. Whole-ROM notes are shown once. Facts that cannot be read show "Can't be read" with a warning icon and the reason in their row.

| Note | Today | Option A (chosen) |
| --- | --- | --- |
| Start position can't be shown or read | Plain text "start unavailable" at the end of the facts line; reason only in a tooltip; no icon | Notes list (This ROM, or This map if it failed just now) and a warning on the Start row |
| Graphics may not match the game | A full sentence in a red note line under the facts line | Notes list (This ROM) and a warning beside the graphics rows |
| Sprite layering not checked for this kind of map | Toolbar warning: icon plus "Level mode NN: sprite layering not verified", reason in a tooltip | Stays as the toolbar warning, and is also listed under This map |
| Objects couldn't be drawn | Red dashed cells marked !, reason in each cell's tooltip; no text line | Marks stay (always shown); also in the notes list; picking the note flashes them |
| Layer drawing notes (background not drawn, positions unverified, layer order) | A note line above the map | Stays as a line above the map, and is also listed in Notes and Problems |
| Sprite notes (sprite list has no end, castle flames not drawn) | A note line above the map | Stays as a line above the map, and is also listed in Notes and Problems |
| Block contents not drawn | A note line above the map | Stays as a line above the map, and is also listed in Notes and Problems |
| General map note (unverified drawing, layer 2, animation) | A note line above the map | Stays as a line above the map, and is also listed in Notes and Problems |
| Part of the map couldn't be drawn | Red note line above the map, detail in a tooltip | Stays as a line above the map, and is also listed in Notes and Problems |
| Facts that couldn't be read (name, orientation, objects, sprites, map data) | "... unavailable" in the facts line, reason in a tooltip | That Properties row reads "Can't be read" with a warning icon and the reason as its detail |
| The map couldn't load | Red error text in place of the facts line | Error text in the map area (no facts to show), also in Problems |

A missing base ROM is a project problem, not a map note, so it is in none of these rows.

## From the old editor

What the original editor's right panel did (reference extension, `src/webview/`), and what Option A keeps.

| Old panel feature | Keep or drop | Where it lands |
| --- | --- | --- |
| Inspector on click | Keep | Becomes the Properties view; clicking a sprite shows the sprite |
| General, Layer 2, Layer 3 and Scroll tabs | Keep as sections, not tabs | Look, Behaviour, and the greyed "Entrance and scrolling (later)" section |
| Music play and preview buttons | Keep, later | Next to Music, playing in the panel |
| Gear settings button | Keep | The Properties view itself is the settings home |
| Editable selects | Keep, later | Dropdowns in Look and Sound |

## Grows into editing

Rows become controls in place. Each Look and Sound value becomes a dropdown in the same row (#20, #116), Music gets a play button, and "Entrance and scrolling" opens up. No new screen is needed. Read-only rows stay read-only until their editing issue lands.

## Provisional calls

Five calls the mockup implied. Each is a Proposed file in `docs/decisions/`, owner review pending. `[PROP]`

1. Whole-ROM notes are shown once under "This ROM" and never mark each map: `2026-10-17-map-notes-rom-scope.md`.
2. Notes about how the map is drawn stay as lines above the map and are also listed: `2026-10-17-map-draw-notes-stay-above-map.md`.
3. A missing base ROM is a project problem, not a map note: `2026-10-17-missing-base-rom-is-a-project-problem.md`.
4. Plain labels (Layout, Collected items remembered, Tile graphics): `2026-10-17-map-facts-plain-labels.md`.
5. The graphics note keeps the "Lunar Magic" wording: `2026-10-17-graphics-note-names-lunar-magic.md`.

## Acceptance for the build issue

Assertions, for Planning to file. Each runs in Playwright against the Theia browser build.

1. With the start-position note active, the Properties Notes section lists "Start position can't be shown" under This ROM, and the Start row shows a warning icon.
2. With the start position failing to read just now, the same note appears under This map, and the Start row reads "Can't be shown right now".
3. With the graphics-assignment note active, Notes lists "Graphics may not match the game" under This ROM, and Tile graphics and Sprite graphics each show a warning icon.
4. With sprite layering unchecked, the toolbar warning stays and Notes lists it under This map.
5. With two undrawn objects, the map shows two ! marks, Notes lists "2 objects couldn't be drawn", and picking that note flashes the marks.
6. For each of the layer, sprite, block, general and part-of-map notes: the line above the map is still present and the same text is listed in Notes and Problems.
7. With the object count unreadable, the Objects row reads "Can't be read" with a warning icon, and its reason is visible in the row without hovering.
8. When the map fails to load, the map area shows the error and Problems lists it.
9. The status bar count equals the number of active notes, with a ROM note counted once across two open maps sharing it.
10. Clicking the count opens Problems; Problems groups ROM notes under "This ROM" and map notes under the map.
11. Picking a note with the panel closed opens the panel; with the section collapsed, expands it; the target row gets the flash.
12. Header bytes are hidden by default; no element in the panel shows hex before Show header bytes is clicked; clicking it reveals the bytes for the open map.
13. Each of the 13 header fields appears once, under its label from the table above, with a value in words.
14. Closing the panel keeps the status bar count; View > Properties reopens it on the same map.
15. Selecting a sprite shows a one-line notes summary above the sprite breadcrumb when notes are active, and Back returns to the map description.
16. A missing base ROM shows as a project problem and adds nothing to the map note count.
