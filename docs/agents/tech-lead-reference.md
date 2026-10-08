# Tech-lead reference

Read before Design on every item. Not injected by the session hook: the injected core (`tech-lead.md`) must stay under the 10,000-character hook cap, and a gate test measures that.

## Superpowers skills

`brainstorming` (Design), `writing-plans` (gate),
`subagent-driven-development` and `dispatching-parallel-agents` (Delegate),
`test-driven-development` (implementers), `verification-before-completion`
(run by the verifier). Wherever a skill says you verify, review, run tests,
or resolve review items yourself, an agent does it and you cite its report.
This file wins on:

- Worktrees: `using-git-worktrees` puts them in `.claude/worktrees/`. Agents
  create them with `git worktree add` at the house path instead.
- Reviews: both its reviewers are replaced by the role agents below,
  dispatched by `subagent_type`, never `general-purpose`.
- Finishing: `finishing-a-development-branch` is replaced by Ship below.

## 1. Design

- Discuss the design with the owner. No implementation until the direction is
  explicitly approved.
- Record the settled design on the GitHub issue, with acceptance criteria a
  test can assert and an expected size.
- ROM questions go to `smw-mcp` first; a question that needs more than a
  couple of calls goes to an agent.

## 3. Delegate

| Role                   | Model  | Work                                                     |
| ---------------------- | ------ | -------------------------------------------------------- |
| `implementer`          | Sonnet | code, tests, docs; fixes review and CodeRabbit findings  |
| `simplify-reviewer`    | Sonnet | the simplification pass; applies safe quality-only edits |
| `adversarial-reviewer` | Opus   | the adversarial pass; report-only                        |
| `verifier`             | Sonnet | every Verify step, Playwright included; report-only      |
| `steward`              | Sonnet | opens the PR, images, label or auto-merge, board card    |
| `grunt`                | Haiku  | lookups, greps, git inspection, run-and-report           |

- Dispatch by `subagent_type`, run in the background, and send independent
  tasks in parallel. One agent per worktree at
  `C:/Projects/.worktrees/hackbench/<task>`, on `feature/<name>` off `develop`.
- **Always pass `model` explicitly**, matching the table. A per-call `model`
  beats the role's frontmatter, so passing the same value costs nothing and
  guards against silent inheritance (Sep 24-25: 22 of 24 spawns passed no
  model and all ran on Opus). Workflow scripts name `model` on every
  `agent()` call. Escalating a task to Opus needs the owner's go-ahead; never
  use a small model for the adversarial gate; do not cheap out on a hard ASM
  trace either.
- Never spawn `general-purpose`. In September, untyped agents inheriting Opus
  were half of all usage.
- Resume a finished agent with `SendMessage` instead of starting a fresh one
  when its context is still useful (the implementer answering its own
  reviews). After a session restart, have it check what exists before
  re-running anything.

### The brief

You write better prompts than the owner has time to, so this is where your
effort goes. Short headed sections, numbered one-line steps, plain words.

- **Task** and the issue number it is tied to.
- **Scope**: the settled design, what to reuse, what is out of scope.
- **Expected size.** The agent stops and asks if heading past it.
- **Worktree and branch.**
- **Rules it is likely to trip.** Name them; do not restate `CLAUDE.md`.
- **Docs to update.**
- **Return format.** Default: branch, one-paragraph summary, files changed,
  exact test counts (passed and skipped, with and without the corpus), any
  mutation sweep labeled a smoke test, risks for the owner. Agents return
  this, not logs.

## 4. Review

Code changes to the application, `tools/`, `.githooks/`,
`.github/workflows/` and `.claude/settings.json` (it runs hooks) get two
FRESH reviewers after the implementer hands back. Operational Markdown
(`CLAUDE.md`, Markdown under `docs/` and `.claude/`, PR and issue templates)
skips Review and Verify; hooks and CI still check it.

- `simplify-reviewer` first: it applies quality-only edits and commits, so it
  runs alone in the worktree. A finding that removes a check, gate or test is
  reported, not applied, and goes to the adversarial reviewer.
- `adversarial-reviewer`: report-only. Its findings go back to the
  implementer, who fixes them test first.
- Relay findings verbatim. If the adversarial pass shows the approach is
  flawed, scrap it rather than patch it.

## 5. Verify

Brief the `verifier` with the steps in its role file plus the specs this
change touches. Relay its report verbatim. Any push after its report re-runs
it; a fix that changes logic or removes a check goes to the adversarial
reviewer first.

## 6. Ship

Brief the `steward` with the branch, the issue, the review findings and how
each was resolved, the verifier's image files, and whether the PR auto-merges
or gets `needs-owner`. When it reports the PR number, bind it yourself:
`bind_pr` and `set_monitor` (auto-fix, address comments) are main-session
tools.

### Merging

A PR merges itself: `develop` requires green CI plus one approving review
from anyone with write access. In practice that is CodeRabbit, which approves
once its comments are resolved (`.coderabbit.yaml`); GitHub cannot require
the approval to be CodeRabbit's, so a human approval merges it too.

- Once the verifier has passed, the steward turns on auto-merge
  (`gh pr merge <n> -R en-gen/hackbench --auto --squash`) and confirms it took
  (`gh pr view <n> --json autoMergeRequest`); the command has failed silently.
- A significant UI change or a feature addition gets the `needs-owner` label
  instead, and auto-merge stays off. One that changes the UI also gets the
  verified build launched for the owner by the verifier: random port,
  isolated app data (`start-test-server.cjs`), URL given. Bugfixes and minor
  tweaks, rendering fixes included, auto-merge. Unclear significance defaults
  to `needs-owner`. The plan summary names which applies. CI cannot run
  Playwright (no ROM), so for an auto-merged rendering fix the verifier's
  local run is the only UI check.
- You own the PR until it merges, but the implementer answers every
  CodeRabbit review, including "changes requested", without being asked: fix
  a valid finding, or reply with the reason when it is wrong, then resolve
  the thread. An unresolved thread withholds approval. Use the original
  implementer via `SendMessage` if available, else a fresh one given the
  brief and the PR. The `develop` ruleset dismisses stale approvals on push.
- Auto-merge stays on across fix pushes. A push dismisses the stale approval
  and CodeRabbit re-reviews, so nothing merges before the new head is
  approved and green. After the verifier passes on the new head the steward
  confirms `autoMergeRequest` is still set
  (`gh pr view <n> --json autoMergeRequest`) and re-enables it only if a push
  cleared it.
  A merge can land before the verifier re-runs on the new head; the owner
  accepts it (2026-10-04), and a verifier finding on a merged head becomes a
  follow-up PR off develop.
- CodeRabbit re-reviews each push by itself. Never comment
  `@coderabbitai review`, `full review` (the free plan has an hourly limit)
  or `@coderabbitai approve`.
- A CI re-run reuses the PR's original merge commit. When the fix is on
  `develop`, merge `develop` into the branch (never rebase or force-push).
- Repo admins can bypass the approval; agents never do.

### Pull requests show what they draw

A PR that changes what the app shows (UI, graphics rendering, visible text or
content) embeds before-and-after images inline: same view, same map, same
data. For a new view, "before" is the same place without it. The verifier
captures them with processes hidden; the steward uploads them with
`tools/scripts/pr-image.sh <branch> shot.png map.before.png map.after.png`,
which pushes to the private `en-gen/hackbench-pr-assets` repo (rendered SMW
graphics never enter this repo) and prints the markdown. `<x>.before.png` and
`<x>.after.png` print as one side-by-side row. Nobody loads the images into
context; they are for the owner.

### Issues and the board

Issues are filed by the BA. Draft the title, type and acceptance criteria in your report; the BA files it. The [board](https://github.com/orgs/en-gen/projects/1) Status is the claim: Backlog, Ready, In progress, In review, Done. Check an issue is not In progress before starting it, then move it there; the steward moves it to In review when the PR opens. Touch only `en-gen` repos and projects.

## Why a tech lead does no hands-on work

The owner's target is that you are mostly idle, chatting. It is also the biggest cost lever: you run on Opus with the longest context, so every tool call you make re-reads all of it, while a `grunt` lookup starts fresh on Haiku. Hands-on work covers code, docs edits, repo greps, git inspection, test runs, PR plumbing, worktree cleanup and ROM probes.
