#!/usr/bin/env node
// Folds changelog.d/*.md fragments into CHANGELOG.md at release (#833).
// One file per PR means concurrent PRs never edit the same lines, which is
// what made [Unreleased] the most common merge conflict.
//
// Usage: changelog-combine.mjs <version> [--date YYYY-MM-DD] [--root DIR]

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']

// Returns { sections: Map<name, lines[]> } or throws with a message naming the file.
export function parseFragment(name, text) {
  const sections = new Map()
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    const h = /^### (.*\S)\s*$/.exec(line)
    if (h) {
      if (!SECTIONS.includes(h[1])) throw new Error(`${name}: unknown section "${h[1]}"`)
      cur = sections.get(h[1]) ?? []
      sections.set(h[1], cur)
    } else if (line.trim()) {
      if (!cur) throw new Error(`${name}: text before the first "### <Section>" heading`)
      if (cur.length === 0 && !line.startsWith('- ')) {
        throw new Error(`${name}: first entry under a heading must start with "- "`)
      }
      cur.push(line)
    }
  }
  if (sections.size === 0) throw new Error(`${name}: no "### <Section>" heading`)
  for (const [s, lines] of sections) {
    if (lines.length === 0) throw new Error(`${name}: section "${s}" has no entries`)
  }
  return sections
}

export function combine(changelog, fragments, version, date) {
  const m = /^## \[Unreleased\][^\n]*\n/m.exec(changelog)
  if (!m) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading')
  const bodyStart = m.index + m[0].length
  const next = changelog.slice(bodyStart).search(/^## \[/m)
  const bodyEnd = next === -1 ? changelog.length : bodyStart + next
  const preamble = []
  const merged = new Map()
  let cur = null
  for (const line of changelog.slice(bodyStart, bodyEnd).split('\n')) {
    const h = /^### (.*\S)\s*$/.exec(line)
    if (h) {
      cur = merged.get(h[1]) ?? []
      merged.set(h[1], cur)
    } else if (line.trim()) (cur ?? preamble).push(line)
  }
  for (const f of fragments) {
    for (const [s, lines] of f) merged.set(s, [...(merged.get(s) ?? []), ...lines])
  }
  // Existing headings outside the Keep a Changelog set stay, after the known ones.
  const order = [...SECTIONS, ...[...merged.keys()].filter(k => !SECTIONS.includes(k))]
  let out = `## [${version}] - ${date}\n\n`
  if (preamble.length) out += preamble.join('\n') + '\n\n'
  for (const s of order) {
    if (merged.get(s)?.length) out += `### ${s}\n\n${merged.get(s).join('\n')}\n\n`
  }
  return changelog.slice(0, bodyStart) + '\n' + out + changelog.slice(bodyEnd)
}

function main(argv) {
  const args = argv.slice(2)
  const opt = n => {
    const i = args.indexOf(n)
    return i === -1 ? undefined : args.splice(i, 2)[1]
  }
  const date = opt('--date') ?? new Date().toISOString().slice(0, 10)
  const root = opt('--root') ?? process.cwd()
  const version = args[0]
  if (!version || !/^\d+\.\d+\.\d+\S*$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('usage: changelog-combine.mjs <version> [--date YYYY-MM-DD] [--root DIR]')
    return 2
  }
  const dir = join(root, 'changelog.d')
  const names = existsSync(dir)
    ? readdirSync(dir)
        .filter(n => n.endsWith('.md') && n !== 'README.md')
        .sort()
    : []
  if (names.length === 0) return 0
  try {
    // Validate everything before any write so a bad fragment leaves no partial release.
    const parsed = names.map(n => parseFragment(n, readFileSync(join(dir, n), 'utf8')))
    const file = join(root, 'CHANGELOG.md')
    writeFileSync(file, combine(readFileSync(file, 'utf8'), parsed, version, date))
    for (const n of names) unlinkSync(join(dir, n))
  } catch (e) {
    console.error(`changelog-combine: ${e.message}`)
    return 1
  }
  return 0
}

import { fileURLToPath } from 'node:url'
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv)
