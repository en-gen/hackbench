#!/usr/bin/env node
// Report-only: lists 8-byte windows of text or assembled bytes that also occur
// in the vanilla ROM (BA safety rule, 2026-10-17). NOT a gate: nothing runs it.
//   node tools/scripts/rom-window-probe.mjs [--rom f] [--repo dir] <files...>
//   ... --git-range a..b      added lines only (git diff -U0)
//   ... --bin <files...>      raw assembled bytes
// Prints offsets and counts, never ROM bytes. Exit 1 on a hit, 0 otherwise.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesHits, locateVanillaRom, textHits, windowSet } from './lib/rom-windows.mjs'

const args = process.argv.slice(2)
let rom,
  range,
  repo = process.cwd(),
  bin = false
const files = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--rom') rom = args[++i]
  else if (a === '--git-range') range = args[++i]
  else if (a === '--repo') repo = args[++i]
  else if (a === '--bin') bin = true
  else files.push(a)
}
// Lookup is relative to this checkout, like the test suites, unless --repo says otherwise.
const repoRoot = resolve(
  repo === process.cwd() ? fileURLToPath(new URL('../..', import.meta.url)) : repo,
)
const romFile = rom ?? locateVanillaRom(process.env, repoRoot)
if (!existsSync(romFile)) {
  console.log(`SKIP: vanilla ROM not found (looked: ${romFile})`)
  process.exit(0)
}
const set = windowSet(readFileSync(romFile))

/** `[path, hits]` pairs. */
const results = []
if (range) {
  const diff = execFileSync(
    'git',
    ['-C', repo, 'diff', '-U0', '--no-renames', '--no-color', range],
    {
      encoding: 'utf8',
      maxBuffer: 1 << 29,
    },
  )
  let file = null
  let blocks = []
  let buf = null
  let n = 0
  const flush = () => {
    if (buf) blocks.push(buf)
    buf = null
  }
  const done = () => {
    flush()
    if (file && blocks.length)
      results.push([file, blocks.flatMap(b => textHits(b.lines.join('\n'), set, b.start))])
    blocks = []
  }
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) {
      done()
      file = null
    } else if (l.startsWith('+++ ')) file = l.startsWith('+++ b/') ? l.slice(6) : null
    else if (l.startsWith('@@')) {
      flush()
      n = parseInt(/\+(\d+)/.exec(l)[1], 10)
    } else if (l.startsWith('+') && file) {
      if (buf && buf.next !== n) flush()
      buf ??= { start: n, lines: [], next: n }
      buf.lines.push(l.slice(1))
      buf.next = ++n
    }
  }
  done()
} else {
  for (const f of files)
    results.push([
      f,
      bin ? bytesHits(readFileSync(f), set) : textHits(readFileSync(f, 'utf8'), set),
    ])
}

let withHits = 0
let windows = 0
for (const [path, hits] of results) {
  if (hits.length) withHits++
  for (const h of hits) {
    windows += h.windows
    console.log(
      `HIT ${path}${bin ? ` offset=0x${h.at.toString(16)}` : `:${h.at}`} windows=${h.windows}`,
    )
  }
}
console.log(`TOTAL files=${results.length} filesWithHits=${withHits} hitWindows=${windows}`)
process.exit(windows ? 1 : 0)
