#!/usr/bin/env node
// The shared test-run lock (#923): a counting semaphore of directories (locks/run, run-2,
// run-3) in the main checkout's state dir so full unit runs, Theia builds and Playwright never overlap (timeouts
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
import { STATE_DIR_NAME, mainCheckoutDir } from './protocol.mjs'
import { slotCount, slotPort, vitestWorkers } from './run-slots.mjs'

export { slotCount, slotPort, vitestWorkers }

export const STALE_MINUTES = 120
const USAGE =
  'usage: run-lock.mjs acquire --owner "<team> <worktree>" --purpose "<text>" | release --owner "<id>" | status'

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

// Slot 1 is the original locks/run, so a lock taken by an older script is slot 1.
const slotDir = (s, n) => path.join(s, 'locks', n === 1 ? 'run' : `run-${n}`)
const ownerFile = (s, n) => path.join(slotDir(s, n), 'owner.txt')
const portLines = slot => [
  `use port ${slotPort(slot)} for Playwright and the app server:`,
  `  PowerShell: $env:HB_PORT='${slotPort(slot)}'`,
  `  bash:       export HB_PORT=${slotPort(slot)}`,
]
const range = slots => Array.from({ length: slots }, (_, i) => i + 1)

export function acquire(
  stateDir,
  { owner, purpose = '', now = new Date(), write = writeFileSync, slots = slotCount() },
) {
  if (badOwner(owner) || badText(purpose))
    return fail('owner or purpose is blank or has a line break')
  const team = teamOf(owner)
  if (!team) return fail('owner must start with a team name (letters)')
  const next = readText(nextFile(stateDir)).trim()
  // The reservation is the FIRST word only: a path later in the line must not match.
  // It gates every slot: a free slot is not free to a team that is not next.
  if (next && next.toLowerCase().match(/^[a-z]+/)?.[0] !== team) {
    return fail(`reserved for another team:\n${next}`)
  }
  // One slot per team stops one team taking the machine. A slot with no
  // parseable owner line names no team, so it never blocks anyone.
  for (const n of range(slots)) {
    const holder = field(readText(ownerFile(stateDir, n)), 'owner')
    if (holder !== undefined && teamOf(holder) === team) {
      return fail(`team ${team} already holds slot ${n}, one slot per team:\n${holder}`)
    }
  }
  mkdirSync(path.dirname(slotDir(stateDir, 1)), { recursive: true })
  for (const n of range(slots)) {
    try {
      mkdirSync(slotDir(stateDir, n)) // non-recursive: EEXIST is the atomic "held"
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      continue
    }
    try {
      write(
        ownerFile(stateDir, n),
        `owner: ${owner}\npurpose: ${purpose}\nstarted: ${now.toISOString()}\n`,
      )
    } catch (e) {
      // A dir with no owner.txt could never be released by anyone.
      rmSync(slotDir(stateDir, n), { recursive: true, force: true })
      return fail(`could not write owner.txt, lock not taken: ${e.message}`)
    }
    if (next) rmSync(nextFile(stateDir), { force: true })
    return {
      ok: true,
      slot: n,
      port: slotPort(n),
      message: [`acquired slot ${n} by ${owner}`, ...portLines(n)].join('\n'),
    }
  }
  const holders = range(slots).map(n => `slot ${n}:\n${readText(ownerFile(stateDir, n)).trim()}`)
  return fail(`all ${slots} slots held:\n${holders.join('\n')}`)
}

export function release(stateDir, { owner, slots = slotCount() } = {}) {
  if (badOwner(owner)) return fail('owner is blank or has a line break')
  const held = range(slots).filter(n => existsSync(slotDir(stateDir, n)))
  if (!held.length) return fail('no lock held')
  const failures = []
  for (const n of held) {
    const text = readText(ownerFile(stateDir, n))
    const holder = field(text, 'owner')
    if (!text.trim()) {
      failures.push(
        'owner.txt is missing or empty (interrupted acquire), lock left intact; report it to the BA',
      )
    } else if (holder === undefined) {
      failures.push(
        `cannot prove ownership; a lock taken by hand is removed by hand by its owner:\n${text.trim()}`,
      )
    } else if (holder !== owner) {
      failures.push(`not the owner, lock left intact:\n${text.trim()}`)
    } else {
      rmSync(slotDir(stateDir, n), { recursive: true, force: true }) // this slot only
      return { ok: true, slot: n, message: `released slot ${n}` }
    }
  }
  return fail(failures.join('\n'))
}

function slotStatus(stateDir, n, now) {
  const text = readText(ownerFile(stateDir, n)).trim()
  const notes = []
  if (!text) notes.push('owner.txt missing or unreadable')
  else if (field(text, 'owner') === undefined) notes.push('legacy owner.txt, no owner line')
  let startedMs = Date.parse(field(text, 'started') ?? '')
  const parsed = !Number.isNaN(startedMs)
  if (!parsed || startedMs > now.getTime()) {
    startedMs = statSync(slotDir(stateDir, n)).mtimeMs // no usable start: age the dir
    notes.push(
      `${parsed ? 'future started' : 'no parseable started'}: age is from the lock dir mtime`,
    )
  }
  const skewed = startedMs > now.getTime()
  const ageMinutes = skewed ? undefined : Math.floor((now.getTime() - startedMs) / 60000)
  const stale = !skewed && ageMinutes > STALE_MINUTES
  const ageLine = skewed ? 'age unknown (clock skew), report to the BA' : `age: ${ageMinutes} min`
  const lines = [...(text ? text.split('\n') : []), ...notes, ageLine]
  if (stale) lines.push(`STALE (over ${STALE_MINUTES} min): report it to the BA, never remove it`)
  return { held: true, stale, ageMinutes, lines }
}

export function status(stateDir, { now = new Date(), slots = slotCount() } = {}) {
  const next = readText(nextFile(stateDir)).trim()
  const reserved = next ? [`next.txt: ${next}`] : []
  const per = range(slots).map(n =>
    existsSync(slotDir(stateDir, n)) ? slotStatus(stateDir, n, now) : { held: false, lines: [] },
  )
  const lines = per.flatMap((p, i) =>
    p.held ? [`slot ${i + 1}:`, ...p.lines.map(l => `  ${l}`)] : [`slot ${i + 1}: free`],
  )
  const heldSlots = per.filter(p => p.held)
  return {
    held: heldSlots.length > 0,
    stale: heldSlots.some(p => p.stale),
    ageMinutes: heldSlots[0]?.ageMinutes,
    slots: per,
    lines: [...lines, ...reserved],
  }
}

// The script's own location, not cwd: from outside a repo cwd would fail open.
const here = path.dirname(fileURLToPath(import.meta.url))
export function defaultStateDir(scriptDir = here, env = process.env) {
  if (env.HACKBENCH_STATE_DIR) return env.HACKBENCH_STATE_DIR
  const main = mainCheckoutDir(scriptDir)
  if (main === scriptDir) {
    throw new Error('git cannot resolve the main checkout; set HACKBENCH_STATE_DIR')
  }
  return path.join(main, STATE_DIR_NAME)
}

export function cli(argv, stateDir, env = process.env) {
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
  if (cmd === 'status')
    return { code: 0, out: status(stateDir, { slots: slotCount(env) }).lines.join('\n') }
  if ((cmd === 'acquire' || cmd === 'release') && owner) {
    const r =
      cmd === 'acquire'
        ? acquire(stateDir, { owner, purpose: purpose ?? '', slots: slotCount(env) })
        : release(stateDir, { owner, slots: slotCount(env) })
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
