# Agentic workflow: protocols, session lifecycle and the knowledge base

Status: `[PROP]` until the owner ratifies. Designed 2026-10-07 in conversation
with the owner; every section below was approved in chat before this file was
written. Scope is this repository. The design keeps a seam for an outer shell
(Jeff's Neuromancer, a Symphony-style loop) to drive it later, but builds
nothing for that.

> **Bottom line**
>
> - A **protocol** is a named mode the owner enacts to change how normal
>   operation runs. Day shift and night shift are the first pair; throttle is
>   the third. Activating one is one command, and every session in the repo
>   sees it on its next turn without being told. `[PROP]`
> - A **tech-lead session clears itself** after its PR merges, and at any phase
>   boundary when context runs long. Its state lives in a file the hook hands
>   back on wake. The manual reset and the "hand off to a fresh session" rule
>   both retire. `[PROP]`, mechanism `[EST]` from the tool definition.
> - **`docs/` is the knowledge base.** It gains a state page, a conventions
>   contract, a decisions record, protocol definitions, runbooks and a
>   hypotheses ledger, and adopts inline epistemic tags. Rulings become files.
>   `[PROP]`
> - **Night shift gets eight refinements**, the largest being a mechanical
>   morning brief and a written definition of "safety decision". `[PROP]`

## 1. Why

Read against the Carina.Workbooks harness (a fork of this one, ported
2026-09-30, then run for a week with several team sessions), three problems
stood out, in the owner's words:

- Context piles up in persistent tech-lead sessions and makes them
  inefficient.
- There is no automated way to clear a tech lead after it merges a PR; the
  "reset after merge" rule is manual and cumbersome.
- Epistemic tags proved useful and should become the convention for a real
  knowledge base, not a habit in a few docs.

And one wish: the owner wants to "initiate night shift protocol" and have
every tech lead switch at once.

## 2. Terms

- **Owner.** Brian Engen. Ratifies rulings, enacts protocols, approves plans
  on day shift.
- **BA.** The coordinating session. Authors and files work items, keeps the
  team-to-item map, routes questions, runs the protocol command on the
  owner's words. Never implements.
- **Tech lead.** A session that runs the deliverable loop for one work item at
  a time with role subagents. Named by team (Alpha, Bravo, ...). A lone
  session is both BA and tech lead.
- **Role agents.** `.claude/agents/*`: implementer, simplify-reviewer,
  adversarial-reviewer, verifier, steward, grunt. Unchanged by this design.
- **Protocol.** A named mode with an on/off state, a fixed list of rule
  changes, and a record of who switched it. Not a procedure; procedures are
  runbooks.
- **Knowledge base.** `docs/`, under the conventions in section 5.
- **State directory.** `.claude/state/` in the main checkout, gitignored.
  Runtime state only: never knowledge.

## 3. Protocols

### 3.1 The protocol file

One file per protocol at `docs/protocols/<name>.md`, with exactly these
headings in this order, so a hook can inject part of it and a reviewer can
check all of it:

1. **Purpose.** One line.
2. **Group.** Optional. Protocols in the same group are mutually exclusive:
   activating one deactivates the others. A group may name a default member,
   which is active whenever no other member is.
3. **Activation.** Who may turn it on. Default: the owner, in chat, with the
   BA running the command on the owner's words; or an outer shell writing the
   state file. An agent may propose activation and never perform it. A
   protocol may name an exception (throttle does).
4. **Changes.** A numbered list. Each line names the standing rule it
   overrides and the replacement. Under fifteen lines; this section is what
   every session reads every turn.
5. **Unchanged.** The explicit list of rules that still apply. Carina learned
   this list is load-bearing: everything not named here is assumed changed by
   someone.
6. **Exit.** What happens on deactivation, and whether calls made under the
   protocol stay `[PROP]`. A waiver is never precedent.

### 3.2 The initial set

**`day-shift`.** Group `shift`, the default member. Changes: none; it states
the normal rules explicitly so night shift has something to override:

1. Plan gate: a tech lead posts each item's plan and waits for the owner's
   approval before implementing.
2. Questions and design calls go to the BA, which answers from the knowledge
   base or escalates to the owner.
3. After a merge the tech lead clears itself, then waits for the plan gate on
   its next item.

**`night-shift`.** Group `shift`. Changes, numbered against day shift:

1. Plan gate waived: a BA assignment is approval.
2. A non-safety question takes the recommended option, marked `[PROP]`, and
   is filed as a Proposed decision (section 5.4). Safety decisions
   (section 6.2) stop the item instead.
3. After a merge the tech lead clears itself and asks the BA "what's next"
   without waiting.
4. The queue is the Ready column, top down; needs-owner items are skipped.
5. A scope change ends the item (section 6.4).
6. Needs-owner PRs open and wait for morning (section 6.5).
7. Tech leads run in auto permission mode so clears do not block on a prompt.
8. An empty queue means idle (section 6.8).

Unchanged: the deliverable loop (simplify, adversarial review, verify, ship),
auto-merge rules, CodeRabbit handling, the content and style gates, data and
image rules, and every "never" in `CLAUDE.md`. Exit: `day-shift` returns, by
command or by the schedule in section 6.7; every `[PROP]` made overnight
stays `[PROP]` until ruled; the BA produces the morning brief (section 6.1).

**`throttle`.** No group; stacks with either shift. Activation: the owner, or
any session that receives a usage-limit error, which activates it and logs
the trigger. Changes:

1. Finish in-flight work; start no new item.
2. No heavy re-runs: Playwright, full suites and sweeps wait.
3. Prefer Haiku and tightly scoped Sonnet; no Opus except an adversarial
   review already in progress.

Exit: the owner turns it off. Nothing is `[PROP]` under throttle.

Other protocols are added when a need appears, not before.

### 3.3 State and log

`.claude/state/protocols.json`, gitignored, in the main checkout:

```json
{ "active": ["day-shift"], "changed": "2026-10-07T21:00:00Z", "by": "owner" }
```

Invariant: for every group with a default, exactly one member is in
`active`. A missing file means defaults only.

`.claude/state/protocols.log`, one appended line per change: timestamp,
protocol, on or off, by whom, and what it replaced. The morning brief reads
it.

### 3.4 The command

A repo skill, `/protocol <name> on|off`, backed by a script in
`tools/scripts/` so the file logic is testable without a session:

1. Refuse a name with no file in `docs/protocols/`.
2. `on` for a grouped protocol swaps out the other members. `off` for a
   grouped protocol activates the group default. `off` for an ungrouped one
   removes it.
3. Write the state file, append the log line.
4. List live sessions registered in this repo (section 4.2) and send each
   one line: protocol, on or off, by whom, "re-read on your next turn". The
   nudge is what starts an idle session moving; the file is what makes it
   correct.

### 3.5 The hook

`.claude/settings.json` already injects the orchestrator manual on session
start. Two additions:

- The session-start hook also prints the active protocols' Changes sections,
  and selects the manual to inject by the session's registration
  (section 4.2). It fires on startup, resume and clear. `[INF]` that the
  clear source fires it; the verifier proves it (section 8).
- A prompt-submit hook prints the active protocol names and their Changes
  sections on every turn. Cost is bounded by the fifteen-line rule.

Both resolve the main checkout from a worktree through the git common
directory, so a session in `.claude/worktrees/` reads the same state as one
in the root.

## 4. Session lifecycle

### 4.1 Manuals

`docs/agents/orchestrator.md` splits into `docs/agents/ba.md` and
`docs/agents/tech-lead.md`. Rules common to both stay in `CLAUDE.md`. A lone
session registers as both and gets both manuals.

### 4.2 Registration replaces check-in

`.claude/state/sessions.json`, gitignored, maps a session id to its role and
team:

```json
{ "<session id>": { "role": "tech-lead", "team": "alpha", "registered": "..." } }
```

On a session's first turn the hook finds no entry. The manual's first step
is: read your own title, register yourself, create your team state file
(section 4.4), and send the BA one line: "Alpha tech lead here, what's
next". The owner starts a session, titles it, and walks away. Scale-out is
one more session with one more title. If the desktop exposes a
start-session tool to the BA, the BA can do the same; that tool is referenced
by four other tool definitions but was not loaded in the design session, so
its availability is `[OPEN]`.

The BA prunes entries for sessions that no longer appear in the session list.

### 4.3 The item loop, as a tech lead runs it

1. Receive the item from the BA. Design, plan gate per the active shift,
   delegate, review, verify, ship, as the current manual says.
2. At every phase boundary, update the team state file: item, branch,
   worktree, phase, open questions, proposed calls, follow-ups. Written
   incrementally, never only at the end.
3. On merge, confirmed by a grunt polling the PR over REST: a cleanup brief to
   a grunt; any Proposed decision filed in `docs/decisions/`; the final
   handoff written to the team state file; one line to the BA naming the
   merged PR and the file.
4. Clear self, with the clear-session tool targeting `self`. The tool's own
   definition says the clear runs when the turn ends and the session is idle,
   and keeps the folder, model and permissions `[EST]`. Carina's rule that a
   session cannot clear itself is true of the slash command only.
5. First turn after waking: the hook has injected the manual, the active
   protocols and the team state file. Send the BA "what's next". Day shift
   waits for a plan gate on the new item; night shift treats the assignment
   as approval.

**Mid-item cap.** The same move works at any phase boundary. When context
passes the threshold the manual names, the tech lead confirms the state file
is current, posts one line to the BA, and clears itself. This retires "before
a session passes about 200k, write the state to the issue and hand off".

### 4.4 State files

`.claude/state/teams/<team>.md`, headed sections: Item, Branch and worktree,
Phase, Open questions, Proposed calls, Follow-ups, Last updated. Short; it
is read on every wake.

`.claude/state/ba.md`: Teams (team to item), Queue, Pending questions, Last
brief. The BA clears itself by the same mechanism when its context runs
long, and at every shift change after writing or reading the morning brief.

### 4.5 Permission mode

An unattended clear needs auto mode: the clear-session definition says the
app asks the user in default mode and may decide without asking in auto
mode `[EST]`. The night-shift protocol says tech leads run in auto mode; the
owner sets it when starting a session for night work. Whether auto mode
lets a self-clear through unattended is `[OPEN]` until the verifier shows
it (section 8).

## 5. The knowledge base is `docs/`

Modelled on the owner's Bucs project-manager research repository, which works
because of a state page, a conventions contract, inline tags and a mechanised
publishing boundary, not because of any folder name. HackBench's content gate
is the boundary; the rest is added here.

### 5.1 Layout

Every existing folder stays where it is, because code and the disassembly
cite those paths. Additions:

```
docs/
  README.md          becomes the state page: start-here, open decisions,
                     recent corrections, what is currently [PROP]
  CONVENTIONS.md     the contract: tags, citation, corrected-in-place,
                     ruled lines, file shape, what goes where
  hypotheses.md      unverified claims with evidence ledgers (H-1, H-2, ...)
  decisions/         one ruling per file, with README.md as the index
  protocols/         one protocol per file (section 3.1), README.md index
  runbooks/          methods: Mesen capture, owner launch, CI re-run,
                     the morning brief
  agents/            ba.md and tech-lead.md (section 4.1)
```

### 5.2 Conventions

- Tags sit inline at the end of the claim, never as a prefix and never in
  front matter: `[EST]` read or measured, `[INF]` inferred, `[OPEN]`
  unresolved, `[PROP]` proposed and not ratified.
- Every analysis file opens with a Bottom line blockquote and a Provenance
  table: source, identifier, as-of, retrieved. ROM claims still cite
  `SMWDisX file:line` and state evidence scope, as `docs/README.md` already
  requires.
- Correct in place: "Corrected YYYY-MM-DD: was X, because Y".
- Never promote `[PROP]` to a ruling; only the owner does, and the file
  records it.
- Machine-local and private facts (paths on the owner's machine, anything the
  content gate would refuse) stay in session memory with a one-line pointer
  into `docs/`.

### 5.3 What the knowledge base does not hold

Runtime state: the active protocol set, the session registry, team and BA
state files. Those live in `.claude/state/`, are gitignored, are written by
sessions and read by the hook, and are what an outer shell would write.

### 5.4 Decisions

`docs/decisions/YYYY-MM-DD-<slug>.md`. First line is one of:

- `Proposed YYYY-MM-DD (<team>)`, written by a tech lead under night shift or
  when a day-shift question is parked.
- `Ruled YYYY-MM-DD (Brian)`, the owner's words verbatim, with no commentary.

Then: Question, Options considered, Recommendation or ruling, Why, Applies
to. Promotion edits the first line in place. `docs/decisions/README.md`
lists one line per file. A grep for `^Proposed` is the morning brief's
input.

Rulings stop going to issues, the notes repository or session memory; those
get pointers.

### 5.5 Migration

A grunt moves the project and reference facts out of the session memory
directory into `docs/` with tags, leaves one-line pointers behind, and tags
the existing ROM docs where the evidence scope is already stated. Nothing is
rewritten, only marked. Delivered as one sample file first, then the rest on
the owner's sign-off.

## 6. Night-shift refinements

All eight approved by the owner on 2026-10-07.

1. **The morning brief is mechanical.** A runbook the BA follows, run by a
   grunt: grep `^Proposed` in `docs/decisions/`, read the protocol log, list
   merged PRs and open needs-owner PRs since night shift began, list items
   that stopped and why. Presented one decision per message, in the owner's
   decision-brief format (section 7).
2. **"Safety decision" is defined.** Anything that writes outside the repo
   beyond the pre-approved steps (opening a PR, labels, the board card),
   deletes data, changes permissions, hooks, CI or secrets, or touches
   `main`. A safety decision stops the item and goes in the handoff; it is
   never taken as `[PROP]`.
3. **The queue is the Ready column, in order.** The BA assigns top down,
   skips anything labelled needs-owner, and stops when the column is empty.
4. **A scope change ends the item.** The tech lead writes the handoff with the
   scope question as a Proposed decision and takes the next item. No
   expansion without a gate.
5. **Needs-owner PRs open and wait.** A UI change is still built, reviewed and
   verified overnight; its PR opens with the label and the launched build
   URL goes in the handoff. Only auto-merge items complete unattended.
6. **Throttle self-activates on a usage-limit error.** The one exception to
   owner-only activation, logged with the trigger.
7. **Day shift returns on a schedule.** The BA, when night shift is enacted,
   creates a scheduled trigger in its own session for the return time the
   owner names, which runs the protocol command for `day-shift`. The owner
   can extend. `[INF]` that a session-scoped cron can invoke a repo skill;
   confirmed during implementation.
8. **Empty queue means idle.** A tech lead with nothing assigned writes its
   state, posts one line, and waits for the nudge. Nobody invents work.

## 7. Decision-brief format

Recorded here because the owner asked for it to be reused. One decision per
message when walking through them, numbered "Decision 1 of 4: <title>". A
one-line brief, then two or three context bullets. Options as bold lettered
bullets, exactly one marked recommended, each with nested Pros and Cons.
"Recommendation: <letter>" with one sentence of reason. Close with how to
answer and what the next decision is. Never tables. Describe things by
content, with any number in parentheses after. Hedged rulings are firm.

## 8. Verification

Each oracle below has a committed test that goes red on a planted defect, as
the quality gates require.

- **Protocol script.** Unit tests: unknown name refused; grouped `on` swaps
  the sibling out; grouped `off` restores the default; ungrouped `off`
  removes; the log line is appended; a missing state file reads as defaults.
- **Hook output.** A test writes a state file and asserts the injected text
  contains each active protocol's Changes section and nothing from inactive
  ones. Lands beside the existing lint-gate test.
- **Self-clear round trip.** The verifier, on a throwaway session in auto
  mode: register, write a team state file, clear self, confirm from the
  transcript that the hook fired after the clear and injected the file, and
  that no permission prompt blocked. This is the load-bearing `[OPEN]` in
  sections 3.5 and 4.5; nothing ships to night use until it is `[EST]`.
- **Nudge.** The command run against two registered throwaway sessions; both
  transcripts show the line.
- **Night-shift dry run.** One evening, one team, one auto-merge item from
  the Ready column, with the owner reading the morning brief. The acceptance
  test for section 6.

## 9. Delivery

Four pull requests, in order, each one concern:

1. **This spec.** Docs only.
2. **Knowledge base scaffolding.** `CONVENTIONS.md`, the README state page,
   `decisions/`, `protocols/` with the three initial files, `runbooks/`,
   `hypotheses.md`, the memory migration. Docs only; about 400 lines.
3. **Protocol mechanism.** State directory and gitignore, the script, the
   skill, both hooks, the tests. Code; about 300 lines plus tests. Full
   review and verify.
4. **Manuals and lifecycle.** `ba.md`, `tech-lead.md`, registration, the
   self-clear steps, the morning-brief runbook, retirement of the rules this
   design replaces. Docs only; about 300 lines. Depends on 3.

Then the self-clear round trip and the night-shift dry run from section 8,
which are verification runs, not PRs.

## 10. Out of scope and open

- Cross-repo protocols and a user-level state file. The owner scoped this to
  the repository; Carina ports it afterwards.
- Neuromancer. The seam is the state directory and the protocol files; no
  code here targets it. `[OPEN]` what runner it uses for Claude Code.
- A start-session tool for the BA (section 4.2). `[OPEN]`
- Whether a session-scoped cron can run a repo skill (section 6.7). `[OPEN]`
- Auto mode and unattended self-clear (section 4.5). `[OPEN]`
