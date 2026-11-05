// Where the shared session state lives (#1202). A leaf module so protocol.mjs
// and run-lock.mjs share ONE resolver; it imports neither, so protocol.mjs can
// import run-lock.mjs (for cutover-state) without a cycle.
//
// The desktop app guards .claude/ against session writes from a worktree, so
// shared state lives in a folder of its own in the main checkout. It was
// .hackbench-state; it is becoming .overwatch (inside the repo, gitignored).
// A REAL .hackbench-state folder stays the live one until `protocol.mjs
// cutover-state` turns it into a link, so merging this change moves nothing
// and a stray .overwatch cannot take over. Live state always holds
// sessions.json (the rename carries it), so that file is what says
// .overwatch is live: a fresh clone, or old code that recreates a real
// .hackbench-state after cutover, cannot pull new-code sessions onto it.

import { existsSync, lstatSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export const STATE_DIR_NAME = '.overwatch'
export const OLD_STATE_DIR_NAME = '.hackbench-state'
export const SESSIONS_FILE = 'sessions.json'

export function mainCheckoutDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout.trim()) return cwd
  return path.dirname(path.resolve(cwd, r.stdout.trim()))
}

const isRealDir = p => {
  try {
    const st = lstatSync(p)
    return st.isDirectory() && !st.isSymbolicLink() // a junction reports as a link
  } catch {
    return false
  }
}

// Order: explicit override; .overwatch once it holds sessions.json (even beside
// a real old folder); a REAL .hackbench-state (not yet cut over); else
// .overwatch. A .overwatch without sessions.json beside a real old folder is a
// stray (empty, or a killed gate run's leftovers), so the old folder still wins
// there. After cutover both names reach the same files, so a session still on
// old-path code agrees with one on new code.
export function resolveStateDir(main, env = process.env) {
  if (env.HACKBENCH_STATE_DIR) return env.HACKBENCH_STATE_DIR
  const neu = path.join(main, STATE_DIR_NAME)
  if (existsSync(path.join(neu, SESSIONS_FILE))) return neu
  const old = path.join(main, OLD_STATE_DIR_NAME)
  return isRealDir(old) ? old : neu
}
