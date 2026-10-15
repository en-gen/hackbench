#!/usr/bin/env node
// The shared test-run lock (#923): one directory in the main checkout's state
// dir so full unit runs, Theia builds and Playwright never overlap (timeouts
// in #485, #771). Not protocol.mjs withStateLock: that is a short-lived file
// lock with a 10 s stale takeover, and this one is held for minutes and must
// never be taken over. Only the owner removes it; a stale lock is reported.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stateDirFor } from './protocol.mjs'

export const STALE_MINUTES = 120
const USAGE =
  'usage: run-lock.mjs acquire --owner "<team> <worktree>" --purpose "<text>" | release --owner "<id>" | status'

const lockDir = s => path.join(s, 'locks', 'run')
const ownerFile = s => path.join(lockDir(s), 'owner.txt')
const nextFile = s => path.join(s, 'locks', 'next.txt')
const readOwner = s => (existsSync(ownerFile(s)) ? readFileSync(ownerFile(s), 'utf8') : '')
const field = (text, key) => text.match(new RegExp(`^${key}: ?(.*)$`, 'm'))?.[1].trim()

export function acquire(stateDir, { owner, purpose = '', now = new Date() }) {
  const team = owner.split(/\s+/)[0].toLowerCase()
  const next = existsSync(nextFile(stateDir)) ? readFileSync(nextFile(stateDir), 'utf8') : ''
  if (next && !next.toLowerCase().includes(team)) {
    return { ok: false, message: `reserved for another team:\n${next.trim()}` }
  }
  mkdirSync(path.dirname(lockDir(stateDir)), { recursive: true })
  try {
    mkdirSync(lockDir(stateDir)) // non-recursive: EEXIST is the atomic "held"
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    return { ok: false, message: `held:\n${readOwner(stateDir).trim()}` }
  }
  writeFileSync(
    ownerFile(stateDir),
    `owner: ${owner}\npurpose: ${purpose}\nstarted: ${now.toISOString()}\n`,
  )
  if (next) rmSync(nextFile(stateDir), { force: true })
  return { ok: true, message: `acquired by ${owner}` }
}

export function release(stateDir, { owner }) {
  if (!existsSync(lockDir(stateDir))) return { ok: false, message: 'no lock held' }
  const text = readOwner(stateDir)
  const holder = field(text, 'owner')
  if (holder === undefined || holder !== owner.trim()) {
    return { ok: false, message: `not the owner, lock left intact:\n${text.trim()}` }
  }
  rmSync(lockDir(stateDir), { recursive: true, force: true })
  return { ok: true, message: 'released' }
}

export function status(stateDir, { now = new Date() } = {}) {
  if (!existsSync(lockDir(stateDir))) return { held: false, stale: false, lines: ['free'] }
  const text = readOwner(stateDir)
  const started = Date.parse(field(text, 'started') ?? '')
  const ageMinutes = Number.isNaN(started) ? null : Math.floor((now.getTime() - started) / 60000)
  const stale = ageMinutes !== null && ageMinutes > STALE_MINUTES
  const lines = [...text.trim().split('\n'), `age: ${ageMinutes ?? 'unknown'} min`]
  if (stale) lines.push(`STALE (over ${STALE_MINUTES} min): report it to the BA, never remove it`)
  return { held: true, stale, ageMinutes, lines }
}

export function cli(argv, stateDir) {
  const [cmd, ...rest] = argv
  const opt = name => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : undefined
  }
  const owner = opt('owner')
  if (cmd === 'status') return { code: 0, out: status(stateDir).lines.join('\n') }
  if ((cmd === 'acquire' || cmd === 'release') && owner) {
    const r =
      cmd === 'acquire'
        ? acquire(stateDir, { owner, purpose: opt('purpose') ?? '' })
        : release(stateDir, { owner })
    return { code: r.ok ? 0 : 1, out: r.message }
  }
  return { code: 1, out: USAGE }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, out } = cli(process.argv.slice(2), path.join(stateDirFor(process.cwd())))
  console.log(out)
  process.exitCode = code
}
