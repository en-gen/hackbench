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
 * - A test env built WITHOUT spreading process.env loses all of this and is
 *   outside the guard.
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
  const out = { ...env, GH_CONFIG_DIR: configDir }
  for (const v of TOKEN_VARS) out[v] = SENTINEL
  return out
}

export default function setup(): (() => void) | void {
  // Idempotent only while the dir still exists AND leads PATH; a stale value
  // inherited from a dead run must not suppress installation.
  const cur = process.env.HB_NO_REAL_GH_DIR
  if (cur && fs.existsSync(cur) && (process.env.PATH ?? '').startsWith(cur + path.delimiter)) return

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

  Object.assign(process.env, guardEnv({}, config))
  process.env.HB_NO_REAL_GH_DIR = dir.replaceAll(path.sep, '/')
  process.env.PATH = process.env.HB_NO_REAL_GH_DIR + path.delimiter + (process.env.PATH ?? '')

  return () => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.HB_NO_REAL_GH_DIR
  }
}
