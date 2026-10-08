#!/usr/bin/env node
// Session hook: prints the active protocols (every turn) and, on session
// start, the session's registration, manual and state file. Never exits
// non-zero: a failure here would block every prompt in every session, so a
// broken protocol file becomes one visible line instead.
// Spec: docs/superpowers/specs/2026-10-07-agentic-protocols-design.md section 3.5.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadProtocols,
  protocolsDirFor,
  readSessions,
  readState,
  stateDirFor,
} from './protocol.mjs'

const MANUALS = {
  ba: ['ba.md'],
  'tech-lead': ['tech-lead.md'],
  both: ['orchestrator.md', 'ba.md', 'tech-lead.md'],
}

function readIf(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

export function render(input, dirs) {
  const defs = loadProtocols(dirs.protocolsDir)
  const state = readState(dirs.stateDir, defs)
  const out = [`Active protocols: ${state.active.join(', ')}`]
  for (const name of state.active) out.push(`## ${name}`, ...defs.get(name).changes)
  if (input.hook_event_name !== 'SessionStart') return out.join('\n') + '\n'

  const id = input.session_id ?? 'unknown'
  const reg = readSessions(dirs.stateDir)[id]
  if (reg) {
    out.push(`Session id: ${id}. Registered as ${reg.role}${reg.team ? ` ${reg.team}` : ''}.`)
  } else {
    out.push(`Session id: ${id}. Not registered: follow the first step of your manual.`)
  }

  const role = reg ? reg.role : 'both'
  for (const f of MANUALS[role] ?? MANUALS.both) {
    const text = readIf(path.join(dirs.docsDir, 'agents', f))
    if (text) out.push(text)
  }
  if (reg && (reg.role === 'ba' || reg.role === 'both')) {
    const text = readIf(path.join(dirs.stateDir, 'ba.md'))
    if (text) out.push(text)
  }
  if (reg && reg.team) {
    const text = readIf(path.join(dirs.stateDir, 'teams', `${reg.team}.md`))
    if (text) out.push(text)
  }
  return out.join('\n') + '\n'
}

function readStdin() {
  try {
    const raw = readFileSync(0, 'utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

// settings.json imports this file under `node -e`, where argv[1] is unset, so
// "no argv[1]" counts as invoked; a test or another module has its own argv[1].
const invoked = !process.argv[1] || path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const dirs = {
    cwd,
    stateDir: stateDirFor(cwd),
    protocolsDir: protocolsDirFor(cwd),
    docsDir: process.env.HACKBENCH_DOCS_DIR || path.join(cwd, 'docs'),
  }
  let text
  try {
    text = render(readStdin(), dirs)
  } catch (err) {
    text = `Protocol hook error: ${err instanceof Error ? err.message : String(err)}\n`
  }
  process.stdout.write(text)
  process.exit(0)
}
