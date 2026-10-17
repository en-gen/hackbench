#!/usr/bin/env node
// Report-only: lists 8-byte windows of text or assembled bytes that also occur
// in the vanilla ROM (BA safety rule, 2026-10-17). NOT a gate: nothing runs it.
//   node tools/scripts/rom-window-probe.mjs [--rom f] [--repo dir] <files...>
//   ... --git-range a..b      files the range touches; runs overlapping an added line
//   ... --bin <files...>      raw assembled bytes (the authoritative check)
// Prints offsets and counts, never ROM bytes.
// Exit 0 clean, 1 a hit, 2 nothing could be checked (no ROM, bad --rom, git error).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesHits, locateVanillaRom, textHits, windowSet } from './lib/rom-windows.mjs'

const args = process.argv.slice(2)
let rom
let range
let repo = process.cwd()
let bin = false
const files = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--rom') rom = args[++i]
  else if (a === '--git-range') range = args[++i]
  else if (a === '--repo') repo = args[++i]
  else if (a === '--bin') bin = true
  else files.push(a)
}

const fail = msg => {
  console.error(msg)
  process.exit(2)
}
// An unreadable file or a git error must not look like a clean run (node's own exit would be 1).
process.on('uncaughtException', e => fail(`ERROR: ${e.message}`))
// The lookup uses THIS checkout, never --repo (which only names the repo to diff).
const here = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const romFile = rom ?? locateVanillaRom(process.env, here)
if (!existsSync(romFile))
  fail(
    rom
      ? `ERROR: --rom file not found: ${romFile}`
      : `SKIP: vanilla ROM not found (looked: ${romFile}); nothing was checked`,
  )
const set = windowSet(readFileSync(romFile))

const git = gitArgs =>
  execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...gitArgs], {
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

/** Added line ranges of one file, from the -U0 hunk headers only (content lines are never parsed). */
function addedRanges(path) {
  const diff = git([
    ...['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv'],
    ...['--src-prefix=a/', '--dst-prefix=b/', range, '--', path],
  ]).toString('latin1')
  return [...diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)]
    .map(m => [Number(m[1]), Number(m[1]) + Number(m[2] ?? 1) - 1])
    .filter(([a, b]) => b >= a)
}

/** `{ path, hits, binary }` per touched file. A text file is scanned whole, so -U0's lost context
 *  cannot split a run, and only runs overlapping an added line count. */
function rangeResults() {
  const after = range.split('..').pop() || 'HEAD'
  const stat = git(['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', range])
  const out = []
  for (const rec of stat.toString('utf8').split('\0').filter(Boolean)) {
    const [added, , ...rest] = rec.split('\t')
    const path = rest.join('\t')
    let blob
    try {
      blob = git(['show', `${after}:${path}`])
    } catch {
      continue // deleted in the range: no added lines
    }
    if (added === '-') out.push({ path, hits: bytesHits(blob, set), binary: true })
    else {
      const ranges = addedRanges(path)
      const hits = textHits(blob.toString('latin1'), set).filter(h =>
        ranges.some(([a, b]) => h.at <= b && h.end >= a),
      )
      out.push({ path, hits, binary: false })
    }
  }
  return out
}

const results = range
  ? rangeResults()
  : files.map(path => ({
      path,
      binary: bin,
      hits: bin ? bytesHits(readFileSync(path), set) : textHits(readFileSync(path, 'utf8'), set),
    }))

let withHits = 0
let windows = 0
for (const { path, hits, binary } of results) {
  if (hits.length) withHits++
  for (const h of hits) {
    windows += h.windows
    console.log(
      `HIT ${path}${binary ? ` offset=0x${h.at.toString(16)}` : `:${h.at}`} windows=${h.windows}`,
    )
  }
}
console.log(`TOTAL files=${results.length} filesWithHits=${withHits} hitWindows=${windows}`)
process.exit(windows ? 1 : 0)
