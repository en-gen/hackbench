# Knowledge Base Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `docs/` into the knowledge base the spec describes: a conventions contract, a state page, a decisions record, protocol definitions, runbooks, a hypotheses ledger, and the migration of project and reference facts out of session memory.

**Architecture:** Docs only. Every existing folder stays where it is. New files follow the Bucs project-manager shape: Bottom line blockquote, inline epistemic tags at the end of claims, corrected-in-place. Protocol files follow a six-heading format that the next PR's parser depends on, so their shape is a contract.

**Tech Stack:** Markdown. The pre-commit content gate rejects em-dashes in added lines, so none may appear. Prettier does not touch Markdown here.

**Spec:** `docs/superpowers/specs/2026-10-07-agentic-protocols-design.md`, sections 3.1, 3.2, 5, 6.1, 7.

## Global Constraints

- No em-dash character anywhere in added lines (content gate, `tools/scripts/check-content.mjs`).
- No AI attribution in commits.
- Epistemic tags are inline at the end of the claim: `[EST]`, `[INF]`, `[OPEN]`, `[PROP]`. Never a prefix, never in front matter.
- Protocol files use exactly the six H2 headings `Purpose`, `Group`, `Activation`, `Changes`, `Unchanged`, `Exit`, in that order, under an H1 equal to the file stem. `Changes` is a numbered list of at most fifteen lines.
- Rulings are quoted verbatim, with no commentary on the owner.
- Machine-local paths and anything the content gate would refuse never enter `docs/`; they stay in session memory with a pointer.
- Every PR adds one line under `[Unreleased]` in `CHANGELOG.md`.
- Branch `feature/kb-scaffolding` off `develop`, worktree `C:/Projects/.worktrees/hackbench/kb-scaffolding`.
- Two links point at files the manuals PR creates (`docs/agents/tech-lead.md` from `protocols/night-shift.md`, `docs/agents/decision-briefs.md` from `runbooks/morning-brief.md`). They dangle for one PR by design; name them in the hand-back so the reviewer does not flag them.

## Review Focus

1. A protocol file with a heading out of order or a missing heading: the next PR's parser must refuse it, so this PR's files must already be exactly right. Test: the reviewer reads each protocol file against the heading list above.
2. The `Changes` list of `night-shift` exceeding fifteen lines when someone adds a refinement later: the reviewer counts; the next PR adds the mechanical check.
3. A migrated memory that carried a machine path (the notes repo, the ROM corpus location, the board PAT): the reviewer greps the diff for `C:/`, `C:\`, `PAT`, `token`.
4. A ruling paraphrased instead of quoted: the reviewer compares each decision file's ruling line with the memory file it came from.
5. A `README.md` link that does not resolve: the reviewer opens every new relative link.

---

### Task 1: CONVENTIONS.md

**Files:**
- Create: `docs/CONVENTIONS.md`

- [ ] **Step 1: Write the file**

```markdown
# Documentation conventions

The contract for everything under `docs/`. `CLAUDE.md` holds the short form; if they disagree, this file wins and `CLAUDE.md` is wrong.

## Epistemic tags

Every claim that is not self-evident carries a tag at its end, inline, never as a prefix and never in front matter:

- `[EST]` read or measured: from the ROM, the disassembly, a test run, the owner's words.
- `[INF]` inferred from `[EST]` material. Say from what.
- `[OPEN]` unresolved. Say what would resolve it.
- `[PROP]` proposed and not ratified. Only the owner promotes it, and the file records the promotion.

Never promote a draft or a recommendation into a decision. A night-shift call is `[PROP]` until ruled.

## Citation

- ROM behaviour cites `SMWDisX file:line`. Trace it; never copy assembly into this repository.
- State the evidence scope with every claim: not "deterministic" but "byte-identical across 6 cold runs, one machine, Mesen 2.x".
- Pin commits by SHA, never "develop" or "main".
- Record what you could not read or verify. A recorded gap beats a confident guess.

## Corrections

When a primary source contradicts a doc, correct the doc in place and leave the trail: "Corrected YYYY-MM-DD: was X, because Y". Never silently rewrite.

## File shape

An analysis or findings file opens with a Bottom line blockquote of three to six bullets, each tagged, then a Provenance table with Source, Identifier, As of and Retrieved columns. Feature and architecture docs at the root and under `architecture/` keep their current shape.

## Decisions

A ruling is a file in `decisions/`, named `YYYY-MM-DD-<slug>.md`. Its first line is one of:

- `Proposed YYYY-MM-DD (<team>)`
- `Ruled YYYY-MM-DD (Brian)`

Then the headings Question, Options considered, Ruling (the owner's words verbatim), Why, Applies to. Promotion edits the first line in place. `decisions/README.md` lists one line per file. Rulings no longer go to issues, the notes repository or session memory; those get a pointer.

## Protocols

A protocol is a file in `protocols/` with exactly these H2 headings in this order: Purpose, Group, Activation, Changes, Unchanged, Exit. The H1 is the file stem. Changes is a numbered list of at most fifteen lines; it is injected into every session's context on every turn while the protocol is active. Group is `none`, a group name, or a group name followed by `(default)`.

## What never goes in docs

Machine-local paths, credentials, ROM bytes, rendered ROM graphics, disassembly listings. The content gate refuses the last three; the first two are a rule. Keep them in session memory with a one-line pointer into `docs/`.

## Writing

Plain words. No em-dashes. Describe things by content, with any number in parentheses after. One line per paragraph or list item in new files; existing hard-wrapped files stay as they are.
```

- [ ] **Step 2: Commit**

```bash
git add docs/CONVENTIONS.md
git commit -m "Docs: add CONVENTIONS.md, the knowledge-base contract"
```

### Task 2: Protocol definitions

**Files:**
- Create: `docs/protocols/README.md`
- Create: `docs/protocols/day-shift.md`
- Create: `docs/protocols/night-shift.md`
- Create: `docs/protocols/throttle.md`

**Interfaces:**
- Produces: the file format the protocol parser in the next PR reads. The parser (`parseProtocolFile` in `tools/scripts/protocol.mjs`) requires the H1 to equal the file stem, the six H2 headings in order, Group as `none` or `<group>` or `<group> (default)`, and Changes as a numbered list of at most fifteen lines. Exactly one file per group may say `(default)`.

- [ ] **Step 1: Write `docs/protocols/README.md`**

```markdown
# Protocols

A protocol is a named mode the owner enacts to change how normal operation runs. It is on or off, it changes the rules listed under its Changes heading for every session in this repository while it is on, and every change is logged. Day shift is the default mode. Procedures are runbooks, not protocols.

Activate with `/protocol <name> on` or `off` (the command lands with the protocol mechanism; see the spec in `docs/superpowers/specs/2026-10-07-agentic-protocols-design.md`). Only the owner enacts a protocol, in chat; the BA runs the command on the owner's words. `throttle` is the one that may switch itself on.

| Protocol | Group | What it is for |
| --- | --- | --- |
| [day-shift](day-shift.md) | shift (default) | normal operation, stated explicitly |
| [night-shift](night-shift.md) | shift | unattended work from the Ready column |
| [throttle](throttle.md) | none | a usage limit was hit |

Protocols in the same group are mutually exclusive. Adding one: copy the six headings from an existing file, keep Changes under fifteen lines, and add a row here.
```

- [ ] **Step 2: Write `docs/protocols/day-shift.md`**

```markdown
# day-shift

## Purpose

Normal operation, stated explicitly so night shift has something to override.

## Group

shift (default)

## Activation

The owner, in chat, with the BA running the command; or the scheduled return the BA sets when night shift begins. Active whenever no other member of the shift group is.

## Changes

1. Plan gate: a tech lead posts each item's plan (brief, agents with roles and models, expected size, merge policy) and waits for the owner's approval before implementing.
2. Questions and design calls go to the BA, which answers from the knowledge base or escalates to the owner.
3. After a merge the tech lead clears itself, then waits for the plan gate on its next item.

## Unchanged

Everything in `CLAUDE.md` and the role manuals in `docs/agents/`.

## Exit

Activating `night-shift` replaces it. Nothing made under day shift is `[PROP]` by virtue of the mode.
```

- [ ] **Step 3: Write `docs/protocols/night-shift.md`**

```markdown
# night-shift

## Purpose

Unattended work through the night from the Ready column, with every judgment call recorded for the owner's morning ruling.

## Group

shift

## Activation

The owner, in chat, naming the return time; the BA runs the command and creates the scheduled return to `day-shift`.

## Changes

1. Plan gate waived: a BA assignment is approval.
2. A non-safety question takes the recommended option, marked `[PROP]`, and is filed as a Proposed decision in `docs/decisions/`. A safety decision (see `docs/agents/tech-lead.md`) stops the item instead.
3. After a merge the tech lead clears itself and asks the BA "what's next" without waiting.
4. The queue is the Ready column of the board, top down; items labelled needs-owner are skipped.
5. A scope change ends the item: the handoff records the question as a Proposed decision and the next item starts.
6. A needs-owner PR opens with its label and waits; the launched build URL goes in the handoff. Only auto-merge items complete unattended.
7. Tech leads run in auto permission mode so a self-clear does not block on a prompt.
8. An empty queue means idle: write the state file, post one line to the BA, wait for the nudge.

## Unchanged

The deliverable loop (simplify, adversarial review, verify, ship), the auto-merge and needs-owner rules, CodeRabbit handling, the content and style gates, the data and image rules, and every "never" in `CLAUDE.md`.

## Exit

`day-shift` returns by command or by the scheduled return. Every `[PROP]` made overnight stays `[PROP]` until the owner rules. The BA produces the morning brief (`docs/runbooks/morning-brief.md`). A night waiver is never precedent.
```

- [ ] **Step 4: Write `docs/protocols/throttle.md`**

```markdown
# throttle

## Purpose

Spend as little as possible until the owner lifts a usage limit.

## Group

none

## Activation

The owner, in chat; or any session that receives a usage-limit error, which activates it and records the trigger in the log line. This is the only protocol a session may activate.

## Changes

1. Finish in-flight work; start no new item.
2. No heavy re-runs: Playwright, full suites and sweeps wait.
3. Prefer Haiku and tightly scoped Sonnet; no Opus except an adversarial review already in progress.

## Unchanged

Everything else, including the active shift protocol.

## Exit

The owner turns it off. Nothing is `[PROP]` under throttle.
```

- [ ] **Step 5: Check the headings mechanically**

Run from the repo root:

```bash
for f in docs/protocols/day-shift.md docs/protocols/night-shift.md docs/protocols/throttle.md; do echo "$f"; grep -n '^## ' "$f" | tr '\n' ' '; echo; done
```

Expected: each line reads `Purpose Group Activation Changes Unchanged Exit` in that order with line numbers ascending.

- [ ] **Step 6: Commit**

```bash
git add docs/protocols
git commit -m "Docs: add the protocol definitions (day-shift, night-shift, throttle)"
```

### Task 3: Decisions record

**Files:**
- Create: `docs/decisions/README.md`
- Create: `docs/decisions/2026-10-07-agentic-protocols-design.md`

- [ ] **Step 1: Write `docs/decisions/README.md`**

```markdown
# Decisions

One ruling per file, named `YYYY-MM-DD-<slug>.md`. The first line is `Proposed YYYY-MM-DD (<team>)` or `Ruled YYYY-MM-DD (Brian)`; promotion edits that line in place. The ruling is the owner's words verbatim. Format in `../CONVENTIONS.md`.

The morning brief after a night shift is `grep -l '^Proposed' docs/decisions/*.md`.

| File | State | Decides |
| --- | --- | --- |
| [2026-10-07-agentic-protocols-design.md](2026-10-07-agentic-protocols-design.md) | Ruled | the protocols, session lifecycle and knowledge-base design |
```

- [ ] **Step 2: Write `docs/decisions/2026-10-07-agentic-protocols-design.md`**

```markdown
Ruled 2026-10-07 (Brian)

## Question

Adopt the agentic workflow design in `docs/superpowers/specs/2026-10-07-agentic-protocols-design.md`: protocols as owner-enacted modes, self-clearing tech-lead sessions, `docs/` as the knowledge base, and eight night-shift refinements?

## Options considered

Each section was presented in chat with lettered options and a recommendation; the owner chose the recommended option each time, with two amendments: the knowledge base lives directly in `docs/` rather than a subfolder, and day shift is itself a protocol that toggles with night shift.

## Ruling

"approved, write the plan"

## Why

Context piles up in persistent tech-lead sessions, the reset after merge was manual, and epistemic tags had proved useful enough to build a knowledge base on.

## Applies to

This repository. Cross-repo protocols and the Neuromancer outer shell are out of scope until revisited.
```

- [ ] **Step 3: Commit**

```bash
git add docs/decisions
git commit -m "Docs: add the decisions record with the first ruling"
```

### Task 4: Hypotheses ledger

**Files:**
- Create: `docs/hypotheses.md`

- [ ] **Step 1: Read the source memory**

Read `project_overworld_area4_rendering_bug.md` in the session-memory directory for this project in full. It is the only `[OPEN]` project fact in memory today.

- [ ] **Step 2: Write `docs/hypotheses.md`**

Use this frame; fill H-1 from the memory file's body, keeping its claims and adding the tags its evidence supports:

```markdown
# Hypotheses

Circulating claims that are not yet `[EST]`. Each carries an evidence ledger. A hypothesis leaves this file when it is established (moves to the doc that owns the topic) or refuted (stays here, marked refuted, with the source). Not decision inputs until established.

## H-1: the overworld renders wrong tiles in area 4 at (30-31, 23-24)

Status: `[OPEN]`, unverified.

| Evidence | Says | Source | Date |
| --- | --- | --- | --- |
| (one row per claim in the memory file, with the file or trace it cites) | | | |

What would resolve it: a Mesen capture of area 4 compared against the editor's render at those tiles, with the disassembly line that writes them.
```

- [ ] **Step 3: Commit**

```bash
git add docs/hypotheses.md
git commit -m "Docs: add the hypotheses ledger with H-1"
```

### Task 5: Runbooks

**Files:**
- Create: `docs/runbooks/README.md`
- Create: `docs/runbooks/morning-brief.md`
- Create: `docs/runbooks/owner-launch.md`
- Create: `docs/runbooks/ci-rerun.md`
- Create: `docs/runbooks/merge-detection.md`

- [ ] **Step 1: Read the source memories**

Read these in full: `feedback_owner_launch_browser.md`, `feedback_ci_rerun.md`, `feedback_merge_detection_cleanup.md`, `feedback_gh_polling_rest.md`, all in the session-memory directory for this project.

- [ ] **Step 2: Write `docs/runbooks/README.md`**

```markdown
# Runbooks

Methods, each estate-agnostic and written so a fresh agent can follow it without the conversation that produced it. Read the runbook before re-deriving the method.

| Runbook | Use when |
| --- | --- |
| [morning-brief.md](morning-brief.md) | night shift ended and the owner needs the decisions |
| [owner-launch.md](owner-launch.md) | a UI change needs the owner's eyes |
| [ci-rerun.md](ci-rerun.md) | a CI run must be repeated |
| [merge-detection.md](merge-detection.md) | an agent must know when a PR merged |
| [../../tools/mesen/README.md](../../tools/mesen/README.md) | a Mesen capture is needed |
```

- [ ] **Step 3: Write `docs/runbooks/morning-brief.md`**

```markdown
# Morning brief

Run by the BA, through a grunt, when `day-shift` returns after a night shift. Mechanical: nobody reads the whole tree.

1. Proposed decisions: `grep -l '^Proposed' docs/decisions/*.md`. Each file is one decision for the owner.
2. Protocol log: read `.claude/state/protocols.log` in the main checkout from the night-shift activation line onward.
3. Merged PRs since that timestamp: `gh pr list -R en-gen/hackbench --state merged --search "merged:>=<ISO timestamp>" --json number,title,mergedAt`.
4. Open needs-owner PRs: `gh pr list -R en-gen/hackbench --state open --label needs-owner --json number,title,url`.
5. Stopped items: every team state file under `.claude/state/teams/` whose Phase line says stopped, with its reason.
6. Present to the owner one decision per message, in the decision-brief format in `docs/agents/decision-briefs.md`, numbered "Decision 1 of N". After the decisions, one message listing merged PRs, open needs-owner PRs with their launched build URLs, and stopped items.
7. For each ruling the owner gives, edit the decision file's first line to `Ruled YYYY-MM-DD (Brian)` and paste the ruling verbatim under Ruling.
```

- [ ] **Step 4: Write `docs/runbooks/owner-launch.md`, `ci-rerun.md` and `merge-detection.md`**

Each is the memory file's body rewritten as numbered steps with no machine-local paths, headed by one line saying when to use it. `merge-detection.md` merges the two memories on polling (REST over GraphQL, bounded wait, the auto-fix monitor never firing on merge). Keep each under thirty lines.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks
git commit -m "Docs: add runbooks, including the morning brief"
```

### Task 6: README becomes the state page

**Files:**
- Modify: `docs/README.md`

- [ ] **Step 1: Add the state section after the "Start here" table**

Insert this block between the "Start here" table and the "Guide" heading:

```markdown
## Current state

What a freshly started session reads first. Keep it short; detail lives in the linked files.

- **Open decisions.** See [decisions/README.md](decisions/README.md); Proposed files are waiting on the owner.
- **Hypotheses.** [hypotheses.md](hypotheses.md) holds claims not yet established.
- **Recent corrections.** Listed here when a primary source overturns a doc, newest first, one line each with the file corrected. (none yet)
- **Conventions.** [CONVENTIONS.md](CONVENTIONS.md) is the contract: tags, citation, corrections, file shapes.
- **Protocols.** [protocols/README.md](protocols/README.md) lists the modes the owner can enact.
- **Runbooks.** [runbooks/README.md](runbooks/README.md) holds the methods.
```

- [ ] **Step 2: Add the new folders to the "Start here" table**

Add one row: `| know the house rules for docs | [CONVENTIONS.md](CONVENTIONS.md) |`.

- [ ] **Step 3: Commit**

```bash
git add docs/README.md
git commit -m "Docs: README gains the current-state section"
```

### Task 7: Migrate one memory as the sample

**Files:**
- Create: `docs/decisions/2026-10-04-bps-primary-patch-format.md`
- Modify: `docs/decisions/README.md`
- Modify (outside the repo): `project_bps_primary_patch_format.md` in the session-memory directory for this project

- [ ] **Step 1: Read the memory file in full**

- [ ] **Step 2: Write the decision file**

```markdown
Ruled 2026-10-04 (Brian)

## Question

Which patch format does Export Patch write by default?

## Options considered

BPS as default with IPS secondary; IPS as default.

## Ruling

(the owner's words from the memory file, verbatim; if the memory holds only a paraphrase, write "reconfirmed by the owner 2026-10-04, wording not recorded" and tag the line `[EST]`)

## Why

BPS is what SMW Central requires and the current community standard; IPS is legacy. Implemented in #287 (`src/project/ExportPatch.ts` default `'bps'`, encoder `src/rom/Bps.ts`). `[EST]`

## Applies to

Export Patch. Any doc line saying Export Patch writes `.ips` is stale, not the spec. Search closed issues before filing a "new" decision; #531 duplicated #287.
```

- [ ] **Step 3: Add the row to `docs/decisions/README.md`**

- [ ] **Step 4: Replace the memory body with a pointer**

Keep the front matter. Body becomes: `Migrated to docs/decisions/2026-10-04-bps-primary-patch-format.md in the HackBench repo. Read it there.`

- [ ] **Step 5: Commit and stop**

```bash
git add docs/decisions
git commit -m "Docs: migrate the BPS ruling from memory as the migration sample"
```

Report the sample to the orchestrator and wait for the owner's sign-off before Task 8. This is the batch rule: one sample, then the rest.

### Task 8: Migrate the rest

**Files:**
- Create and modify per the table below.
- Modify (outside the repo): the listed memory files, each body replaced by a one-line pointer, front matter kept; `MEMORY.md` lines updated to say "migrated" with the docs path.

The target for each project and reference memory. Keep the memory's claims and dates; add tags the evidence supports; never paraphrase a ruling.

| Memory file | Target | Shape |
| --- | --- | --- |
| project_gfx_staged_layers | `decisions/2026-09-23-gfx-staged-layers.md` | Ruled |
| project_theia_shell_decision | `decisions/<date in body>-theia-idioms-only.md` | Ruled |
| project_map_editor_gated_on_capture | `decisions/<date in body>-map-view-rulings.md` | Ruled, one file, several numbered rulings |
| project_sprite_engine_architecture | `decisions/<date in body>-sprite-table-engine.md` | Ruled |
| project_editor_convention_detection | `decisions/2026-09-21-editor-convention-detection.md` | Ruled |
| project_rom_runs_on_owner_hardware | `decisions/<date in body>-rom-ci-on-owner-hardware.md` | Ruled |
| project_snes_keyboard_defaults | `decisions/<date in body>-snes-keyboard-defaults.md` | Ruled |
| project_overnight_backlog_runs | `decisions/<date in body>-ready-column-is-the-queue.md` | Ruled; note it is now protocol `night-shift` change 4 |
| project_collision_overlay | `decisions/2026-10-05-collision-overlay-via-core.md` | Ruled |
| project_review_ledger | `decisions/<date in body>-review-ledger.md` | Ruled |
| project_perf_gates | `testing.md`, new section "Perf gates" | append |
| project_perfaccept_forges_statuses | `testing.md`, same section | append |
| project_l2_buffer_stride | `rom/map-data-mechanics.md`, new section "Layer 2 stride and wrap" | append, keep the `bank_00.asm` line citations |
| project_addmusick_corpus | `rom/addmusick-detection.md` | new file, Bottom line and Provenance |
| project_overworld_area4_rendering_bug | `hypotheses.md` H-1 | done in Task 4; replace body with pointer |
| reference_known_level_ids | `rom/smw-overworld-levels.md`, new section "Level names and ids" | append |
| reference_hack_corpus | `rom/hack-corpus.md` | new file; hack titles are public SMW Central names and may stay |
| reference_smwc_api | `runbooks/smwc-api.md` | new runbook |
| reference_theia_dragover | `architecture/theia-shell.md`, new section "Drag and drop" | append |
| reference_playwright_rpc_intercept | `testing.md`, new section "Playwright and RPC" | append |
| reference_repo_migration | `runbooks/repo-migration.md` | new runbook; the issue-map path is machine-local, so write "the issue map in the tools checkout" |
| reference_mapviewer_tests_repo | `testing.md`, new section "The validation repository" | append; `HB_CORE_JS` is an env var name, fine |
| reference_hackbench_board | `runbooks/board.md` | new runbook with project ids and status names; the PAT stays in memory, pointer only for that line |
| reference_notes_repo | stays in memory | machine-local path; add one line to `README.md` Current state: "scratch decisions predate this knowledge base and live in the owner's notes repository" |
| reference_usage_limit_data | stays in memory | machine-local transcript paths |
| feedback_smwdisx_memo (typed reference) | stays in memory | machine-local path; the memo rule is already in `CLAUDE.md` |

- [ ] **Step 1: For each row, read the memory in full, write or append the target, add a `decisions/README.md` row where the target is a decision**

- [ ] **Step 2: Grep the diff for machine paths and secrets**

```bash
git diff develop --stat && git diff develop | grep -nE 'C:[/\\]|ghp_|PAT|token' ; echo "exit $?"
```

Expected: no matches apart from the `tools/mesen/README.md` link in `runbooks/README.md`.

- [ ] **Step 3: Replace each migrated memory's body with its pointer and update `MEMORY.md`**

- [ ] **Step 4: Add the CHANGELOG line**

Under `[Unreleased]` in `CHANGELOG.md`: `- Docs: docs/ becomes the knowledge base: conventions, decisions, protocols, runbooks, hypotheses; project facts migrated from session memory.`

- [ ] **Step 5: Commit**

```bash
git add docs CHANGELOG.md
git commit -m "Docs: migrate project and reference facts from memory into the knowledge base"
```

### Task 9: Hand back

Report: branch, files created and modified, the count of memories migrated and the three that stayed, every link checked, and the grep result from Task 8 step 2. No tests run; this PR is operational Markdown, which skips Review and Verify. Hooks and CI still check it.
