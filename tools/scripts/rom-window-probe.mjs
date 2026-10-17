#!/usr/bin/env node
// Report-only: lists 8-byte windows of text or assembled bytes that also occur
// in the vanilla ROM (BA safety rule, 2026-10-17). NOT a gate: nothing runs it.
//   node tools/scripts/rom-window-probe.mjs [--rom f] [--repo dir] <files...>
//   ... --git-range <spec>    files the range touches; runs overlapping an added line
//                             a..b (post-image b), a...b (merge-base(a,b)..b), or one rev
//                             (rev against the WORKTREE; untracked files are scanned whole)
//   ... --bin <files...>      raw assembled bytes (the authoritative check)
// Prints offsets and counts, never ROM bytes.
// Exit 0 clean, 1 a hit, 2 nothing could be checked (no input, no ROM, bad --rom, git error).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bytesHits,
  commentMode,
  locateVanillaRom,
  textHits,
  windowSet,
} from './lib/rom-windows.mjs'

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

/** `{ path, hits, binary }` per checked file, filled as we go so an error can still show earlier hits. */
const results = []
const printHits = () => {
  let withHits = 0
  let windows = 0
  for (const { path, hits, binary } of results) {
    if (hits.length) withHits++
    for (const h of hits) {
      windows += h.windows
      const where = binary ? ` offset=0x${h.at.toString(16)}` : `:${h.at}`
      console.log(`HIT ${path}${where} windows=${h.windows}`)
    }
  }
  return { withHits, windows }
}
const fail = msg => {
  printHits()
  console.error(msg)
  process.exit(2)
}
// An unreadable file or a git error must not look like a clean run (node's own exit would be 1).
process.on('uncaughtException', e => fail(`ERROR: ${e.message}`))

if (!range && !files.length) fail('ERROR: no input; give files, --bin files, or --git-range <spec>')
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
const rev = r =>
  git(['rev-parse', '--verify', '--quiet', `${r}^{commit}`])
    .toString()
    .trim()

/** The diff base, the post-image (a rev, or null for the worktree) and the diff's rev arguments. */
function parseRange(spec) {
  if (spec.includes('...')) {
    const [a, b] = spec.split('...')
    const post = rev(b || 'HEAD')
    const base = git(['merge-base', rev(a || 'HEAD'), post])
      .toString()
      .trim()
    return { post, revs: [base, post] }
  }
  if (spec.includes('..')) {
    const [a, b] = spec.split('..')
    const post = rev(b || 'HEAD')
    return { post, revs: [rev(a || 'HEAD'), post] }
  }
  return { post: null, revs: [rev(spec)] }
}

/** Added line ranges of one file, from the -U0 hunk headers only (content lines are never parsed). */
function addedRanges(revs, path) {
  const diff = git([
    ...['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv'],
    ...['--src-prefix=a/', '--dst-prefix=b/', ...revs, '--', `:(top,literal)${path}`],
  ]).toString('latin1')
  return [...diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)]
    .map(m => [Number(m[1]), Number(m[1]) + Number(m[2] ?? 1) - 1])
    .filter(([a, b]) => b >= a)
}

/** A text file is scanned whole, so -U0's lost context cannot split a run, and only runs
 *  overlapping an added line count. Deleted files are skipped (--diff-filter=d); any other
 *  file whose post-image cannot be read is an error, never a silent skip. */
function scanRange(spec) {
  const { post, revs } = parseRange(spec)
  const top = git(['rev-parse', '--show-toplevel']).toString().trim()
  const stat = git([
    'diff',
    '--numstat',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    '--diff-filter=d',
    ...revs,
  ])
  for (const rec of stat.toString('utf8').split('\0').filter(Boolean)) {
    const [added, , ...rest] = rec.split('\t')
    const path = rest.join('\t')
    const blob = post ? git(['show', `${post}:${path}`]) : readFileSync(join(top, path))
    if (added === '-') results.push({ path, hits: bytesHits(blob, set), binary: true })
    else {
      const ranges = addedRanges(revs, path)
      const hits = textHits(blob.toString('latin1'), set, 1, undefined, commentMode(path)).filter(
        h => ranges.some(([a, b]) => h.at <= b && h.end >= a),
      )
      results.push({ path, hits, binary: false })
    }
  }
}

/** Lone-rev mode reads the worktree, so a file you just created (untracked) counts too, every
 *  line as added. Binary means a NUL in the first 8000 bytes, as git decides. */
function scanUntracked() {
  const top = git(['rev-parse', '--show-toplevel']).toString().trim()
  const list = git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z'])
  for (const path of list.toString('utf8').split('\0').filter(Boolean)) {
    const blob = readFileSync(join(top, path))
    const binary = blob.subarray(0, 8000).includes(0)
    const hits = binary
      ? bytesHits(blob, set)
      : textHits(blob.toString('latin1'), set, 1, undefined, commentMode(path))
    results.push({ path, hits, binary })
  }
}

if (range) {
  scanRange(range)
  if (!range.includes('..')) scanUntracked()
} else
  for (const path of files)
    results.push({
      path,
      binary: bin,
      hits: bin
        ? bytesHits(readFileSync(path), set)
        : textHits(readFileSync(path, 'utf8'), set, 1, undefined, commentMode(path)),
    })

const { withHits, windows } = printHits()
console.log(`TOTAL files=${results.length} filesWithHits=${withHits} hitWindows=${windows}`)
process.exit(windows ? 1 : 0)
