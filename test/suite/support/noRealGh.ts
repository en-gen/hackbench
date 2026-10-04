/**
 * Vitest globalSetup: runs once before workers fork, so no unit test can
 * reach an AUTHENTICATED GitHub CLI (issue #486: a test ran accept.sh and
 * posted real perf-nightly statuses). Guarantee, and its limits:
 * - A `gh` that always fails is first on PATH (bash shim plus gh.cmd). A
 *   no-shell spawn on win32 skips both and runs the real gh.exe, so that path
 *   is NOT blocked; it is made harmless instead.
 * - The four token variables are set to a sentinel. Env tokens beat the
 *   keyring, and the global git credential helper is an absolute path to
 *   gh.exe, so an empty GH_CONFIG_DIR alone hides nothing: a reached gh
 *   (or `git credential fill`) sees only the sentinel, which GitHub rejects.
 * - Git credential helpers are cleared at command scope (GIT_CONFIG_* and
 *   GIT_CONFIG_PARAMETERS, which `git -c` exports to children), and
 *   GIT_ASKPASS/SSH_ASKPASS are emptied, so `git credential fill` returns no
 *   password from a helper or an askpass program in the env. An askpass set
 *   by `-c core.askPass` on the command line is overridden by the empty
 *   GIT_ASKPASS (checked by test), not by this file.
 * - Outside the guard: a test that blanks or deletes the token variables, or
 *   builds an env without spreading process.env.
 * A test that needs a `gh` builds its own and prepends its own directory.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const MESSAGE =
  'gh blocked: unit tests must not reach the real gh (#486); put a fake gh first on PATH'

export const SENTINEL = 'hb-no-real-gh-486'
export const TOKEN_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]

/** Pure: the credential part of the guard, applied to any env. */
export function guardEnv(env: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  const out = {
    ...env,
    GH_CONFIG_DIR: configDir,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  }
  for (const v of TOKEN_VARS) out[v] = SENTINEL
  // An empty credential.helper resets the list, so no helper (gh.exe, manager) runs.
  // Appended after any existing GIT_CONFIG_* entries; a later entry would re-add
  // a helper, so the append is skipped only when the LAST entry (n-1) is exactly
  // an empty credential.helper. URL-scoped keys never count: they scope a helper
  // to one host instead of resetting the list. Any case spelling of the key is
  // accepted as exact, because git lowercases section and variable names.
  const raw = env.GIT_CONFIG_COUNT
  const n = raw === undefined || raw === '' ? 0 : Number(raw)
  if (!Number.isInteger(n) || n < 0 || n >= 1000) throw new Error('invalid GIT_CONFIG_COUNT')
  const done =
    n > 0 &&
    env[`GIT_CONFIG_KEY_${n - 1}`]?.toLowerCase() === 'credential.helper' &&
    env[`GIT_CONFIG_VALUE_${n - 1}`] === ''
  if (!done) {
    out[`GIT_CONFIG_KEY_${n}`] = 'credential.helper'
    out[`GIT_CONFIG_VALUE_${n}`] = ''
    out.GIT_CONFIG_COUNT = String(n + 1)
  }
  // git reads GIT_CONFIG_PARAMETERS (what `git -c k=v` exports to children) AFTER
  // GIT_CONFIG_*, so it can re-add a helper; append the reset there too, once.
  const reset = "'credential.helper'=''"
  const params = env.GIT_CONFIG_PARAMETERS ?? ''
  if (!params.endsWith(reset)) out.GIT_CONFIG_PARAMETERS = params ? `${params} ${reset}` : reset
  return out
}

/**
 * Fail-closed self-check for a test that must never reach a real gh. Marker
 * variables alone are forgeable (a made-up dir put on PATH passed), so it also
 * demands the dir exists with both shims and the token holds the sentinel.
 */
export function assertGuardActive(env: NodeJS.ProcessEnv): void {
  const dir = env.HB_NO_REAL_GH_DIR
  const ok =
    !!dir &&
    (env.PATH ?? '').startsWith(dir + path.delimiter) &&
    fs.existsSync(path.join(dir, 'gh')) &&
    fs.existsSync(path.join(dir, 'gh.cmd')) &&
    env.GH_TOKEN === SENTINEL
  if (!ok)
    throw new Error('noRealGh guard inactive (#486): register it as globalSetup, refusing to run')
}

export default function setup(): (() => void) | void {
  // Idempotent only while the dir still exists AND leads PATH; a stale value
  // inherited from a dead run must not suppress installation.
  const cur = process.env.HB_NO_REAL_GH_DIR
  if (cur && fs.existsSync(cur) && (process.env.PATH ?? '').startsWith(cur + path.delimiter)) {
    // Only shim creation is idempotent; the env is re-applied every time.
    Object.assign(process.env, guardEnv(process.env, process.env.GH_CONFIG_DIR ?? cur))
    return
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-nogh-'))
  fs.writeFileSync(
    path.join(dir, 'gh'),
    ['#!/usr/bin/env bash', `echo "${MESSAGE}" >&2`, 'exit 99', ''].join('\n'),
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(dir, 'gh.cmd'),
    ['@echo off', `echo ${MESSAGE} 1>&2`, 'exit /b 99', ''].join('\r\n'),
  )
  const config = fs.mkdtempSync(path.join(dir, 'config-'))

  Object.assign(process.env, guardEnv(process.env, config))
  process.env.HB_NO_REAL_GH_DIR = dir.replaceAll(path.sep, '/')
  process.env.PATH = process.env.HB_NO_REAL_GH_DIR + path.delimiter + (process.env.PATH ?? '')

  return () => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.HB_NO_REAL_GH_DIR
  }
}
