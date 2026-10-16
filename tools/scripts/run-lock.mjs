#!/usr/bin/env node
// The shared test-run lock (#923): one directory in the shared state dir
// (protocol.mjs stateDirIn) so full unit runs, Theia builds and Playwright never overlap (timeouts
// in #485, #771). Not protocol.mjs withStateLock: that is a short-lived file
// lock with a 10 s stale takeover, and this one is held for minutes and must
// never be taken over. Only the owner removes it; a stale lock is reported.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mainCheckoutDir, stateDirIn } from './protocol.mjs'

export const STALE_MINUTES = 120
const USAGE =
  'usage: run-lock.mjs acquire --owner "<team> <worktree>" --purpose "<text>" | release --owner "<id>" | status'

const lockDir = s => path.join(s, 'locks', 'run')
const ownerFile = s => path.join(lockDir(s), 'owner.txt')
const nextFile = s => path.join(s, 'locks', 'next.txt')
const readText = file => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return '' // absent or unreadable: callers treat both as no text
  }
}
const field = (text, key) => text.match(new RegExp(`^${key}: ?(.*)$`, 'm'))?.[1].trim()
const fail = message => ({ ok: false, message })
// No line breaks (CR, LF, U+2028/9): they would forge an `owner:` line.
const badText = v => typeof v !== 'string' || /[\r\n\u2028\u2029]/.test(v)
const badOwner = v => badText(v) || v.trim() === '' || v !== v.trim()
// Team = leading letters of the owner's first word ("xray-909" is "xray").
const teamOf = owner => owner.toLowerCase().match(/^[a-z]+/)?.[0]

export function acquire(
  stateDir,
  { owner, purpose = '', now = new Date(), write = writeFileSync },
) {
  if (badOwner(owner) || badText(purpose))
    return fail('owner or purpose is blank or has a line break')
  const team = teamOf(owner)
  if (!team) return fail('owner must start with a team name (letters)')
  const next = readText(nextFile(stateDir)).trim()
  // The reservation is the FIRST word only: a path later in the line must not match.
  if (next && next.toLowerCase().match(/^[a-z]+/)?.[0] !== team) {
    return fail(`reserved for another team:\n${next}`)
  }
  mkdirSync(path.dirname(lockDir(stateDir)), { recursive: true })
  try {
    mkdirSync(lockDir(stateDir)) // non-recursive: EEXIST is the atomic "held"
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    return fail(`held:\n${readText(ownerFile(stateDir)).trim()}`)
  }
  try {
    write(
      ownerFile(stateDir),
      `owner: ${owner}\npurpose: ${purpose}\nstarted: ${now.toISOString()}\n`,
    )
  } catch (e) {
    // A dir with no owner.txt could never be released by anyone.
    rmSync(lockDir(stateDir), { recursive: true, force: true })
    return fail(`could not write owner.txt, lock not taken: ${e.message}`)
  }
  if (next) rmSync(nextFile(stateDir), { force: true })
  return { ok: true, message: `acquired by ${owner}` }
}

export function release(stateDir, { owner } = {}) {
  if (badOwner(owner)) return fail('owner is blank or has a line break')
  if (!existsSync(lockDir(stateDir))) return fail('no lock held')
  const text = readText(ownerFile(stateDir))
  const holder = field(text, 'owner')
  if (!text.trim()) {
    return fail(
      'owner.txt is missing or empty (interrupted acquire), lock left intact; report it to the BA',
    )
  }
  if (holder === undefined) {
    return fail(
      `cannot prove ownership; a lock taken by hand is removed by hand by its owner:\n${text.trim()}`,
    )
  }
  if (holder !== owner) return fail(`not the owner, lock left intact:\n${text.trim()}`)
  rmSync(lockDir(stateDir), { recursive: true, force: true })
  return { ok: true, message: 'released' }
}

export function status(stateDir, { now = new Date() } = {}) {
  const next = readText(nextFile(stateDir)).trim()
  const reserved = next ? [`next.txt: ${next}`] : []
  if (!existsSync(lockDir(stateDir))) {
    return { held: false, stale: false, lines: ['free', ...reserved] }
  }
  const text = readText(ownerFile(stateDir)).trim()
  const notes = []
  if (!text) notes.push('owner.txt missing or unreadable')
  else if (field(text, 'owner') === undefined) notes.push('legacy owner.txt, no owner line')
  let startedMs = Date.parse(field(text, 'started') ?? '')
  const parsed = !Number.isNaN(startedMs)
  if (!parsed || startedMs > now.getTime()) {
    startedMs = statSync(lockDir(stateDir)).mtimeMs // no usable start: age the dir
    notes.push(
      `${parsed ? 'future started' : 'no parseable started'}: age is from the lock dir mtime`,
    )
  }
  const skewed = startedMs > now.getTime()
  const ageMinutes = skewed ? undefined : Math.floor((now.getTime() - startedMs) / 60000)
  const stale = !skewed && ageMinutes > STALE_MINUTES
  const ageLine = skewed ? 'age unknown (clock skew), report to the BA' : `age: ${ageMinutes} min`
  const lines = [...(text ? text.split('\n') : []), ...notes, ageLine, ...reserved]
  if (stale) lines.push(`STALE (over ${STALE_MINUTES} min): report it to the BA, never remove it`)
  return { held: true, stale, ageMinutes, lines }
}

// The script's own location, not cwd: from outside a repo cwd would fail open.
const here = path.dirname(fileURLToPath(import.meta.url))
export function defaultStateDir(scriptDir = here, env = process.env) {
  if (env.HACKBENCH_STATE_DIR) return env.HACKBENCH_STATE_DIR
  const main = mainCheckoutDir(scriptDir)
  if (main === scriptDir) {
    throw new Error('git cannot resolve the main checkout; set HACKBENCH_STATE_DIR')
  }
  return stateDirIn(main)
}

export function cli(argv, stateDir) {
  const [cmd, ...rest] = argv
  let usageError = false
  const opt = name => {
    const i = rest.indexOf(`--${name}`)
    if (i < 0) return undefined
    const v = rest[i + 1]
    if (v === undefined || v.startsWith('--')) usageError = true
    return usageError ? undefined : v
  }
  const owner = opt('owner')
  const purpose = opt('purpose')
  if (usageError) return { code: 1, out: USAGE }
  if (cmd === 'status') return { code: 0, out: status(stateDir).lines.join('\n') }
  if ((cmd === 'acquire' || cmd === 'release') && owner) {
    const r =
      cmd === 'acquire'
        ? acquire(stateDir, { owner, purpose: purpose ?? '' })
        : release(stateDir, { owner })
    return { code: r.ok ? 0 : 1, out: r.message }
  }
  return { code: 1, out: USAGE }
}

// Realpath both sides: a junction or symlink launch must not silently exit 0.
const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
if (isMain()) {
  let result
  try {
    result = cli(process.argv.slice(2), defaultStateDir())
  } catch (e) {
    result = { code: 1, out: e.message }
  }
  console.log(result.out)
  process.exitCode = result.code
}
