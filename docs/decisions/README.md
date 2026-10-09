# Decisions

One ruling per file, named `YYYY-MM-DD-<slug>.md`. The first line is `Proposed YYYY-MM-DD (<team>)` or `Ruled YYYY-MM-DD (Brian)`; promotion edits that line in place. The ruling is the owner's words verbatim where recorded; otherwise it says `wording not recorded`, gives the date, and tags the paraphrase `[INF]`. Format in `../CONVENTIONS.md`.

The morning brief after a night shift is `grep -l '^Proposed' docs/decisions/*.md`.

| File | State | Decides |
| --- | --- | --- |
| [2026-10-08-zoom-anchor-race-seam.md](2026-10-08-zoom-anchor-race-seam.md) | Ruled | Maps zoom: the renderedZoom guard is unreachable from UI input, no test; plant 1 is tested |
| [2026-10-09-self-clear-round-trip.md](2026-10-09-self-clear-round-trip.md) | Ruled | self-clear uses a resume prompt through the orchestrator; night shift unblocked |
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
