#!/usr/bin/env node
// Session hook: prints the active protocols (every turn) and, on session
// start, two facts and one instruction. It never exits non-zero: a failure
// here would block every prompt in every session, so a broken protocol file
// becomes one visible line instead. It no longer maps a session to a
// registration or injects manuals: a clear gives a new CLI session id, so the
// hook cannot find the registration, and the resume prompt a lead sends to its
// orchestrator before clearing carries that instead.
// Spec: docs/superpowers/specs/2026-10-07-agentic-protocols-design.md section 3.5.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProtocols, protocolsDirFor, readStateChecked, stateDirFor } from './protocol.mjs'

export function render(input, dirs) {
  const defs = loadProtocols(dirs.protocolsDir)
  const { state, warning } = readStateChecked(dirs.stateDir, defs)
  const out = []
  if (warning) out.push(warning)
  out.push(`Active protocols: ${state.active.join(', ')}`)
  for (const name of state.active) out.push(`## ${name}`, ...defs.get(name).changes)
  if (input.hook_event_name === 'SessionStart') {
    // Absolute paths from the main checkout: a worktree's own copy may be stale.
    const root = path.resolve(dirs.docsDir, '..')
    const script = path.join(root, 'tools', 'scripts', 'protocol.mjs')
    const agents = file => path.resolve(dirs.docsDir, 'agents', file)
    out.push(
      `Session id: ${input.session_id ?? 'unknown'}. Protocol script (main checkout): ${script}. State folder: ${dirs.stateDir}.`,
      `A cleared session waits for its orchestrator's resume prompt and follows it. A new session reads its manual (${agents('tech-lead.md')} or ${agents('ba.md')}) and registers from its title.`,
    )
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
