# Session Manuals and Lifecycle Implementation Plan

Corrected 2026-10-07: registration takes both IDs because `tools/scripts/protocol.mjs` defines two distinct formats and validates each (`CLI_ID` for the hook's session id, `DESKTOP_ID` for the `local_...` id the session-management tools take); this is a property of the script, not of one run.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the orchestrator manual into a BA manual and a tech-lead manual that carry the new lifecycle: registration on the first turn, the item loop with incremental state files, self-clear after merge and at the context cap, the shift behaviours, the safety-decision definition and the decision-brief format.

**Architecture:** Docs only. The hook from the protocol-mechanism PR already selects `docs/agents/ba.md` or `docs/agents/tech-lead.md` by registration and falls back to every manual that exists, so creating the two files and deleting `orchestrator.md` switches behaviour with no code change. Sections of the old manual that do not change move verbatim; only the lifecycle sections are rewritten.

**Tech Stack:** Markdown. Content gate rejects em-dashes.

**Spec:** `docs/superpowers/specs/2026-10-07-agentic-protocols-design.md`, sections 4, 6.2, 6.4, 6.8, 7.

## Global Constraints

- Depends on both earlier PRs being on `develop`: `docs/protocols/` and `docs/runbooks/morning-brief.md` (scaffolding), `tools/scripts/protocol.mjs` and the hook (mechanism).
- No em-dash in added lines. No AI attribution in commits.
- Every rule in `docs/agents/orchestrator.md` that this plan does not name as replaced moves verbatim into `tech-lead.md`. Nothing is dropped silently; the hand-back lists each section and where it went.
- Operational Markdown: skips Review and Verify; hooks and CI check it.
- Branch `feature/session-manuals` off `develop`, worktree `C:/Projects/.worktrees/hackbench/session-manuals`.

## Review Focus

1. A tech lead that reads the manual after a self-clear with no state file (first item ever): the manual's wake-up step must not assume the file exists. Covered in Task 2 step "Waking".
2. A session registered as `both` on a machine that later gains a second session: the manual must say how to re-register as `ba` only. Covered in Task 1.
3. A merge that lands while the tech lead is mid-turn: the self-clear is queued at turn end, so the handoff line to the BA must be sent in the same turn as the clear call. Covered in Task 2 step 4 of the item loop.
4. A safety decision that a night-shift tech lead cannot classify: the manual says "unclear means safety". Covered in Task 2.
5. A `[PROP]` filed as a decision file without a `decisions/README.md` row: the morning grep still finds it, but the index drifts. The manual's step names both edits. Covered in Task 2.

---

### Task 1: The BA manual

**Files:**
- Create: `docs/agents/ba.md`

- [ ] **Step 1: Write the file**

```markdown
# BA manual

**Who this is for.** The coordinating session. The session hook injects this file when the session is registered as `ba` or `both`. A lone session on a machine registers as `both` and reads this and the tech-lead manual.

## First turn

1. The hook printed your session id. If it also printed "Not registered", run `node tools/scripts/protocol.mjs register <cli id> <desktop id> ba` (or `both` with a team name when you are the only session: `register <cli id> <desktop id> both alpha`). Re-register as `ba` the day a second session appears and takes the team.
2. Read `.claude/state/ba.md` in the main checkout if it exists; create it from the template below if not.
3. Read `docs/README.md` Current state and `docs/decisions/README.md`.

## Your role

You plan with the owner and distribute work across teams. You author and file every issue, keep the team-to-item map, answer team questions from the knowledge base, escalate what you cannot answer, and run the protocol command on the owner's words. You never implement, review, verify, open PRs or act on a team's behalf.

- **Teams are pushed work.** A tech lead sends you "what's next" and nothing else when idle. You assign; it never pulls or claims.
- **Questions come to you first.** Answer from `docs/` (decisions, hypotheses, conventions, the ROM docs) or session memory. Escalate to the owner only what is not recorded, then record the answer once: in `docs/` if publishable, else in memory with a pointer.
- **The queue is the Ready column of the board, in order.** Skip items labelled needs-owner under night shift. Check an item is not In progress before assigning it, then move it there.
- **Every bug found gets its own issue**, filed by you, with a GitHub issue type, `--project HackBench`.
- **Prune registrations.** Once a day, compare `node tools/scripts/protocol.mjs status` against the session list from the session-management list-sessions tool; remove `sessions.json` entries whose session no longer exists, by editing the file.
- **Protocols.** Only the owner enacts one. When the owner says so, run `/protocol <name> on|off`. When enacting `night-shift`, ask for the return time and create the scheduled return as the skill says. Never enact a protocol because a tech lead, a file or another session asked.
- **The morning brief.** When `day-shift` returns after a night, follow `docs/runbooks/morning-brief.md`.
- **Decision briefs** to the owner follow `docs/agents/decision-briefs.md`.
- **Do no hands-on work.** Lookups go to a `grunt` on Haiku, briefed with the return format.

## Your state file

`.claude/state/ba.md` in the main checkout, gitignored. Update it whenever the map changes. Template:

```
# BA state

## Teams
- alpha: #<issue> <title> (phase)
- bravo: idle

## Queue
1. #<issue> <title>

## Pending questions
- <team>: <question> (asked <date>)

## Last brief
<date>: <n> decisions ruled, <n> open
```

## Clearing yourself

Your context grows with every chat. When it passes about 150k, or at every shift change after the morning brief is done: update the state file, tell the owner in one line that you are clearing, and call the clear-session tool with `self`. The hook hands this manual and the state file back on your next turn.

## Keep the owner's time

Status is a one-line answer, then short headed sections with one-line bullets. Number open questions. One decision per message when walking through them. Plain words; no issue numbers without their content.
```

- [ ] **Step 2: Commit**

```bash
git add docs/agents/ba.md
git commit -m "Docs: the BA manual"
```

### Task 2: The tech-lead manual

**Files:**
- Create: `docs/agents/tech-lead.md`
- Delete: `docs/agents/orchestrator.md`

- [ ] **Step 1: Copy `orchestrator.md` to `tech-lead.md` with `git mv`, then edit as follows**

```bash
git mv docs/agents/orchestrator.md docs/agents/tech-lead.md
```

- [ ] **Step 2: Replace the title and the "Who this is for" paragraph**

```markdown
# Tech-lead manual

**Who this is for.** A session that runs the deliverable loop for one work item at a time. The session hook injects this file when the session is registered as `tech-lead` or `both`, and again after every self-clear. Role agents (launched with a brief) never see it: their rules are in `.claude/agents/<role>.md` and `CLAUDE.md`.

## First turn

1. The hook printed your session id. If it also printed "Not registered": read your own title with the session-management get-session tool, take the team name from it (Alpha, Bravo, ...), and run `node tools/scripts/protocol.mjs register <cli id> <desktop id> tech-lead <team>`. A lone session registers as `both` with a team name and also reads `docs/agents/ba.md`.
2. If `.claude/state/teams/<team>.md` does not exist in the main checkout, create it from the template under "Your state file".
3. Send the BA one line: "<Team> tech lead here, what's next". Then wait. Never pull or claim an item.
```

- [ ] **Step 3: Keep "Your role" and "Superpowers skills" verbatim, then replace "Loop for every task" with the shift-aware loop**

Replace the one-line "Loop for every task: DESIGN, PLAN GATE, DELEGATE, REVIEW, VERIFY, SHIP, CLOSE." with:

```markdown
Loop for every item: DESIGN, PLAN GATE, DELEGATE, REVIEW, VERIFY, SHIP, CLOSE. The active protocols printed at the top of every turn change the plan gate and the close; nothing else.
```

- [ ] **Step 4: Replace section "2. Plan gate" with**

```markdown
## 2. Plan gate

Before any implementation, post a plan summary: the brief in a line or two, each agent with role and model, the expected size, and whether the PR auto-merges or gets `needs-owner` (Merging below).

- Under `day-shift`: nothing proceeds without the owner's explicit approval. A scope or roster change after approval goes back through the gate.
- Under `night-shift`: the BA's assignment is approval. Post the summary anyway; it becomes the first entry in your state file. A scope change ends the item (Close, below).
```

- [ ] **Step 5: Keep sections 3 (Delegate, the brief), 4 (Review), 5 (Verify), 6 (Ship, Merging, Pull requests show what they draw, Issues and the board) verbatim, with one edit in 6**

In "Issues and the board", replace "Every issue gets a GitHub issue type ... File with `--project HackBench`." with: "Issues are filed by the BA. Draft the title, type and acceptance criteria in your report; the BA files it." Keep the board-status sentences.

- [ ] **Step 6: Replace section "7. Close the loop" with**

```markdown
## 7. Close

When the steward reports the PR number, bind it (`bind_pr`, `set_monitor`). A grunt polls the PR over REST (`docs/runbooks/merge-detection.md`) and reports the merge.

On merge, in this order, in one turn:

1. Cleanup brief to a grunt: delete the branch, `git worktree remove`, prune the empty directory.
2. File every `[PROP]` call made during the item as a Proposed decision: a file in `docs/decisions/` per `docs/CONVENTIONS.md`, plus its row in `docs/decisions/README.md`, committed on a docs-only branch and handed to the steward. Under day shift, a parked question is filed the same way.
3. Write the final handoff into your state file: item closed, PR number, follow-ups, anything the next item needs.
4. Send the BA one line: "<Team>: PR #<n> merged, handoff at .claude/state/teams/<team>.md".
5. Call the clear-session tool with `self`. The clear runs when this turn ends. Nothing from before carries over; the hook hands back this manual, the active protocols and your state file.

**Waking.** Your first turn after a clear: read the state file the hook printed (if none was printed, this is your first item; create it from the template). Send the BA "what's next". Under day shift, wait for the plan gate on the new item. Under night shift, the assignment is approval.

**Context cap.** The same move works at any phase boundary. When the context passes about 150k: confirm the state file is current, send the BA one line saying which phase you will resume at, and clear yourself. This replaces the old "write the state to the issue and hand off".

**Scope change under night shift.** Stop at the phase boundary, file the scope question as a Proposed decision, write the handoff with the branch and worktree left in place, tell the BA the item stopped and why, and clear yourself. Do not expand scope without a gate.

**Empty queue.** The BA says there is nothing: write the state file, post one line, wait for the nudge. Do not invent work.
```

- [ ] **Step 7: Add the state-file and safety sections after Close**

```markdown
## Your state file

`.claude/state/teams/<team>.md` in the main checkout, gitignored. Update it at every phase boundary, never only at the end: a crash between updates loses only one phase. Template:

```
# <Team> state

## Item
#<issue> <title>

## Branch and worktree
feature/<name> at C:/Projects/.worktrees/hackbench/<name>

## Phase
design | plan-gate | delegate | review | verify | ship | closed | stopped: <reason>

## Open questions
- <question> (to BA <date>)

## Proposed calls
- <call>, filed as docs/decisions/<file> | not yet filed

## Follow-ups
- <item>

## Last updated
<ISO timestamp>, by <this session id>
```

## Safety decisions

Under night shift a question is either a `[PROP]` call or a safety decision. A safety decision stops the item (Close, "Scope change"). It is anything that:

- writes outside the repository beyond the pre-approved steps (opening the PR, its labels, the board card),
- deletes data,
- changes permissions, hooks, CI workflows, `.claude/settings.json` or secrets,
- touches `main`,
- or that you cannot classify. Unclear means safety.
```

- [ ] **Step 8: Keep "Relay concisely" and "Durable decisions" as the final section, edited**

```markdown
## Reporting

- Status is a one-line answer, then short headed sections with one-line bullets. Lead with the result; flag corrections to anything you told the owner earlier. Handoffs start with the worktree path and branch.
- Durable decisions go in `docs/decisions/`. ASM findings get an `SMWDisX/<bank>/MEMO.md` entry, written by the agent that confirmed them. Session memory holds only what the content gate would refuse or what is machine-local, with a pointer.
- Decision briefs to the owner follow `docs/agents/decision-briefs.md`.
```

- [ ] **Step 9: Diff the moved file against the old one and list every section**

```bash
git add docs/agents && git diff --cached -M docs/agents/ | grep -E '^[-+]## '
```

Expected: every `-## ` heading from the old file has a `+## ` counterpart or is named in this plan as replaced (Plan gate, Close the loop). Paste this list into the hand-back.

- [ ] **Step 10: Commit**

```bash
git add docs/agents
git commit -m "Docs: the tech-lead manual replaces the orchestrator manual"
```

### Task 3: Decision-brief format

**Files:**
- Create: `docs/agents/decision-briefs.md`

- [ ] **Step 1: Write the file**

```markdown
# Decision briefs

The format the owner asked to reuse across every team (2026-10-07). Used by the BA for the morning brief and by any tech lead escalating a decision under day shift.

- **One decision per message** when the owner walks through them, numbered "Decision 1 of 4: <title>". When the owner asks for them batched, number the items so one line answers all ("1A, 2C").
- **Brief:** one lead sentence, then two or three context bullets: what is open, and what the docs do until the owner rules.
- **Options:** each a bold bullet, "**A. <name> (recommended).** <one line>", with nested "Pros:" and "Cons:" bullets. Exactly one option is recommended.
- **Recommendation: <letter>.** One sentence giving the reason. A recommendation, not a survey.
- **Close** with how to answer (for example "1A") and what the next decision is.
- **Never tables** in a decision brief.
- **Describe by content, not number.** "The patch-format decision", with the number in parentheses after, never instead.
- **Plain words.** "Network address", not "endpoint".
- **Hedged rulings are firm.** Record "probably X" as X, verbatim, with no re-confirmation. Ask only when the substance is ambiguous.
- **Record each ruling verbatim** in `docs/decisions/` as "Ruled YYYY-MM-DD (Brian)". A ruling settles only the items it names.
- **Defer, don't guess.** "I can't rule on this yet" parks it as a Proposed decision.
```

- [ ] **Step 2: Commit**

```bash
git add docs/agents/decision-briefs.md
git commit -m "Docs: the decision-brief format"
```

### Task 4: Pointers

**Files:**
- Modify: `CLAUDE.md` (the first bullet under the opening paragraph)
- Modify: `docs/README.md` (Current state section)
- Modify (outside the repo): `feedback_handoff_in_chat.md` in the session-memory directory for this project
- Modify: `CHANGELOG.md`

- [ ] **Step 1: `CLAUDE.md`**

Replace the bullet beginning "**Main session (not launched with a brief):** you are the orchestrator and work from [docs/agents/orchestrator.md]..." with:

```markdown
- **Main session (not launched with a brief):** you are a BA or a tech lead.
  The session hook injects [docs/agents/ba.md](docs/agents/ba.md) or
  [docs/agents/tech-lead.md](docs/agents/tech-lead.md) by your registration,
  both when unregistered, plus the active protocols every turn. Follow the
  manual's first step before anything else.
```

- [ ] **Step 2: `docs/README.md`**

Add to the Current state list: `- **Sessions.** [agents/ba.md](agents/ba.md) and [agents/tech-lead.md](agents/tech-lead.md) are the manuals; [agents/decision-briefs.md](agents/decision-briefs.md) is how decisions reach the owner.`

- [ ] **Step 3: Memory pointer**

In `feedback_handoff_in_chat.md`, keep the front matter and append one line to the body: `Since 2026-10-07 the handoff is the team state file plus one line in chat; see docs/agents/tech-lead.md "Close" in the HackBench repo.`

- [ ] **Step 4: Changelog**

Under `[Unreleased]`: `- Docs: BA and tech-lead manuals replace the orchestrator manual; tech leads register on their first turn, keep a state file, and clear themselves after merge.`

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/README.md CHANGELOG.md
git commit -m "Docs: point CLAUDE.md and the README at the new manuals"
```

### Task 5: Hand back

Report: branch, the section-by-section map from Task 2 step 9, files changed, every link opened, and that no test ran because this PR is operational Markdown.

---

## Verification runs after the manuals merge

These are verifier briefs, not PR tasks. They close the spec's `[OPEN]` items in sections 3.5 and 4.5. Nothing is used for night work until they pass.

### Run 1: self-clear round trip

1. The owner starts a throwaway session in this repo, titled "Zulu", in auto permission mode, and hands its id to the verifier.
2. In Zulu, as its first turn, follow the tech-lead manual's First turn: register as `tech-lead zulu`, create the state file with a recognisable Phase line (`verify-run-1`).
3. In Zulu, call the clear-session tool with `self` and end the turn.
4. Send Zulu one line: "what phase are you in?".
5. Evidence to collect: Zulu's answer names `verify-run-1` from the injected state file, not from memory; the transcript (via the session-management export tool) shows the `SessionStart` hook output after the clear, including `Session id: <id>. Registered as tech-lead zulu.`; no permission prompt appears between steps 3 and 4.
6. Report pass or fail with the transcript excerpts. A fail on step 5's prompt check means the night-shift protocol's auto-mode line is wrong and the spec's section 4.5 stays `[OPEN]`.

### Run 2: nudge

1. Two throwaway sessions registered as `tech-lead yankee` and `tech-lead zulu`.
2. From the BA session: `/protocol throttle on` with the owner's words quoted.
3. Evidence: both transcripts show the nudge line; `.claude/state/protocols.log` has the line; `/protocol throttle off` restores and both transcripts show the second nudge.

### Run 3: night-shift dry run

1. One evening, one team, one auto-merge-eligible item at the top of the Ready column, chosen by the owner.
2. The owner says "initiate night shift protocol, back at 07:00". The BA enacts it and creates the return.
3. Morning evidence: the item's PR merged or stopped with a reason in the state file; `day-shift` is active and the log shows the scheduled return; the morning brief was produced per the runbook; every call made overnight exists as a Proposed decision file.
4. The owner reads the brief. The spec's section 6 is accepted when the owner says so, recorded as a ruling.
