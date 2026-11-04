# Cut over the session state folder

**Read first: `git clean -x` and this folder.** Measured on a scratch repo (Git 2.54, Windows, 2026-11-03; details in docs/testing.md, "Nested folders and `git clean`"): `git clean -fdx` in the main checkout deletes `.overwatch` (sessions, protocol state and history, handoffs, held lock slots) and skips the worktrees in `.worktrees/`. `git clean -ffdx` also deletes every worktree in `.worktrees/`, **uncommitted work included**; their branches survive. Never run either in the main checkout.

Use once, after the PR that introduces `.overwatch` (#1202) has merged and the main checkout has synced to develop. The earlier cutover, from `.claude/state/` to `.hackbench-state/` (#725), is done; `migrate-state` still exists for that history.

Until this runs nothing changes. The shared resolver (`tools/scripts/state-dir.mjs`) answers, in order: `HACKBENCH_STATE_DIR`; `.overwatch` when it holds `sessions.json` (live state always does, and the rename carries it), even if a real `.hackbench-state` exists beside it; a REAL `.hackbench-state`; else `.overwatch`. So a merged-but-not-cut-over checkout keeps using the old folder, and a stray `.overwatch` (empty, or a killed gate run's leftovers, with no `sessions.json`) cannot take over. A fresh clone, and a checkout where old code recreated a real `.hackbench-state` after cutover, stay on `.overwatch`.

Every command below is given for PowerShell and for a POSIX shell (Git Bash, macOS, Linux). Run them from the MAIN checkout.

## Steps

1. Make sure no run-lock slot is held: `node <main>/tools/scripts/run-lock.mjs status`. The command checks all slots too and refuses if one is held.
2. From the MAIN checkout (not a worktree), with `HACKBENCH_STATE_DIR` unset, run `node tools/scripts/protocol.mjs cutover-state`. It renames `.hackbench-state` to `.overwatch` and leaves a directory junction (symlink off Windows) at the old name.
3. Confirm with `node tools/scripts/protocol.mjs status`: `stateDir` must be `<main>/.overwatch`, with the same registered sessions as before. Re-running `cutover-state` prints `already cut over` and changes nothing.
4. Keep the old-name link until no pre-#1202 code can run: no worktree AND no open PR branch without #1202 merged. Old code on a removed link writes a separate real folder, and two sessions can then hold the same run-lock slot. Run `git fetch origin` first. Sync or finish every worktree and PR the checks name.

   Worktrees (prints `OLD CODE: <path>` per worktree without #1202):

   ```powershell
   git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { $p = $_.Substring(9); if (-not (Test-Path "$p/tools/scripts/state-dir.mjs")) { "OLD CODE: $p" } }
   ```

   ```bash
   git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r p; do [ -f "$p/tools/scripts/state-dir.mjs" ] || echo "OLD CODE: $p"; done
   ```

   Open PR branches. The #1202 commit is the one that added `state-dir.mjs` to `origin/develop`. The check prints `SAFE` only if the fetch and `gh` succeeded, that commit was found, fewer than 200 PRs are open, and every open PR contains it. Anything else prints `NOT SAFE`, and each PR without the commit prints `OLD CODE: PR <n>` (a head git cannot find counts as old).

   ```powershell
   git fetch origin; $f = $LASTEXITCODE
   $m = git log --diff-filter=A --format=%H origin/develop -- tools/scripts/state-dir.mjs | Select-Object -Last 1
   $LASTEXITCODE = 99; $j = gh pr list --state open --limit 200 --json number,headRefOid; $g = $LASTEXITCODE
   $prs = @(if ($g -eq 0) { $j | ConvertFrom-Json })
   $bad = $f -ne 0 -or $g -ne 0 -or -not $m -or $prs.Count -ge 200
   if (-not $bad) { foreach ($pr in $prs) { git merge-base --is-ancestor $m $pr.headRefOid 2>$null; if ($LASTEXITCODE -ne 0) { "OLD CODE: PR $($pr.number)"; $bad = $true } } }
   if ($bad) { 'NOT SAFE: do not remove the link' } else { 'SAFE' }
   ```

   ```bash
   git fetch origin && M=$(git log --diff-filter=A --format=%H origin/develop -- tools/scripts/state-dir.mjs | tail -1) && [ -n "$M" ] && PRS=$(gh pr list --state open --limit 200 --json number,headRefOid --jq '.[]|"\(.number) \(.headRefOid)"') && [ "$(printf '%s\n' "$PRS" | grep -c .)" -lt 200 ] && { BAD=0; while read -r n sha; do [ -n "$n" ] || continue; git merge-base --is-ancestor "$M" "$sha" 2>/dev/null || { echo "OLD CODE: PR $n"; BAD=1; }; done <<< "$PRS"; [ "$BAD" = 0 ] && echo SAFE; } || echo 'NOT SAFE: do not remove the link'
   ```

   Remove the link only when the PR check printed `SAFE` and the worktree check printed nothing. Both forms remove the link and leave the files, and both refuse a real non-empty folder:

   ```powershell
   [System.IO.Directory]::Delete((Join-Path $PWD '.hackbench-state'))
   ```

   ```bash
   rm .hackbench-state
   ```

## What it refuses (nothing is moved)

- A held run-lock slot (slot 1, 2 or 3, any that exist).
- A real `.hackbench-state` with no `sessions.json`: the resolvers use that file as the sign of a live folder, so it is not one. Find out why it is missing before anything else.
- A real `.hackbench-state` beside a non-empty `.overwatch`. Two messages, by whether `.overwatch` holds `sessions.json`; see Recovery. An EMPTY `.overwatch` counts as absent and is removed first.
- `.hackbench-state` already a link, but not to this repo's `.overwatch`.
- `HACKBENCH_STATE_DIR` set, or a worktree as the working directory.

## Recovery

Find the entry by the message you got. For the two refusals, run the check that opens the entry before doing anything else: the two cases call for opposite actions, and following the wrong one deletes live state.

- **"`.hackbench-state` is the live state and `.overwatch` is a stray".** Check: `.overwatch/sessions.json` does NOT exist (PowerShell `Test-Path .overwatch/sessions.json`; POSIX `[ -f .overwatch/sessions.json ] && echo yes || echo no`). Nothing moved. Look inside `.overwatch` (`Get-ChildItem -Force .overwatch` / `ls -A .overwatch`): it should be leftovers, such as a killed gate run's plants. Remove it (`Remove-Item -Recurse -Force .overwatch` / `rm -r .overwatch`), then run `cutover-state` again. If `sessions.json` exists, this is the other entry; do not remove anything.
- **"`.overwatch` is the live state and a real `.hackbench-state` was recreated".** Check: `.overwatch/sessions.json` DOES exist, and `.hackbench-state` is a real folder, not a link (PowerShell `(Get-Item .hackbench-state -Force).LinkType` prints nothing for a real folder; POSIX `[ -L .hackbench-state ] && echo link || echo "real folder"`). Pre-#1202 code recreated the old name after cutover, or a cutover crashed between the rename and the link. Nothing moved. Reconcile by hand with no session mid-command:
  1. For each file the recreated folder holds, compare it with the same-named file in `.overwatch` and keep the newer one. `sessions.json` and `protocols.json` are maps keyed by id: merge by key, add the keys `.overwatch` lacks, and on a clash keep the newer entry. Never copy either file wholesale over `.overwatch`'s. Copy files `.overwatch` lacks (handoffs, protocol history) as they are.
  2. Check the recreated folder for a held run-lock slot: list its `locks/` (`Get-ChildItem -Recurse .hackbench-state/locks` / `ls -R .hackbench-state/locks`). `run-lock status` from new code reads `.overwatch` and will not show it. A `run`, `run-2` or `run-3` folder there with an `owner.txt` is a held slot; wait for that session or ask its owner.
  3. Only after step 1 is done, remove the recreated real `.hackbench-state` and nothing else (`Remove-Item -Recurse -Force .hackbench-state` / `rm -r .hackbench-state`; never `.overwatch`). Re-check first that it is a real folder, not a link.
  4. Run `cutover-state`; with `.overwatch` present and no `.hackbench-state` it creates the link.
- **Rename fails** (a process holds a file in the folder): the message says the original was left in place. Close the holder, run again.
- **Link fails after the rename:** the message says the rename was undone. Fix the cause and run again.
- **Link fails AND the undo fails:** the folder is at `.overwatch` with no old name. Run `cutover-state` again: with `.overwatch` present and no `.hackbench-state` it finishes by creating the link. If a real `.hackbench-state` has appeared meanwhile, use the second entry above.
- Check-then-rename is not atomic. Run it when no session is starting.

## Rollback

With no lock slot held and no session mid-command (a hook-driven session registration counts as a command, so no session may be starting). Do not delete `.overwatch` first.

1. Check what the old name is. PowerShell: `(Get-Item .hackbench-state -Force).LinkType` prints `Junction` or `SymbolicLink` for a link, nothing for a real folder, and an error when there is no folder (`Test-Path .hackbench-state` is False). POSIX: `[ -L .hackbench-state ] && echo link || { [ -e .hackbench-state ] && echo "real folder" || echo none; }`.
2. If `.overwatch/sessions.json` is absent, stop: you are already on the old folder and there is nothing to roll back (going on would delete the only copy). Otherwise, if it is a link, remove the link only; if there is none, go on. If it is a REAL folder, reconcile first (Recovery, second entry, steps 1 to 3 on that folder) and remove it: `mv` onto an existing folder nests `.overwatch` inside it instead of renaming it.

   ```powershell
   [System.IO.Directory]::Delete((Join-Path $PWD '.hackbench-state'))
   ```

   ```bash
   rm .hackbench-state
   ```

3. Rename the live folder back:

   ```powershell
   Move-Item .overwatch .hackbench-state
   ```

   ```bash
   mv .overwatch .hackbench-state
   ```

## Why it is safe

Sessions on old-path code (reading `.hackbench-state`) and new code (reading `.overwatch`) see the same files through the link, including run-lock slots; `stateCutover.test.ts` proves both directions on temp folders.
