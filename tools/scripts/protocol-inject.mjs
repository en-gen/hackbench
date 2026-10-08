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

// The hooks docs cap injected output at 10,000 characters; past that Claude
// sees a file path and a 2,000-character preview. A role that is also the BA
// gets a pointer to ba.md instead of its text, and any manual that would still
// push the output over the cap becomes a pointer too.
const CAP = 9500
const MANUALS = {
  ba: ['ba.md'],
  'tech-lead': ['tech-lead.md'],
  both: ['tech-lead.md'],
}
const ALSO_BA = 'You are also the BA: read docs/agents/ba.md before your first reply.'

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

  // Push text if it fits under the cap, else a one-line pointer to read it.
  const pushFit = (text, pointer) => {
    out.push(out.join('\n').length + text.length > CAP ? pointer : text)
  }
  const role = reg ? reg.role : 'both'
  if (role === 'both') out.push(ALSO_BA)
  for (const f of MANUALS[role] ?? MANUALS.both) {
    const text = readIf(path.join(dirs.docsDir, 'agents', f))
    if (text)
      pushFit(text, `Read docs/agents/${f} before your first reply: it is too large to inject.`)
  }
  // A role that is also the BA reads ba.md, and its state file, itself.
  if (reg && reg.role === 'ba') {
    const text = readIf(path.join(dirs.stateDir, 'ba.md'))
    if (text) pushFit(text, 'Read .claude/state/ba.md: it is too large to inject.')
  }
  if (reg && reg.team) {
    const text = readIf(path.join(dirs.stateDir, 'teams', `${reg.team}.md`))
    if (text) {
      pushFit(text, `Read .claude/state/teams/${reg.team}.md: it is too large to inject.`)
    }
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
