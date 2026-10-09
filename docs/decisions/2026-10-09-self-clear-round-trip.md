Ruled 2026-10-08 (Brian)

# Self-clear round trip: a resume prompt, not hook injection

## Question

Can a tech lead clear itself and resume unattended in auto mode, so that night shift may be enacted? (#724, owner ruling 1A: verify the round trip first, then enact night shift.)

## Options considered

1. The hook maps the session to its registration after the clear and injects the team file. `[EST]` failed: a clear gives a new CLI session id, so the hook finds no registration (run A below).
2. The hook prints "Not registered" steps and the woken session re-registers or reclaims by itself. `[EST]` failed in the first run: the session stopped to ask the owner (#724 comment).
3. The lead drafts a resume prompt for its future self, sends it to its orchestrator, clears, and the orchestrator sends the prompt back as the wake message. `[EST]` passed (run B below).

## Ruling

Ruling 1A (verify first, then enact night shift) stands, and option 3 is the design. The owner's design ruling in chat, verbatim: "cut it down to the simple design".

## Evidence

Scope: one throwaway session ("Zulu"), auto permission mode, one machine, 2026-10-09, branch scripts at f523f743, main-checkout hook at a6d2e754. `[EST]` from the verifier's transcript reads; the raw notes are not in the repository. Run B used the f523f743 scripts, which had a `reclaim` command that was later removed; the shipped flow at the head that merges was not run end to end. The Zulu confirm on develop after the cutover is that run.

- Same desktop id before and after every clear; the CLI session id changed on each clear (runs A and B). Ids are not recorded here: the auto-mode classifier refuses messages that contain them.
- The app's PreToolUse:Write guard refuses a worktree session writing the main checkout's `.claude/`: "Edit the worktree's own .claude/ instead, or run that change from a non-worktree session."
- The auto-mode classifier refused `register` plus `handoff` under `.claude/` ("[Auto-Mode Bypass]"), and refuses a message containing session ids ("[Credential Leakage]"). Shared state therefore moved to `.hackbench-state/` and resume prompts carry no ids.
- The hook that ran after each clear is the main checkout's, not the worktree's: CLAUDE_PROJECT_DIR is the main checkout for a worktree session.
- Run A (hook-driven wake "Zulu, status?", clear about 05:27:55Z, hook 05:28:29Z): the hook printed the old "Not registered" text and Zulu asked the owner whether to register. FAIL.
- Run B (resume-prompt wake, clear about 05:35:27Z, a local settings allow rule for clear_session in place): Zulu called get_session, reclaimed its registration, read its team file from the absolute path in the prompt (phase verify-run-1), and reported to Bravo. No permission prompt or approval wait found in the post-clear transcript. PASS.
- Not observed: the clear-session tool's own result text; any case outside auto mode.

## Why

The CLI id is not stable across a clear and the hook cannot read the old one, so the identity has to travel in a message the lead wrote itself. Sending it through the orchestrator makes the wake message authoritative to the woken session.

## Applies to

`docs/agents/tech-lead.md` (Close, Waking), `docs/agents/ba.md`, `tools/scripts/protocol-inject.mjs`, spec sections 3.5, 4.5 and 8, and `docs/protocols/night-shift.md` (the Blocked line is removed). Runtime: an owner allow rule for clear_session in local settings.
