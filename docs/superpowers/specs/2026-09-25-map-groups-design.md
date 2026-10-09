# Map groups: virtual folders in the map explorer

## Goal

Let a user organize the map explorer by logical area ("Star World", "Donut
Plains") with named virtual folders. On an unmodified SMW ROM, HackBench
seeds the stock areas as groups. On any other ROM there are no groups until
the user makes them.

Groups are organization only. They never touch ROM bytes, never become a
patch layer, and never appear in an exported `.ips`.

## Terms

Map, entry map and sub area are used as defined in `docs/glossary.md`.
A **group** is a named, user-owned virtual folder holding one or more maps
by slot.

## Behavior

### Tree shape

- Group folders sit at the root, after the special rows and before
  Unassigned, sorted by name. The sort is natural/numeric
  (`localeCompare` with `{ numeric: true }`), so a user's own "10. ..."
  sorts after "9. ...", not before it as a plain string sort would.
- There is no separate Overworld folder. Every top-level map not in a user
  group, entry map (a launch tile's own map) and orphan (unreached from the
  overworld) alike, is Unassigned, sorted by slot. Groups hold top-level
  maps of either kind. A grouped map moves out of Unassigned into its group
  and takes its sub-area subtree with it; the map's own entry/orphan marking
  travels with it and is unaffected by which folder holds it.
- A map belongs to at most one group. Adding it to a second group moves it.
  Labels that can overlap ("need review" across several areas) are tags,
  which are a separate, later feature. Groups are not bent to cover them.
- Sub areas always travel with their entry map and are never grouped on
  their own. **Add to Group** is disabled when the selection contains a sub
  area, and a dragged sub area is refused.
- An orphan map (the tree's existing `orphan` category: not reached from the
  overworld) keeps that marking inside a group. Its row is dimmed and
  italic, with the tooltip "Not reached from the overworld". Reachability
  belongs to the map, so it is shown on the row, not by extra subfolders.
- An empty group still shows, as an empty folder.
- Groups are not nested in v1.
- Every folder's `(N)` counts rows actually listed under it right now:
  `Unassigned (N)` is every entry map and orphan still there, and a user
  group's `(N)` is its own map count. A map that moves into a group stops
  counting toward Unassigned's number. This is simpler than, and replaces,
  an earlier draft that had a separate Overworld folder counting launch-tile
  entrances instead of rows shown.

### Multi-select

The explorer switches to Theia multi-select: Ctrl+click toggles a row,
Shift+click selects a range. A single click still opens a preview, and a
double-click still pins it. A multi-row selection opens nothing.

### Context menu

On a selection of one or more groupable maps:

- **Add to Group...** opens a QuickPick listing existing groups, then
  **New Group...**. Picking an existing group adds the selection to it.
  New Group prompts for a name, creates the group and adds the selection.
  One command and one QuickPick, not a dynamic submenu: a submenu that is
  rebuilt every time the group list changes is more moving parts than the
  feature needs.
- **Remove from Group** is shown when any selected map is in a group. It
  returns those maps to Unassigned, their structural parent.

On a group folder:

- **Rename Group...**
- **Delete Group** returns its maps to Unassigned. Nothing else is deleted,
  so it needs no confirmation.

Group names are trimmed, must not be empty, and must be unique ignoring
case. The name prompt reports a clash rather than silently merging.

### Drag and drop

- Dragging one map or a multi-selection onto a group folder adds all of
  them to that group, the same as Add to Group, provided every dragged
  node is groupable.
- Dropping grouped maps onto Unassigned removes them from their group:
  Unassigned is every grouped map's structural parent, entry map or orphan
  alike, so this needs no per-map "is this its own parent" check. Anywhere
  else the drop is refused.
- `dragover` sets `dropEffect` to `'move'` when the drop is valid by the
  rules above and `'none'` when it is not, so the cursor tells the truth
  before the user releases. Theia's shell cancels every `dragover` on the
  page to accept file drops, so `dropEffect` is the only refusal signal.
- If the drag contains a sub area, a loop/truncated row or a special map
  (Title Screen, New Game), the WHOLE drag is refused, not filtered down
  to the groupable rows in the selection.

### Vanilla seeding

- A project is vanilla when its manifest `baseRom.sha256` equals
  `0838e531fe22c077528febe14cb3ff7c492f1f5fa8de354192bdff7137c27f5b`.
  That is the sha256 of the cart with the copier header stripped, as
  `romIdentity()` computes it. It was measured on both stock ROMs in the
  6-ROM corpus: `Super Mario World (USA).vanilla.sfc` (headerless) and
  `.magic.sfc` (copier header) give the same hash.
- The title check (`SmwRom.isVanilla`, `internalName.startsWith('SUPER
  MARIOWORLD')`) is NOT enough. Hacks keep the stock title. Only an exact
  hash match seeds groups.
- Seeding happens once, when a vanilla project is loaded and has no
  `meta/groups.json`. From then on the groups belong to the user: deleting
  every group leaves the file holding `[]`, and that is not re-seeded.
- The seed is a table of group name to slots. It is legitimate hardcoded
  content, because it is gated on an exact ROM identity and never applies
  to any other ROM. The owner chose the groups. The slots were read from
  the vanilla ROM's overworld name table (see Map names below), not taken
  from a published list: of 77 slot numbers in the list the owner started
  from, 52 named a different map than the ROM does.

  Names carry their area number, so a plain (but locale-numeric) sort by
  name lands them in world order rather than alphabetical order.

  | Group | Slots |
  |---|---|
  | 1. Yoshi's Island | 104 105 106 103 102 101 014 |
  | 2. Donut Plains | 015 009 005 006 007 00A 10B 004 013 003 008 |
  | 3. Vanilla Dome | 11A 118 10A 119 11C 109 001 002 107 00B 11B |
  | 4. Twin Bridges | 00F 010 00C 00D 011 00E |
  | 5. Forest of Illusion | 11E 120 123 11F 020 11D 122 01F 121 |
  | 6. Chocolate Island | 022 024 023 01D 01C 01A 021 01B 117 |
  | 7. Valley of Bowser | 116 115 113 10F 110 114 111 10D 10E 018 |
  | 8. Star World | 134 130 132 135 136 |
  | 9. Special Zone | 12A 12B 12C 12D 128 127 126 125 |

  Left ungrouped: the 13 slots named STAR ROAD (012 016 01E 108 10C 124
  129 12E 12F 131 133 137 138), and 017 and 019, which hold a leftover name
  and have no overworld tile in the stock game (to be confirmed by the
  corpus test).
- The corpus test checks every seeded slot is an entry map in the vanilla
  tree, and that the ROM's name for it matches the group it is in.

## Map names

Entry maps already show their name from the ROM's overworld name table
(`src/rom/SmwLevelNames.ts`, carried on `MapNode.name`). This issue does not
change that. Hardening the decoder (a gate on its reading routine, the font,
picture tiles) is #553. A UI for renaming maps with aliases is a separate
follow-up.

## Persistence

- Groups are stored in `meta/groups.json` through the `ProjectMeta` module
  from #552, which this issue depends on. The file holds
  `{ name: string; slots: number[] }[]`. The `.hbproj` is not touched.
- Array order is not meaningful, because the tree sorts by name.
- Slots that no longer name a groupable map are skipped when the tree is
  built, and kept in the file. A later edit could make them groupable again.
  The frontend edits the file's own list (`loadMaps`'s `rawGroups`), never a
  list rebuilt from the resolved tree, so a stale slot is not silently
  dropped the next time the user adds or removes something else.
- Writes validate the whole list before writing it. The checks are unique
  names, non-empty names, slots in range and no slot in two groups
  (`validateGroups`, no ROM access), plus a slot must currently name a
  top-level map UNLESS it was already on disk (a stale slot from a ROM swap
  survives an unrelated edit instead of blocking it). That admission decision
  is `admitGroups(next, previous, topLevel)`, a pure function taking the
  OUTCOME of reading the file (never the read itself), so it is unit tested
  with synthetic fixtures and no ROM. The file stays hand-editable, and a bad
  file (either shape or these same content rules) is reported on read, never
  repaired; `admitGroups` also refuses to admit anything at all when the
  file already on disk fails to read, so an edit can never paper over an
  existing corruption.
- A `meta/groups.json` that fails to read does not hide the maps: `loadMaps`
  falls back to the plain, ungrouped tree and reports `groupsError`. The
  decision of what to use (the file as read, a fresh seed, or an error) is
  `resolveGroups(read, isVanilla)`, pure for the same reason as
  `admitGroups`. A failed SEED WRITE (a read-only folder, say) is reported
  distinctly from a failed READ: there is no bad file to point at, the write
  itself failed. The widget shows every map, refuses group edits while the
  error stands, and the manifest path is committed only once a load actually
  succeeds, so a failed load cannot leave the next edit writing over a
  different project's file.
- Slots a group names that the current ROM cannot resolve are not silently
  invisible: `loadMaps` reports how many with a note ("N grouped slots are
  not maps in this ROM and are kept in meta/groups.json").
- Groups are not in the undo stack in v1. Every action is reversible by
  another action.
- Group writes from the widget are serialised (a queue), so a second edit
  started before the first one's reload finishes is applied on top of it,
  not on stale local state. The project the edit was meant for is captured
  when it is QUEUED, not read again when it finally runs: if the user
  switches projects while the edit is queued or its write is in flight, the
  edit is dropped rather than applying project A's edit to project B's file,
  or reloading A's tree over B's. `load()` carries the same guard the other
  way: a generation counter means an older `load()` response can never
  overwrite a newer one's tree, however the two resolve relative to each
  other.

## Wiring

- `src/project/MapGroups.ts` is pure core with no shell imports. It holds
  validation, reading and writing through `ProjectMeta`, the vanilla seed
  table, `applyGroups(tree, groups)`, `topLevelSlots(tree)`,
  `staleSlots(tree, groups)`, and the two decision functions `admitGroups`
  and `resolveGroups` described under Persistence. Unit tested without a
  ROM; the server is thin wiring (read the file, build the tree, call the
  pure function, write if told to) rather than holding the decisions itself.
  A grouped top-level map is `MapNode & { orphan: boolean }`; there is no
  separate recursive "grouped node" type, since only the top of each group's
  members needs the marking and the rest of the subtree is a plain `MapNode`.
- `ProjectService` (in `theia/extension/src/common/project-protocol.ts`):
  - `loadMaps` returns the tree already grouped (`GroupedMapTreeDto`), the
    raw `rawGroups` list the frontend edits, and `groupsError` when
    `meta/groups.json` failed to read. The backend seeds a vanilla project
    on this load.
  - `setMapGroups(manifestPath, groups)` writes `meta/groups.json` and
    returns `{ status: 'ok' }` or `{ status: 'invalid', reason }`; it does
    not return a tree, because the caller reloads to see the effect.
- `map-explorer-widget.tsx`:
  - Adds `multiSelect: true`.
  - Adds a group node kind (`group:user:<name>`, distinct from the single
    structural `group:unassigned` id; there is no `group:overworld`).
  - Adds a context menu path.
  - Adds drag handlers (drag start, drag over and drop on tree rows), with
    `canDrop` deciding validity up front so `dragover` can set the cursor
    honestly.
  - Dims orphan rows and gives them a tooltip.
  - Every row carries its own tree node id as `data-node-id`, since the same
    slot can legitimately appear twice in the tree (a sub area reachable
    from one root while ALSO being flagged in the ROM as its own root); node
    ids are unique per tree position, so identifying a row by its exact id
    rather than its slot text is what makes drag/drop and tests unambiguous.
  - The selection and expansion state are re-resolved after a regroup:
    `clearSelection()` runs first (Theia can otherwise carry a selection
    across a model reset for an id that did not change, which a TOGGLE would
    then turn OFF), and only top-level map rows and folders are restored by
    slot/id, never a sub area, since a sub area can share its slot with an
    unrelated top-level row and selecting both would select something Add to
    Group must refuse. A group folder the user had collapsed is tracked
    separately and stays collapsed, since folders otherwise default to
    expanded.
  - A row that is not a valid drag source (a sub area, a loop/truncated row,
    a special map) still clears any in-flight drag state on its own
    `dragstart`, so a stray or synthetic event landing there cannot leave a
    PRIOR valid drag's nodes sitting around for a later `dragover` to accept
    by mistake.
- `map-explorer-contribution.ts` registers the commands and menu actions,
  and drives the QuickInputService QuickPick and SingleTextInputDialog for
  Add to Group, New Group, and Rename.

## Testing

Unit tests (Vitest, no ROM):

- Validation rejects each bad input: duplicate names differing only in
  case, an empty name, an out-of-range slot, and one slot in two groups.
  Each case is a synthetic fixture.
- `readGroups` throws the same content errors on a well-shaped but
  rule-breaking file (duplicate names, empty name, slot in two groups,
  out-of-range slot), not only on unparsable JSON.
- `applyGroups` moves entry maps with their subtree, keeps the orphan
  marking on grouped orphans, skips stale slots and refuses sub areas.
- `staleSlots` reports every grouped slot `applyGroups` could not resolve.
- `admitGroups`: accepts a slot naming a current top-level map; refuses a new
  slot that does not; grandfathers a slot already present in the file on
  disk even when it is no longer top-level; never admits anything when the
  file already on disk failed to read. Each refusal has a planted-defect
  demonstration (disable the check, confirm the test goes red, revert).
- `resolveGroups`: uses the file as read when it has groups (seeding or not);
  seeds only when the file is absent AND the ROM is vanilla; a bad file
  always reports the error over seeding. Also has a planted-defect
  demonstration (always seed regardless of `isVanilla`).
- Seeding is keyed by hash. `seedIfVanilla` takes `{ sha256, title }` so the
  gate stays plantable without changing its contract: the vanilla hash with
  no `meta/groups.json` is seeded, the vanilla hash with `[]` is not, and a
  non-vanilla hash is not, even carrying the stock title. The planted
  defect (comparing `title` instead of `sha256`) must go red.

Corpus test (`describe.skipIf(!hasRom(VANILLA))`):

- Every seeded slot is an entry map in the vanilla map tree, and the ROM's
  own name for it belongs to its group (a substring table for groups whose
  name is spelled out in every member, an exact-name table for castles,
  switch palaces, bridges, doors, the ghost ship and Special Zone).
- `$017` and `$019` are asserted as MEASURED against this corpus, not as
  the draft table's original guess: `$017` is a top-level map (its own,
  unreached root); `$019` is not top-level at all.

Playwright (`theia/browser-app/test/map-groups.spec.cjs`), driven through
the real UI (real clicks with modifiers, a real right-click menu, a real
QuickPick and dialog, a real HTML5 drag), vanilla project unless noted:

- Seeded groups appear (numbered, in world order), and "8. Star World"
  expands to its maps.
- Ctrl+click and Shift+click select multiple rows and open no preview tab.
- Add to Group is absent from the context menu when the selection contains
  a sub area.
- Ctrl+click two Unassigned maps, right-click, Add to Group... > New
  Group..., type "Test". "Test" contains exactly those two slots,
  Unassigned no longer does, and both rows are still dimmed, italic, and
  titled as orphans.
- Drag an Unassigned entry map (one with sub areas) onto "Test": it moves,
  with its sub areas. Dragging one of its sub areas is refused outright. The
  sub-area fixture is chosen as one that is NOT also a top-level row
  elsewhere (a slot can be both, see the widget's `data-node-id` note under
  Wiring); drag/drop rows are all found by exact node id for the same
  reason, since text search for a slot could otherwise land on the wrong of
  two copies.
- Reload the app and reopen the same project: the groups persist.
- Dropping a grouped map onto Unassigned removes it from the group,
  whichever kind it is (entry map or orphan).
- Removing the remaining members leaves "Test" as a visible, empty folder.
- Renaming to a name that clashes only in case is refused with a message,
  shown inline in the dialog; a real rename, then Delete, returns every map
  to Unassigned.
- Non-vanilla project (a hack from the corpus): no groups at load.
- Every assertion checks tree contents after the action, not just that a
  menu item exists.

`theia/browser-app/test/load-maps.spec.cjs` writes `meta/groups.json = []`
before loading, so its ungrouped-tree assertions (label counts, tree shape)
are unaffected by a vanilla ROM now seeding groups by default.

## Size

Mechanism came in over budget: roughly 830 lines added across
`MapGroups.ts`, the protocol, the server, the widget and the contribution,
against an original ~250-line estimate (drag-and-drop, the load/write error
handling in the blocker fix, and slot/expansion restore after a regroup
accounted for most of the difference). Flagged to the owner rather than cut
further, since each piece traces to a named requirement above.

## Depends on

#552 (`meta/` folder and `ProjectMeta`).

## Out of scope for v1

- Nested groups.
- A map in more than one group. That need is tags, a separate feature.
- Manual ordering of groups or maps.
- Undo and redo for group edits.
- Seed tables for any ROM other than stock SMW (U).

## Owner review

The owner reviews every group name, assignment and decoded map name at UAT.
