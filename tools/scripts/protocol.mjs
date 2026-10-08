#!/usr/bin/env node
// Protocol state for the agentic workflow: parse docs/protocols/*.md, keep
// .claude/state/protocols.json and protocols.log in the main checkout, and
// register sessions. Pure functions are exported for tests; the CLI is at
// the bottom. Spec: docs/superpowers/specs/2026-10-07-agentic-protocols-design.md
// section 3. Why a script rather than prose: the group invariant (exactly one
// active member per group with a default) is the kind of rule people forget
// at 3 am, and the hook that injects the result must never crash a session.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HEADINGS = ['Purpose', 'Group', 'Activation', 'Changes', 'Unchanged', 'Exit']
export const MAX_CHANGES_LINES = 15
export const MAX_CHANGES_LINE_CHARS = 200

// Windows editors prepend a BOM, which JSON.parse and the heading match both reject.
const stripBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

export function parseProtocolFile(text, stem) {
  const lines = stripBom(text).split(/\r?\n/)
  const h1 = lines.find(l => l.startsWith('# '))
  if (!h1 || h1.slice(2).trim() !== stem) throw new Error(`${stem}: H1 must be "# ${stem}"`)
  const sections = {}
  const found = []
  let current = null
  for (const line of lines) {
    const m = /^## (.+)$/.exec(line)
    if (m) {
      current = m[1].trim()
      found.push(current)
      sections[current] = []
      continue
    }
    if (current) sections[current].push(line)
  }
  if (found.join('|') !== HEADINGS.join('|')) {
    throw new Error(
      `${stem}: headings must be ${HEADINGS.join(', ')} in order; found ${found.join(', ')}`,
    )
  }
  const groupLine = sections.Group.map(l => l.trim()).find(Boolean) ?? ''
  const gm = /^(none|[a-z][a-z0-9-]*)(?:\s*\((default)\))?$/.exec(groupLine)
  if (!gm || (gm[1] === 'none' && gm[2])) {
    throw new Error(
      `${stem}: Group must be "none", "<group>" or "<group> (default)"; found "${groupLine}"`,
    )
  }
  // A protocol that must not be enacted yet says so on the first line of Activation.
  const firstActivation = sections.Activation.map(l => l.trim()).find(Boolean) ?? ''
  const bm = /^Blocked:\s*(.*)$/.exec(firstActivation)
  if (bm && !bm[1]) throw new Error(`${stem}: Blocked needs a reason`)
  const blocked = bm ? bm[1] : null
  const changes = sections.Changes.map(l => l.trimEnd()).filter(Boolean)
  if (changes.length === 0) throw new Error(`${stem}: Changes is empty`)
  if (changes.length > MAX_CHANGES_LINES) {
    throw new Error(
      `${stem}: Changes has ${changes.length} lines; the limit is ${MAX_CHANGES_LINES}`,
    )
  }
  if (!changes.every(l => /^\d+\. /.test(l))) {
    throw new Error(`${stem}: Changes must be a numbered list`)
  }
  if (changes.some(l => l.length > MAX_CHANGES_LINE_CHARS)) {
    throw new Error(`${stem}: a Changes line is over ${MAX_CHANGES_LINE_CHARS} characters`)
  }
  return {
    name: stem,
    group: gm[1] === 'none' ? null : gm[1],
    isDefault: gm[2] === 'default',
    blocked,
    changes,
  }
}

export function loadProtocols(dir) {
  const defs = new Map()
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'README.md')
    .sort()
  for (const f of files) {
    const stem = f.slice(0, -3)
    defs.set(stem, parseProtocolFile(readFileSync(path.join(dir, f), 'utf8'), stem))
  }
  groupDefaults(defs)
  return defs
}

export function groupDefaults(defs) {
  const defaults = new Map()
  for (const d of defs.values()) {
    if (!d.group || !d.isDefault) continue
    if (defaults.has(d.group)) {
      throw new Error(`group ${d.group} has two defaults: ${defaults.get(d.group)} and ${d.name}`)
    }
    defaults.set(d.group, d.name)
  }
  return defaults
}

export function defaultState(defs) {
  return { active: [...groupDefaults(defs).values()].sort(), changed: null, by: null }
}

const STATE_FILE = 'protocols.json'
const LOG_FILE = 'protocols.log'
export const UNREADABLE_STATE = 'protocols.json unreadable, defaults applied'

// Returns the repaired state and a warning when the file exists but cannot be
// used. The repair enforces the group invariant on read, so a hand-edited file
// with two shift members cannot put both rule sets in front of a session.
export function readStateChecked(stateDir, defs) {
  const file = path.join(stateDir, STATE_FILE)
  let state = defaultState(defs)
  let warning = null
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(stripBom(readFileSync(file, 'utf8')))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
      state = {
        active: Array.isArray(raw.active) ? raw.active : [],
        changed: raw.changed ?? null,
        by: raw.by ?? null,
      }
    } catch {
      warning = UNREADABLE_STATE
    }
  }
  const defaults = groupDefaults(defs)
  const keep = []
  const seenGroups = new Map()
  for (const name of state.active.filter(n => defs.has(n))) {
    const group = defs.get(name).group
    if (!group) {
      keep.push(name)
    } else if (!seenGroups.has(group)) {
      seenGroups.set(group, name)
      keep.push(name)
    } else if (seenGroups.get(group) === defaults.get(group) && name !== defaults.get(group)) {
      // The first member seen was the default and a non-default is active too: the non-default wins.
      keep.splice(keep.indexOf(seenGroups.get(group)), 1, name)
      seenGroups.set(group, name)
    }
  }
  const active = new Set(keep)
  for (const [group, dflt] of defaults) {
    if (!seenGroups.has(group)) active.add(dflt)
  }
  return { state: { ...state, active: [...active].sort() }, warning }
}

export function readState(stateDir, defs) {
  return readStateChecked(stateDir, defs).state
}

export function applyChange(state, defs, name, verb, by, now) {
  const def = defs.get(name)
  if (!def) return { error: `unknown protocol "${name}"; known: ${[...defs.keys()].join(', ')}` }
  if (verb !== 'on' && verb !== 'off') return { error: 'verb must be on or off' }
  if (verb === 'on' && def.blocked) return { error: `${name} is blocked: ${def.blocked}` }
  const active = new Set(state.active)
  const touched = []
  if (verb === 'on') {
    for (const d of defs.values()) {
      if (def.group && d.group === def.group && d.name !== name && active.has(d.name)) {
        active.delete(d.name)
        touched.push(d.name)
      }
    }
    active.add(name)
  } else {
    if (!active.has(name)) return { error: `${name} is not active` }
    const dflt = def.group ? groupDefaults(defs).get(def.group) : undefined
    if (dflt === name) {
      const sibling = [...defs.values()].find(d => d.group === def.group && d.name !== name)
      return {
        error: `${name} is the default of group ${def.group}; turn on ${sibling ? sibling.name : 'another member'} instead`,
      }
    }
    active.delete(name)
    if (dflt) {
      active.add(dflt)
      touched.push(dflt)
    }
  }
  const suffix = touched.length
    ? ` (${verb === 'on' ? 'replaced' : 'restored'} ${touched.join(', ')})`
    : ''
  return {
    state: { active: [...active].sort(), changed: now, by },
    logLine: `${now} ${name} ${verb} by ${by}${suffix}`,
  }
}

// Windows refuses to rename over a file another process has open, and every
// session's hook reads these files, so EPERM and EBUSY are retried briefly.
const RETRY_CODES = new Set(['EPERM', 'EBUSY'])
const RENAME_ATTEMPTS = 20
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Every state write is a read-modify-write, and several sessions run the
// command at once, so writers take a lock file holding a random token.
//
// A lock older than the stale limit belongs to a crashed or stalled process
// and is taken over. Two waiters can judge the same lock stale, and a stalled
// holder can wake up after losing it, so the token is what keeps them apart:
// a takeover moves the lock aside and only discards it if it carries the token
// that was judged stale (otherwise it puts the fresh lock back); the holder
// removes the lock only if it is still its own, and re-checks before writing
// (`assertHeld`) so a holder that lost the lock throws instead of overwriting
// its successor's write. The check-then-write gap is not closed, only narrowed.
export const LOCK_DEFAULTS = { timeoutMs: 15000, staleMs: 10000 }

const envMs = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const readToken = lock => {
  try {
    return readFileSync(lock, 'utf8')
  } catch {
    return null
  }
}

function takeOverStale(lock, staleMs, afterStaleCheck) {
  let judged
  let mtimeMs
  try {
    mtimeMs = statSync(lock).mtimeMs
    judged = readFileSync(lock, 'utf8')
  } catch {
    return // the holder released it meanwhile
  }
  // Absolute, so a lock stamped in the future (clock change) cannot wedge the state.
  if (Math.abs(Date.now() - mtimeMs) <= staleMs) return
  afterStaleCheck()
  const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    renameSync(lock, aside)
  } catch {
    return // someone else took it over first
  }
  if (readToken(aside) === judged) {
    rmSync(aside, { force: true })
    return
  }
  // We moved a fresh lock that replaced the stale one; give it back.
  try {
    renameSync(aside, lock)
  } catch {
    rmSync(aside, { force: true })
  }
}

export function withStateLock(stateDir, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? envMs('HACKBENCH_LOCK_TIMEOUT_MS', LOCK_DEFAULTS.timeoutMs)
  const staleMs = opts.staleMs ?? envMs('HACKBENCH_LOCK_STALE_MS', LOCK_DEFAULTS.staleMs)
  const { afterStaleCheck = () => {}, afterAcquire = () => {} } = opts
  mkdirSync(stateDir, { recursive: true })
  const lock = path.join(stateDir, '.lock')
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: 'wx' })
      break
    } catch (err) {
      if (err?.code !== 'EEXIST' && !RETRY_CODES.has(err?.code)) throw err
      takeOverStale(lock, staleMs, afterStaleCheck)
      if (Date.now() > deadline) {
        throw new Error(`could not lock ${stateDir} within ${timeoutMs} ms`, { cause: err })
      }
      sleepMs(10 + Math.floor(Math.random() * 41))
    }
  }
  const assertHeld = () => {
    if (readToken(lock) !== token)
      throw new Error('lock lost: another process took over the state lock')
  }
  try {
    afterAcquire()
    return fn(assertHeld)
  } finally {
    if (readToken(lock) === token) rmSync(lock, { force: true })
  }
}

// Temp file in the same directory, then rename: a crash mid-write leaves the
// old file, never a truncated one that the hook would read as defaults.
function writeFileAtomic(file, text, rename = renameSync) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text)
    for (let attempt = 1; ; attempt++) {
      try {
        rename(tmp, file)
        return
      } catch (err) {
        if (!RETRY_CODES.has(err?.code) || attempt >= RENAME_ATTEMPTS) throw err
        sleepMs(10 + Math.floor(Math.random() * 41))
      }
    }
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

export function writeState(stateDir, state, logLine, { rename = renameSync } = {}) {
  mkdirSync(stateDir, { recursive: true })
  writeFileAtomic(path.join(stateDir, STATE_FILE), JSON.stringify(state, null, 2) + '\n', rename)
  appendFileSync(path.join(stateDir, LOG_FILE), logLine + '\n')
}

const SESSIONS_FILE = 'sessions.json'
const ROLES = new Set(['ba', 'tech-lead', 'both'])
const CLI_ID = /^[0-9a-f-]{36}$/
const DESKTOP_ID = /^local_[0-9a-f-]{36}$/
export const TEAM_NAME = /^[a-z][a-z0-9-]{0,31}$/

export function mainCheckoutDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout.trim()) return cwd
  return path.dirname(path.resolve(cwd, r.stdout.trim()))
}

export function stateDirFor(cwd) {
  return process.env.HACKBENCH_STATE_DIR || path.join(mainCheckoutDir(cwd), '.claude', 'state')
}

export function protocolsDirFor(cwd) {
  return process.env.HACKBENCH_PROTOCOLS_DIR || path.join(cwd, 'docs', 'protocols')
}

// Anything that is not a plain object reads as no sessions, so a corrupt file
// cannot take the hook or the command down.
export function readSessions(stateDir) {
  const file = path.join(stateDir, SESSIONS_FILE)
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(stripBom(readFileSync(file, 'utf8')))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

// The hook receives the CLI session id; the session-management tools take the
// desktop id (local_...). A registration carries both, keyed by the CLI id.
// It never touches a team state file: that file is the handoff.
export function registerSession(
  stateDir,
  cliId,
  desktopId,
  role,
  team,
  now,
  { rename = renameSync, lock = {} } = {},
) {
  if (!CLI_ID.test(cliId)) throw new Error(`CLI session id must match ${CLI_ID}; got "${cliId}"`)
  if (!DESKTOP_ID.test(desktopId)) {
    throw new Error(`desktop id must match ${DESKTOP_ID}; got "${desktopId}"`)
  }
  if (!ROLES.has(role)) throw new Error(`role must be ba, tech-lead or both; got "${role}"`)
  if (role !== 'ba' && !team) throw new Error(`a ${role} session needs a team`)
  if (team && !TEAM_NAME.test(team)) throw new Error(`team name must match ${TEAM_NAME}`)
  return withStateLock(
    stateDir,
    assertHeld => {
      const all = readSessions(stateDir)
      // A clear gives the same desktop session a new CLI id; keep one entry per desktop id.
      for (const [id, entry] of Object.entries(all)) {
        if (entry?.desktopId === desktopId) delete all[id]
      }
      all[cliId] = { desktopId, role, team: team ?? null, registered: now }
      assertHeld()
      writeFileAtomic(
        path.join(stateDir, SESSIONS_FILE),
        JSON.stringify(all, null, 2) + '\n',
        rename,
      )
      return all
    },
    lock,
  )
}

// The BA prunes sessions that no longer exist; going through the lock keeps a
// concurrent register from being lost.
export function unregisterSession(stateDir, desktopId, { rename = renameSync, lock = {} } = {}) {
  if (!DESKTOP_ID.test(desktopId)) {
    throw new Error(`desktop id must match ${DESKTOP_ID}; got "${desktopId}"`)
  }
  return withStateLock(
    stateDir,
    assertHeld => {
      const all = readSessions(stateDir)
      let removed = 0
      for (const [id, entry] of Object.entries(all)) {
        if (entry?.desktopId === desktopId) {
          delete all[id]
          removed += 1
        }
      }
      if (removed > 0) {
        assertHeld()
        writeFileAtomic(
          path.join(stateDir, SESSIONS_FILE),
          JSON.stringify(all, null, 2) + '\n',
          rename,
        )
      }
      return { removed, sessions: all }
    },
    lock,
  )
}

const BY = /^(owner|schedule|session:local_[0-9a-f-]{36})$/
const BY_MESSAGE = '--by must be owner, schedule or session:<desktop id>'
const USAGE =
  'usage: protocol.mjs <name> on|off --by <owner|schedule|session:<desktop id>> | status | register <cliId> <desktopId> <role> [team] | unregister <desktopId>'

function cli(argv, cwd) {
  const stateDir = stateDirFor(cwd)
  const defs = loadProtocols(protocolsDirFor(cwd))
  const [a, b, c, d, e] = argv
  const now = new Date().toISOString()
  if (a === 'status') {
    const { state, warning } = readStateChecked(stateDir, defs)
    return { code: 0, out: { ...state, sessions: readSessions(stateDir) }, warn: warning }
  }
  if (a === 'unregister') {
    if (!b) return { code: 1, out: USAGE }
    return { code: 0, out: unregisterSession(stateDir, b) }
  }
  if (a === 'register') {
    if (!b || !c || !d) return { code: 1, out: USAGE }
    return { code: 0, out: registerSession(stateDir, b, c, d, e ?? null, now) }
  }
  if (!a || !b) return { code: 1, out: USAGE }
  if (!defs.has(a)) {
    return { code: 1, out: `unknown protocol "${a}"; known: ${[...defs.keys()].join(', ')}` }
  }
  const byIdx = argv.indexOf('--by')
  const by = byIdx >= 0 ? argv[byIdx + 1] : undefined
  if (by === undefined || !BY.test(by))
    return {
      code: 1,
      out: `${BY_MESSAGE}\n${USAGE}`,
    }
  // The whole read-apply-write is one critical section, so two commands cannot both start from the old state.
  return withStateLock(stateDir, assertHeld => {
    const { state, warning } = readStateChecked(stateDir, defs)
    const r = applyChange(state, defs, a, b, by, now)
    if (r.error) return { code: 1, out: r.error, warn: warning }
    // Computed before the write so a bad sessions file cannot leave a half-reported change.
    const nudge = Object.values(readSessions(stateDir)).map(s => ({
      desktopId: s.desktopId,
      role: s.role,
      team: s.team,
    }))
    assertHeld()
    writeState(stateDir, r.state, r.logLine)
    return { code: 0, out: { active: r.state.active, logLine: r.logLine, nudge }, warn: warning }
  })
}

// The guard keeps the CLI from running when vitest or the hook imports this module.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result
  try {
    result = cli(process.argv.slice(2), process.cwd())
  } catch (err) {
    result = { code: 1, out: err instanceof Error ? err.message : String(err) }
  }
  if (result.warn) process.stderr.write(result.warn + '\n')
  process.stdout.write(
    (typeof result.out === 'string' ? result.out : JSON.stringify(result.out, null, 2)) + '\n',
  )
  process.exit(result.code)
}
