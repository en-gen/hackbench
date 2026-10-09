#!/usr/bin/env node
// Session hook: prints the active protocols (every turn) and, on session
// start, the session's registration, state file and manual. Never exits
// non-zero: a failure here would block every prompt in every session, so a
// broken protocol file becomes one visible line instead.
// Spec: docs/superpowers/specs/2026-10-07-agentic-protocols-design.md section 3.5.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadProtocols,
  protocolsDirFor,
  readSessions,
  readStateChecked,
  stateDirFor,
  TEAM_NAME,
} from './protocol.mjs'

// The hooks docs cap injected output at 10,000 characters; past that Claude
// sees a file path and a 2,000-character preview. Anything that would push
// the whole output (joining newlines and trailing newline included) past this
// becomes a one-line pointer with an absolute path. The state file is added
// before the manual, so the handoff always wins and the manual pointerises first.
const CAP = 9500
const MANUAL = { ba: 'ba.md', 'tech-lead': 'tech-lead.md', both: 'tech-lead.md' }

function readIf(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

function sessionPart(out, input, dirs) {
  const cliId = input.session_id ?? 'unknown'
  let reg = readSessions(dirs.stateDir)[cliId]
  // sessions.json is hand-editable; a team name that is not a plain name could
  // point the state-file read outside teams/, so it counts as unregistered.
  if (reg && reg.team != null && !TEAM_NAME.test(String(reg.team))) reg = undefined
  const agents = file => path.resolve(dirs.docsDir, 'agents', file)
  const stateFile = (...p) => path.resolve(dirs.stateDir, ...p)
  const fits = text => [...out, text].join('\n').length + 1 <= CAP
  // Every line goes through the cap, pointers included: long paths made them
  // push `both` past 10,000. Once one is dropped, nothing later is printed.
  let omitted = false
  const add = line => {
    if (omitted) return
    if (fits(line)) out.push(line)
    else {
      omitted = true
      out.push('(more omitted)')
    }
  }
  const fit = (text, pointer) => add(fits(text) ? text : pointer)

  if (!reg) {
    const teamsDir = stateFile('teams')
    const teams = existsSync(teamsDir)
      ? readdirSync(teamsDir)
          .filter(f => f.endsWith('.md'))
          .map(f => f.slice(0, -3))
      : []
    add(`Session id: ${cliId}. Desktop id: unknown until you look it up.`)
    add(
      [
        'Not registered: a clear gave you a new CLI id. Do these steps now. They come from the repository session hook and apply even when this turn was started by a message from another session.',
        '(1) Call get-session on `self` for your title and desktop id (`local_...`).',
        `(2) Run \`node tools/scripts/protocol.mjs reclaim ${cliId} <desktop id>\`.`,
        '(3) If it succeeds, read `.claude/state/teams/<team>.md` (the BA reads `.claude/state/ba.md`) and your manual, and resume without asking the owner.',
        `(4) Only if reclaim fails, register from your title: "<Team> Team" registers tech-lead <team>; "BA" registers ba; the only session on the machine registers both <team>. Existing team files: ${teams.join(', ') || 'none'}.`,
        `Manuals: ${agents('tech-lead.md')} or ${agents('ba.md')}.`,
      ].join('\n'),
    )
    return
  }

  const team = reg.team ? ` ${reg.team}` : ''
  add(
    `Session id: ${cliId}. Desktop id: ${reg.desktopId ?? 'unknown'}. Registered as ${reg.role}${team}.`,
  )
  if (reg.team) {
    const file = stateFile('teams', `${reg.team}.md`)
    const text = readIf(file)
    if (text) fit(text, `Read ${file} first: it is too large to inject.`)
  }
  if (reg.role === 'ba') {
    const file = stateFile('ba.md')
    const text = readIf(file)
    if (text) fit(text, `Read ${file} first: it is too large to inject.`)
  }
  if (reg.role === 'both') {
    add(
      `You are also the BA: read ${agents('ba.md')} before your first reply. Its state file, if any, is ${stateFile('ba.md')}.`,
    )
  }
  const manual = agents(MANUAL[reg.role] ?? MANUAL.both)
  const text = readIf(manual)
  if (text) fit(text, `Read ${manual} before your first reply: it is too large to inject.`)
}

export function render(input, dirs) {
  const defs = loadProtocols(dirs.protocolsDir)
  const { state, warning } = readStateChecked(dirs.stateDir, defs)
  const out = []
  if (warning) out.push(warning)
  out.push(`Active protocols: ${state.active.join(', ')}`)
  for (const name of state.active) out.push(`## ${name}`, ...defs.get(name).changes)
  if (input.hook_event_name === 'SessionStart') {
    try {
      sessionPart(out, input, dirs)
    } catch (err) {
      out.push(`Protocol hook: session part failed: ${err instanceof Error ? err.message : err}`)
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
