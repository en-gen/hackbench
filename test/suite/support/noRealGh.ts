/**
 * Vitest globalSetup: runs once before workers fork, so no unit test can
 * reach the real, authenticated GitHub CLI (issue #486: a test ran accept.sh
 * and posted real perf-nightly statuses). It puts a `gh` that always fails
 * first on PATH (a bash shim and a gh.cmd for cmd.exe) and strips every
 * credential: token variables are deleted (an invalid token would still make
 * a network call) and GH_CONFIG_DIR points at an empty dir, hiding the
 * keyring login. A test that needs a `gh` builds its own and prepends its own
 * directory, which wins over this one.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const MESSAGE =
  'gh blocked: unit tests must not reach the real gh (#486); put a fake gh first on PATH'

export default function setup(): (() => void) | void {
  if (process.env.HB_NO_REAL_GH_DIR) return // already installed (idempotent)

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

  for (const v of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
    delete process.env[v]
  }
  process.env.GH_CONFIG_DIR = config
  process.env.HB_NO_REAL_GH_DIR = dir.replaceAll(path.sep, '/')
  process.env.PATH = process.env.HB_NO_REAL_GH_DIR + path.delimiter + (process.env.PATH ?? '')

  return () => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.HB_NO_REAL_GH_DIR
  }
}
