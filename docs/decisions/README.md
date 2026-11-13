# Decisions

One ruling per file, named `YYYY-MM-DD-<slug>.md`. The first line is `Proposed YYYY-MM-DD (<team>)` or `Ruled YYYY-MM-DD (Brian)`; promotion edits that line in place. The ruling is the owner's words verbatim where recorded; otherwise it says `wording not recorded`, gives the date, and tags the paraphrase `[INF]`. Format in `../CONVENTIONS.md`.

The morning brief after a night shift is `grep -l '^Proposed' docs/decisions/*.md`.

| File | State | Decides |
| --- | --- | --- |
| [2026-11-11-unreadable-loader-boxes-extra-bits.md](2026-11-11-unreadable-loader-boxes-extra-bits.md) | Proposed | when the sprite loader cannot be read, a sprite with extra bit 2 or 3 is boxed with the reason "loader unreadable", goal tapes included; never vanilla art, never hidden; option B (run it, mark unverified) is the alternative (#1011, PR #1273, D204) |
| [2026-11-07-art-past-edge-proposed-calls.md](2026-11-07-art-past-edge-proposed-calls.md) | Proposed | the three build calls under the art-past-the-edge ruling: placement is `stored` else the anchor; far-end-gutter art still draws; a sprite with no art on the map keeps its box in the pad (#1325) |
| [2026-11-07-art-past-map-edge-grows-no-canvas.md](2026-11-07-art-past-map-edge-grows-no-canvas.md) | Ruled | map view: art past a map's edge is cut and grows no canvas on any side; a sprite or object placed off the map still grows it (#1325; narrows D76 call 2) |
| [2026-11-07-process-timeout-budgets-above-30s.md](2026-11-07-process-timeout-budgets-above-30s.md) | Proposed | two #1209 files needed budgets above 30 s under the heavy loaded run: RevealSweep `slow(90_000)`, playwrightPortGate `loadTimeout(120_000)` (option A, night shift) |
| [2026-11-07-partly-drawn-object-gets-the-mark.md](2026-11-07-partly-drawn-object-gets-the-mark.md) | Proposed | an object with some tiles outside the map's tile space keeps the tiles that fit and also gets the "!" mark with the off-buffer reason (#1034) |
| [2026-11-06-rope-length-calls.md](2026-11-06-rope-length-calls.md) | Proposed | the rope's sprite-slot length: the dispatch role gate picks the sprites, setting 1's odd rope is long and solid (fixed-range spawners assumed away), no hover line for the door, the Properties preview draws door tiles solid |
| [2026-11-06-map-notes-spawner-ratios-stay-collapsed.md](2026-11-06-map-notes-spawner-ratios-stay-collapsed.md) | Proposed | per-spawner ratio sentences ("Only N of 5 appear") stay collapsed in the map note, not summed; only "N did not draw" sums, per noun (#1281) |
| [2026-11-06-map-notes-mixed-reasons-in-notedetail.md](2026-11-06-map-notes-mixed-reasons-in-notedetail.md) | Proposed | two spawners of one noun with different reasons give one total in the note and the reasons in `noteDetail`, as #1256 set (#1281) |
| [2026-11-06-reveal-search-sprites-that-drew-at-rest.md](2026-11-06-reveal-search-sprites-that-drew-at-rest.md) | Proposed | a sprite that drew at rest, is hidden and nothing reveals keeps its real-start picture in the screen door (not the issue's marker), and gets only the first three conditions (#1132, D192) |
| [2026-11-05-d126-exception-entry-site-ram.md](2026-11-05-d126-exception-entry-site-ram.md) | Ruled | the overworld entry path names its 7 RAM addresses beside its opcodes, a D126 exception for that block only on four conditions; no precedent for other blocks (D185) |
| [2026-11-05-yoshi-heaven-grouped-slot-no-note.md](2026-11-05-yoshi-heaven-grouped-slot-no-note.md) | Proposed | a user group naming a slot the wings link placed ($0C8) loses its row with no note; the map is still under its holder (#1229) |
| [2026-11-05-yoshi-heaven-old-groups-empty-folder.md](2026-11-05-yoshi-heaven-old-groups-empty-folder.md) | Proposed | a groups.json written before #1229 keeps an empty Yoshi Heaven folder; the file is left untouched (#1229) |
| [2026-11-05-gutter-layers-through-band.md](2026-11-05-gutter-layers-through-band.md) | Proposed | Layers 2 and 3 also run through an off-map content band before the gutter; an object-stream Layer 2 shows only tiles the stream wrote past the edge, usually none (#1197) |
| [2026-11-05-fails-to-parse-means-no-end-marker.md](2026-11-05-fails-to-parse-means-no-end-marker.md) | Proposed | a pointed slot "fails to parse" when a stock-size walk finds no end marker within 128 KB or before the file ends; the exit graph keeps its 8 KB cap (D155) |
| [2026-11-05-line-guided-picks-read-drawnparts.md](2026-11-05-line-guided-picks-read-drawnparts.md) | Proposed | line-guided picks read `drawnParts` instead of `.parts` after #840 (four reads, nothing else changed in #987's code) |
| [2026-11-04-map-gutter-far-end-only.md](2026-11-04-map-gutter-far-end-only.md) | Ruled | the map view gutter is one screen (256 px) at the far end only, none before position 0 and none at 32 screens; replaces the left half of D48 part 2 and R24 (D172) |
| [2026-11-04-state-inside-repo-cutover.md](2026-11-04-state-inside-repo-cutover.md) | Proposed | hooks and settings stay unchanged and the cutover leaves a junction at the old state folder name |
| [2026-11-03-gm12-gate-window-hooks.md](2026-11-03-gm12-gate-window-hooks.md) | Ruled | a hook in GM12PrepLevel before the $0D9B test is an accepted limit, no guard; the warn path is follow-up #1205 (D159) |
| [2026-10-29-keep-staged-check-scripts.md](2026-10-29-keep-staged-check-scripts.md) | Proposed | keep the staged-check scripts and their gate test as tooling for #1163 |
| [2026-10-17-map-notes-rom-scope.md](2026-10-17-map-notes-rom-scope.md) | Proposed | whole-ROM map notes are shown once under This ROM, never on each map |
| [2026-10-17-map-draw-notes-panel-only.md](2026-10-17-map-draw-notes-panel-only.md) | Ruled | map draw notes appear only in the Properties panel, no lines over the map (D111 call 2 / "D95B") |
| [2026-10-17-missing-base-rom-is-a-project-problem.md](2026-10-17-missing-base-rom-is-a-project-problem.md) | Proposed | a missing base ROM is a project problem, not a map note |
| [2026-10-17-map-facts-plain-labels.md](2026-10-17-map-facts-plain-labels.md) | Proposed | plain labels: Layout, Collected items remembered, Tile graphics |
| [2026-10-17-graphics-note-names-lunar-magic.md](2026-10-17-graphics-note-names-lunar-magic.md) | Proposed | the graphics note keeps the Lunar Magic wording |
| [2026-10-08-zoom-anchor-race-seam.md](2026-10-08-zoom-anchor-race-seam.md) | Ruled | Maps zoom: the renderedZoom guard is unreachable from UI input, no test; plant 1 is tested |
| [2026-10-09-self-clear-round-trip.md](2026-10-09-self-clear-round-trip.md) | Ruled | self-clear uses a resume prompt through the orchestrator; night shift enactable; the BA enacts only after the post-cutover confirm |
| [2026-10-08-night-shift-ends-on-owner-word.md](2026-10-08-night-shift-ends-on-owner-word.md) | Ruled | night shift has no scheduled return; the owner ends it |
| [2026-10-07-agentic-protocols-design.md](2026-10-07-agentic-protocols-design.md) | Ruled | the protocols, session lifecycle and knowledge-base design |
| [2026-10-04-bps-primary-patch-format.md](2026-10-04-bps-primary-patch-format.md) | Ruled | BPS is the default export format, IPS secondary |
| [2026-09-23-gfx-staged-layers.md](2026-09-23-gfx-staged-layers.md) | Ruled | GFX edits are staged per 8x8 character, committed on Save |
| [2026-09-20-theia-idioms-only.md](2026-09-20-theia-idioms-only.md) | Ruled | Theia shell; Theia idioms only, no raw Lumino |
| [2026-09-24-map-view-rulings.md](2026-09-24-map-view-rulings.md) | Ruled | map view rulings: load-time data, no stitching, intent over bugs |
| [2026-10-05-sprite-table-engine.md](2026-10-05-sprite-table-engine.md) | Ruled | sprites are interpreted from ROM code; table engine is a stopgap |
| [2026-09-21-editor-convention-detection.md](2026-09-21-editor-convention-detection.md) | Ruled | detect vanilla, magic or ours conventions |
| [2026-10-04-rom-ci-on-owner-hardware.md](2026-10-04-rom-ci-on-owner-hardware.md) | Ruled | ROM-needing CI runs on the owner's self-hosted runner |
| [2026-09-23-snes-keyboard-defaults.md](2026-09-23-snes-keyboard-defaults.md) | Ruled | default SNES keyboard bindings and rebinding UI |
| [2026-10-04-ready-column-is-the-queue.md](2026-10-04-ready-column-is-the-queue.md) | Ruled | the Ready column is the queue for unattended runs |
| [2026-10-05-collision-overlay-via-core.md](2026-10-05-collision-overlay-via-core.md) | Ruled | collision overlay derives from the 65816 core |
| [2026-10-04-review-ledger.md](2026-10-04-review-ledger.md) | Ruled | keep adversarial review, track it |
| [2026-10-10-map-editor-scope.md](2026-10-10-map-editor-scope.md) | Ruled | the map editor chooses backgrounds; no live background editing |
| [2026-10-15-interpret-else-warn.md](2026-10-15-interpret-else-warn.md) | Ruled | ROM data whose shape can be read is followed; only unreadable data gets a warning or error |
| [2026-10-16-third-party-code.md](2026-10-16-third-party-code.md) | Ruled | reuse open-source code with a fitting licence and visible credit; no strong GPL; agents never contact outside maintainers |
| [2026-10-16-side-quest.md](2026-10-16-side-quest.md) | Ruled | side quest is a per-session mode, not a protocol: one session works one problem with no orchestration |
| [2026-10-19-map-view-gutter-details.md](2026-10-19-map-view-gutter-details.md) | Proposed | map view gutter and badge details: solid content bands, fade to panel, grid across gutters, edge line, drawn-box growth, issue count meaning |
| [2026-11-03-bonus-game-grid-fixed-positions.md](2026-11-03-bonus-game-grid-fixed-positions.md) | Ruled | bonus game sprite $82: the nine-block grid draws at the game's fixed positions, not around the placed spot or a drag (D158 / Decision 124 A) |
| [2026-11-03-tide-l3-load-x.md](2026-11-03-tide-l3-load-x.md) | Ruled | no load step sets tide X; HackBench draws phase 0; the capture's 271 is the 15 frames before its anchor; bytes $02-$7F are tides in the core |
| [2026-10-17-pr-before-locked-test-run.md](2026-10-17-pr-before-locked-test-run.md) | Proposed | open the PR before the locked test run when the lock queue is long; arm auto-merge only after it passes |
| [2026-10-20-line-guided-gate-calls.md](2026-10-20-line-guided-gate-calls.md) | Proposed | line-guided gate names each call target by routine fingerprint, interact slot unhashed; old Travel tests dropped; rope in round 2; NMI vector check; slot-3 poke sweep; first frame at rest by the run, no id list |
| [2026-10-29-line-guided-first-frame-on-line.md](2026-10-29-line-guided-first-frame-on-line.md) | Ruled | line-guided sprites at rest are drawn where the game first has them on their line; one that starts behind the scroll in every loader spawn stays on its tile ("never appears in play") |
| [2026-11-05-quiet-marker-is-a-clear-ring.md](2026-11-05-quiet-marker-is-a-clear-ring.md) | Proposed | quiet marker for undrawn placed items is a thin ring with a clear interior, not the mockup's opaque circle, so it never hides the tile under it (#1011 acceptance 6) |
| [2026-11-11-capture-double-reload-limit.md](2026-11-11-capture-double-reload-limit.md) | Proposed | [PROP] the capture harness clears its recording only on the first room reload during the wait; a second reload (never seen in vanilla) keeps the middle load's recording; documented in headless_capture.lua, not fixed |
| [2026-11-13-map-end-line-and-add-screen.md](2026-11-13-map-end-line-and-add-screen.md) | Proposed | [PROP] amber end line fixed to the map edge, constant screen px, color a theme variable with a literal fallback; dashed "Add screen" outline fills the last gutter screen with tooltip "Add screen is not available yet"; 32-screen line is drawn inset so all 5 px stay inside the strip (#1296) |
