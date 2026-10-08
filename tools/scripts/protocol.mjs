#!/usr/bin/env node
// Protocol state for the agentic workflow: parse docs/protocols/*.md, keep
// .claude/state/protocols.json and protocols.log in the main checkout, and
// register sessions. Pure functions are exported for tests; the CLI is at
// the bottom. Spec: docs/superpowers/specs/2026-10-07-agentic-protocols-design.md
// section 3. Why a script rather than prose: the group invariant (exactly one
// active member per group with a default) is the kind of rule people forget
// at 3 am, and the hook that injects the result must never crash a session.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

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
