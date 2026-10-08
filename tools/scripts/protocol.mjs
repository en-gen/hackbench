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
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HEADINGS = ['Purpose', 'Group', 'Activation', 'Changes', 'Unchanged', 'Exit']
export const MAX_CHANGES_LINES = 15

export function parseProtocolFile(text, stem) {
  const lines = text.split(/\r?\n/)
  const h1 = lines.find(l => l.startsWith('# '))
  if (!h1 || h1.slice(2).trim() !== stem) throw new Error(`${stem}: H1 must be "# ${stem}"`)
  const sections = {}
  let current = null
  for (const line of lines) {
    const m = /^## (.+)$/.exec(line)
    if (m) {
      current = m[1].trim()
      sections[current] = []
      continue
    }
    if (current) sections[current].push(line)
  }
  const found = Object.keys(sections)
  if (found.join('|') !== HEADINGS.join('|')) {
    throw new Error(
      `${stem}: headings must be ${HEADINGS.join(', ')} in order; found ${found.join(', ')}`,
    )
  }
  const groupLine = sections.Group.map(l => l.trim()).find(Boolean) ?? ''
  const gm = /^(none|[a-z][a-z0-9-]*)(?:\s*\((default)\))?$/.exec(groupLine)
  if (!gm)
    throw new Error(
      `${stem}: Group must be "none", "<group>" or "<group> (default)"; found "${groupLine}"`,
    )
  const changes = sections.Changes.map(l => l.trimEnd()).filter(Boolean)
  if (changes.length > MAX_CHANGES_LINES) {
    throw new Error(
      `${stem}: Changes has ${changes.length} lines; the limit is ${MAX_CHANGES_LINES}`,
    )
  }
  if (!changes.every(l => /^\d+\. /.test(l)))
    throw new Error(`${stem}: Changes must be a numbered list`)
  return {
    name: stem,
    group: gm[1] === 'none' ? null : gm[1],
    isDefault: gm[2] === 'default',
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

export function readState(stateDir, defs) {
  const file = path.join(stateDir, STATE_FILE)
  let state = defaultState(defs)
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      state = {
        active: Array.isArray(raw.active) ? raw.active : [],
        changed: raw.changed ?? null,
        by: raw.by ?? null,
      }
    } catch {
      state = defaultState(defs)
    }
  }
  const active = new Set(state.active.filter(n => defs.has(n)))
  for (const [group, dflt] of groupDefaults(defs)) {
    const hasMember = [...active].some(n => defs.get(n).group === group)
    if (!hasMember) active.add(dflt)
  }
  return { ...state, active: [...active].sort() }
}

export function applyChange(state, defs, name, verb, by, now) {
  const def = defs.get(name)
  if (!def) return { error: `unknown protocol "${name}"; known: ${[...defs.keys()].join(', ')}` }
  if (verb !== 'on' && verb !== 'off') return { error: 'verb must be on or off' }
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

export function writeState(stateDir, state, logLine) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(path.join(stateDir, STATE_FILE), JSON.stringify(state, null, 2) + '\n')
  appendFileSync(path.join(stateDir, LOG_FILE), logLine + '\n')
}

const SESSIONS_FILE = 'sessions.json'
const ROLES = new Set(['ba', 'tech-lead', 'both'])

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

export function readSessions(stateDir) {
  const file = path.join(stateDir, SESSIONS_FILE)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

export function registerSession(stateDir, sessionId, role, team, now) {
  if (!ROLES.has(role)) throw new Error(`role must be ba, tech-lead or both; got "${role}"`)
  if (role !== 'ba' && !team) throw new Error(`a ${role} session needs a team`)
  const all = readSessions(stateDir)
  all[sessionId] = { role, team: team ?? null, registered: now }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(path.join(stateDir, SESSIONS_FILE), JSON.stringify(all, null, 2) + '\n')
  return all
}

function cli(argv, cwd) {
  const stateDir = stateDirFor(cwd)
  const defs = loadProtocols(protocolsDirFor(cwd))
  const [a, b, c] = argv
  const now = new Date().toISOString()
  if (a === 'status') {
    const s = readState(stateDir, defs)
    return { code: 0, out: { ...s, sessions: readSessions(stateDir) } }
  }
  if (a === 'register') {
    if (!b || !c) return { code: 1, out: 'usage: protocol.mjs register <sessionId> <role> [team]' }
    return { code: 0, out: registerSession(stateDir, b, c, argv[3] ?? null, now) }
  }
  if (!a || !b) {
    return {
      code: 1,
      out: 'usage: protocol.mjs <name> on|off [--by <who>] | status | register <sessionId> <role> [team]',
    }
  }
  const byIdx = argv.indexOf('--by')
  const by = byIdx >= 0 && argv[byIdx + 1] ? argv[byIdx + 1] : 'unknown'
  const r = applyChange(readState(stateDir, defs), defs, a, b, by, now)
  if (r.error) return { code: 1, out: r.error }
  writeState(stateDir, r.state, r.logLine)
  const sessions = readSessions(stateDir)
  const nudge = Object.entries(sessions).map(([sessionId, s]) => ({
    sessionId,
    role: s.role,
    team: s.team,
  }))
  return { code: 0, out: { active: r.state.active, logLine: r.logLine, nudge } }
}

// The guard keeps the CLI from running when vitest or the hook imports this module.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result
  try {
    result = cli(process.argv.slice(2), process.cwd())
  } catch (err) {
    result = { code: 1, out: err instanceof Error ? err.message : String(err) }
  }
  process.stdout.write(
    (typeof result.out === 'string' ? result.out : JSON.stringify(result.out, null, 2)) + '\n',
  )
  process.exit(result.code)
}
