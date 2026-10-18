# Decisions

One ruling per file, named `YYYY-MM-DD-<slug>.md`. The first line is `Proposed YYYY-MM-DD (<team>)` or `Ruled YYYY-MM-DD (Brian)`; promotion edits that line in place. The ruling is the owner's words verbatim where recorded; otherwise it says `wording not recorded`, gives the date, and tags the paraphrase `[INF]`. Format in `../CONVENTIONS.md`.

The morning brief after a night shift is `grep -l '^Proposed' docs/decisions/*.md`.

| File | State | Decides |
| --- | --- | --- |
| [2026-10-17-map-notes-rom-scope.md](2026-10-17-map-notes-rom-scope.md) | Proposed | whole-ROM map notes are shown once under This ROM, never on each map |
| [2026-10-17-map-draw-notes-stay-above-map.md](2026-10-17-map-draw-notes-stay-above-map.md) | Proposed | map draw notes stay above the map and are also listed |
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
