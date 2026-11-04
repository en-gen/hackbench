// Where the shared session state lives (#1202). A leaf module so protocol.mjs
// and run-lock.mjs, which import each other's neighbors, share ONE resolver.
//
// The desktop app guards .claude/ against session writes from a worktree, so
// shared state lives in a folder of its own in the main checkout. It was
// .hackbench-state; the owner moved it to .overwatch (inside the repo,
// gitignored). Until `protocol.mjs cutover-state` runs, the old name is the
// live one, so merging this change moves nothing.

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export const STATE_DIR_NAME = '.overwatch'
export const OLD_STATE_DIR_NAME = '.hackbench-state'

export function mainCheckoutDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout.trim()) return cwd
  return path.dirname(path.resolve(cwd, r.stdout.trim()))
}

// Order: explicit override, an existing .overwatch, an existing .hackbench-state,
// else the new name (a fresh clone). After cutover both names reach the same
// files (the old one is a link), so a session still on old-path code agrees.
export function resolveStateDir(main, env = process.env, exists = existsSync) {
  if (env.HACKBENCH_STATE_DIR) return env.HACKBENCH_STATE_DIR
  for (const name of [STATE_DIR_NAME, OLD_STATE_DIR_NAME]) {
    const dir = path.join(main, name)
    if (exists(dir)) return dir
  }
  return path.join(main, STATE_DIR_NAME)
}
