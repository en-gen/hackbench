#!/usr/bin/env node
// Content gate (issue #678). One node script, one git object read per blob
// (a single `git cat-file --batch` pipe), instead of a subprocess per file
// per mode. Rules and rationale: docs/testing.md ("The content gate").
//
// Exports checkPath/checkBlob/evaluateEntry as pure functions for unit
// tests; everything else is CLI plumbing. Modes: staged, range BASE HEAD,
// push <remote> (reads stdin ref-update lines), history.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Rules (docs/testing.md has the prose version)
// ---------------------------------------------------------------------------

const ROM_EXT = /\.(smc|sfc|rom|srm|mss|ips|bps|spc|cdl)$/i
const NATIVE_EXT = /\.(wasm|dll|so|dylib)$/i
const ASM_EXT = /\.(asm|s|inc|a65|65s|65816)$/i
const IMAGE_DUMP_EXT =
  /\.(ppm|pgm|pbm|pnm|bmp|tga|gif|png|jpg|jpeg|webp|tif|tiff|ico|pcx|xpm|svg|chr|bin|raw|dmp|pal|act|2bpp|4bpp|gfx)$/i
const ICON_EXT = /\.(png|svg|ico|icns)$/i
const NO_NATIVE_EXT = /\.(js|json|md|node)$/i
const STYLE_EXT = /\.(md|ts|js|lua|ps1|sh|json|yml|yaml)$/i

const BYTE_TOKEN_THRESHOLD = 1024
const BASE64_THRESHOLD = 300
const DISASM_LINE_THRESHOLD = 20

const DISASM_LINE =
  /^\$?[0-9A-Fa-f]{2,6}(?:\/[0-9A-Fa-f]{2,6})?:\s+(?:[0-9A-Fa-f]{2,}\s+)?[A-Za-z]{2,5}\b/

const EMDASH = '—'

function isAllowlisted(path) {
  if (/^build\/icons\//.test(path)) return ICON_EXT.test(path)
  if (/^theia\/no-native\//.test(path)) return NO_NATIVE_EXT.test(path)
  return false
}

function isFixture(path) {
  return path !== 'test/fixtures/README.md' && /^test\/fixtures\//.test(path)
}

function isMesenTrace(path) {
  return /^tools\/mesen\//.test(path) && !(/\.lua$/i.test(path) || path === 'tools/mesen/README.md')
}

function isLockfile(path) {
  return /(^|\/)(package-lock\.json|yarn\.lock)$/.test(path)
}

/** Path-only rules: no content needed. Hard blocks first, never allow-listed. */
export function checkPath(path) {
  const hits = []
  if (ROM_EXT.test(path)) hits.push({ rule: 'rom-ext', path })
  if (NATIVE_EXT.test(path)) hits.push({ rule: 'native-ext', path })
  if (ASM_EXT.test(path)) hits.push({ rule: 'asm-ext', path })
  if (isMesenTrace(path)) hits.push({ rule: 'mesen-trace', path })
  if (isFixture(path)) hits.push({ rule: 'fixture', path })
  if (IMAGE_DUMP_EXT.test(path) && !isAllowlisted(path)) hits.push({ rule: 'image-ext', path })
  return hits
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0)
}

/**
 * Longest run of consecutive lines that are EACH, entirely, base64
 * alphabet (PEM/76-column-wrapped style) - joined only with each other,
 * never with the rest of the file, so a table or prose paragraph next to
 * one never contributes.
 */
function wrappedBase64Run(text) {
  const pureLine = /^[A-Za-z0-9+/_-]{20,}={0,2}$/
  let longest = 0
  let run = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (pureLine.test(line)) {
      run += line.length
      longest = Math.max(longest, run)
    } else {
      run = 0
    }
  }
  return longest
}

// Never allowed for the path, extension or binary rules - those never
// call allowedRules() at all, but this is the defensive second gate.
const EXEMPTABLE_RULES = new Set(['base64', 'data-uri', 'byte-tokens', 'disasm-listing', 'em-dash'])

/** content-gate: allow <rule> -- <reason> pragmas found in the text. */
function allowedRules(text) {
  const allowed = new Set()
  const re = /content-gate:\s*allow\s+([a-z][a-z-]*)\s*--\s*(.+)/gi
  let m
  while ((m = re.exec(text))) {
    const name = m[1].toLowerCase()
    if (EXEMPTABLE_RULES.has(name)) allowed.add(name)
  }
  return allowed
}

/**
 * A single "AND #$0F" or "0xa9" is an ASM operand citation (CLAUDE.md's own
 * claim-discipline style, cited by the hundreds in ROM-handler code) - not
 * ROM-derived data, and must not count. Only a RUN of 2+ same-style tokens
 * back to back (comma/space separated, array- or dump-shaped) counts, so a
 * table split across several such runs in one file still adds up ("per
 * FILE, not per run"), while isolated citations never contribute at all.
 */
function countByteTokens(text) {
  let count = 0
  let t = text
  const consumeRuns = (tokenRe, bytesPerToken) => {
    const runRe = new RegExp(`(?:${tokenRe.source}[,\\s]+){1,}${tokenRe.source}`, 'g')
    t = t.replace(runRe, m => {
      const tokens = m.match(new RegExp(tokenRe.source, 'g')) || []
      if (tokens.length >= 2) {
        count +=
          typeof bytesPerToken === 'function'
            ? bytesPerToken(tokens.length)
            : tokens.length * bytesPerToken
      }
      return ' '.repeat(m.length)
    })
  }
  consumeRuns(/0x[0-9a-fA-F]{4}\b/, 2) // 16-bit words, matched before the 8-bit rule
  consumeRuns(/0x[0-9a-fA-F]{2}\b/, 1)
  consumeRuns(/\$[0-9a-fA-F]{2}\b/, 1)
  consumeRuns(/\\x[0-9a-fA-F]{2}/, 1)
  // xxd-style space-separated raw hex pairs, no prefix, 4+ pairs in a row.
  t = t.replace(/(?:\b[0-9a-fA-F]{2}\b[ \t]+){3,}[0-9a-fA-F]{2}\b/g, m => {
    count += (m.match(/[0-9a-fA-F]{2}/g) || []).length
    return ' '.repeat(m.length)
  })
  // Decimal byte arrays: [12, 200, 255, 3, ...]
  for (const m of t.matchAll(/\[([\d\s,]+)\]/g)) {
    const nums = m[1]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    const valid = nums.filter(n => /^\d+$/.test(n) && +n <= 255)
    if (valid.length >= 2) count += valid.length
  }
  return count
}

function countDisasmLines(text) {
  let n = 0
  for (const line of text.split('\n')) if (DISASM_LINE.test(line)) n++
  return n
}

/** Content rules: read the blob's bytes. Binary check runs regardless of allow-list. */
export function checkBlob(path, buf) {
  const hits = []
  if (isBinary(buf)) {
    if (!isAllowlisted(path)) hits.push({ rule: 'binary', path })
    return hits // binary content is never text-sniffed
  }
  if (isLockfile(path)) return hits

  const text = buf.toString('utf8')
  const allowed = allowedRules(text)
  const push = (rule, extra) => {
    if (allowed.has(rule)) return
    hits.push({ rule, path, ...extra })
  }

  // Joins quote characters and "a" + "b" concatenation glue, but never
  // whitespace/newlines across a whole file - that would splice unrelated
  // lines together (a markdown table of hex addresses, stripped of every
  // space and pipe, reads as one long base64-alphabet run otherwise).
  const glued = text.replace(/["'`]\s*\+\s*["'`]/g, '').replace(/["'`]/g, '')
  const base64Re = new RegExp(`[A-Za-z0-9+/_-]{${BASE64_THRESHOLD},}={0,2}`)
  if (/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/_-]{40,}={0,2}/.test(glued)) {
    push('data-uri')
  } else if (base64Re.test(glued) || wrappedBase64Run(text) >= BASE64_THRESHOLD) {
    push('base64')
  }

  const byteCount = countByteTokens(text)
  if (byteCount > BYTE_TOKEN_THRESHOLD) push('byte-tokens', { count: byteCount })

  const disasmLines = countDisasmLines(text)
  if (disasmLines >= DISASM_LINE_THRESHOLD) push('disasm-listing', { count: disasmLines })

  return hits
}

/** Combines checkPath + checkBlob for one (path, blob-bytes) entry. */
export function evaluateEntry(path, buf) {
  return [...checkPath(path), ...checkBlob(path, buf)]
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

class GateError extends Error {}

const GIT_QUIET_FLAGS = ['-c', 'core.quotePath=false']
const GIT_DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv']

function git(args) {
  const res = spawnSync('git', [...GIT_QUIET_FLAGS, ...args], { maxBuffer: 1 << 30 })
  if (res.error) throw new GateError(`git ${args.join(' ')}: ${res.error.message}`)
  if (res.status !== 0) {
    throw new GateError(`git ${args.join(' ')} failed (exit ${res.status}): ${res.stderr}`)
  }
  return res.stdout
}

function revParseVerify(spec) {
  const res = spawnSync('git', [...GIT_QUIET_FLAGS, 'rev-parse', '--verify', '--quiet', spec], {})
  return res.status === 0 ? res.stdout.toString().trim() : null
}

function objectExists(sha) {
  return spawnSync('git', [...GIT_QUIET_FLAGS, 'cat-file', '-e', sha]).status === 0
}

/** Verifies a ref/sha exists and peels to a commit. Throws (fail closed) otherwise. */
function requireCommit(sha, label) {
  if (!objectExists(sha)) throw new GateError(`${label} ${sha} is not a known object`)
  const commit = revParseVerify(`${sha}^{commit}`)
  if (!commit) throw new GateError(`${label} ${sha} does not peel to a commit`)
  return commit
}

const ZERO_SHA = '0'.repeat(40)

/**
 * Walks `git log --raw -z -m --root --no-renames --no-abbrev` over the given
 * revision args and returns [{ commit, path, blob, status }], one entry per
 * (mode-line, path) record. Skips submodules (mode 160000) and deletes.
 */
function walkRawDiff(revArgs, { reverse = false } = {}) {
  const args = [
    'log',
    '--raw',
    '-z',
    '-m',
    '--root',
    '--no-renames',
    '--no-abbrev',
    ...GIT_DIFF_FLAGS,
    '--format=%x01%H',
  ]
  if (reverse) args.push('--reverse')
  args.push(...revArgs)

  const out = git(args).toString('binary')
  const fields = out.split('\0')
  const entries = []
  let commit = null
  const modeLineRe = /^\n?:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Za-z])\d*$/

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f.startsWith('\x01')) {
      commit = f.slice(1).replace(/\n+$/, '')
      continue
    }
    const m = modeLineRe.exec(f)
    if (!m) continue
    const [, , newMode, , newBlob, status] = m
    if (newMode === '160000') continue // submodule/gitlink
    if (status === 'D') continue // nothing to inspect
    const path = fields[++i]
    if (path === undefined) break
    entries.push({
      commit,
      path: Buffer.from(path, 'binary').toString('utf8'),
      blob: newBlob,
      status,
    })
  }
  return entries
}

/** Staged (index) entries: git diff --cached --raw, no commit context. */
function stagedEntries() {
  const out = git([
    'diff',
    '--cached',
    '--raw',
    '-z',
    '--no-renames',
    '--no-abbrev',
    '--diff-filter=d',
    ...GIT_DIFF_FLAGS,
  ]).toString('binary')
  const fields = out.split('\0').filter(f => f.length)
  const entries = []
  const modeLineRe = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Za-z])\d*$/
  for (let i = 0; i < fields.length; i++) {
    const m = modeLineRe.exec(fields[i])
    if (!m) continue
    const [, , newMode, , newBlob] = m
    if (newMode === '160000') continue
    const path = fields[++i]
    if (path === undefined) break
    entries.push({
      commit: null,
      path: Buffer.from(path, 'binary').toString('utf8'),
      blob: newBlob,
    })
  }
  return entries
}

/** Batch-reads blob content for every distinct sha in `shas`, in one pipe. */
function batchReadBlobs(shas) {
  const unique = [...new Set(shas)]
  if (unique.length === 0) return new Map()
  const res = spawnSync('git', [...GIT_QUIET_FLAGS, 'cat-file', '--batch'], {
    input: unique.join('\n') + '\n',
    maxBuffer: 1 << 30,
  })
  if (res.status !== 0) throw new GateError(`git cat-file --batch failed: ${res.stderr}`)
  const buf = res.stdout
  const out = new Map()
  let off = 0
  for (const sha of unique) {
    const nl = buf.indexOf(10, off)
    if (nl === -1) throw new GateError(`cat-file --batch: truncated output for ${sha}`)
    const header = buf.toString('latin1', off, nl)
    const parts = header.split(' ')
    if (parts[1] === 'missing') {
      throw new GateError(`missing endpoint object: ${sha}`)
    }
    const size = +parts[2]
    if (!Number.isFinite(size)) throw new GateError(`cat-file --batch: bad header "${header}"`)
    const body = buf.subarray(nl + 1, nl + 1 + size)
    out.set(sha, Buffer.from(body))
    off = nl + 1 + size + 1
  }
  return out
}

/** Evaluates a de-duplicated (path, blob) entry set; returns {hits, byKey}. */
function evaluateEntries(entries) {
  const seen = new Map() // `${path}\0${blob}` -> first entry (for "first added")
  for (const e of entries) {
    const key = `${e.path}\0${e.blob}`
    if (!seen.has(key)) seen.set(key, e)
  }
  const blobs = batchReadBlobs([...seen.values()].map(e => e.blob))
  const hits = []
  for (const e of seen.values()) {
    const buf = blobs.get(e.blob)
    if (buf === undefined) throw new GateError(`missing endpoint object: ${e.blob} (${e.path})`)
    for (const hit of evaluateEntry(e.path, buf))
      hits.push({ ...hit, commit: e.commit, blob: e.blob })
  }
  return hits
}

/** em-dash on added lines only (staged/range). */
function emDashHits(diffArgs) {
  const out = git(['diff', '-U0', ...GIT_DIFF_FLAGS, ...diffArgs]).toString('utf8')
  const hits = []
  let path = null
  for (const line of out.split('\n')) {
    const m = /^\+\+\+ b\/(.*)$/.exec(line)
    if (m) {
      path = m[1]
      continue
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    if (!path || !STYLE_EXT.test(path)) continue
    if (line.includes(EMDASH)) hits.push({ rule: 'em-dash', path })
  }
  return hits
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function formatHit(h) {
  const suffix = h.commit ? ` (first added in ${h.commit})` : ''
  return `BLOCKED (${h.rule}): ${h.path}${suffix}`
}

function runStaged() {
  const hits = [...evaluateEntries(stagedEntries()), ...emDashHits(['--cached'])]
  return dedupeReport(hits)
}

function runRange(base, head) {
  requireCommit(base, 'range base')
  requireCommit(head, 'range head')
  const hits = [...evaluateEntries(walkRawDiff([head, '--not', base])), ...emDashHits([base, head])]
  return dedupeReport(hits)
}

function runPush(remote, stdinText) {
  const hits = []
  for (const line of stdinText.split('\n')) {
    if (!line.trim()) continue
    const [, localSha, , remoteSha] = line.trim().split(/\s+/)
    if (!localSha) throw new GateError(`push: malformed ref-update line "${line}"`)
    if (localSha === ZERO_SHA) continue // delete: nothing pushed to inspect
    if (remoteSha && remoteSha !== ZERO_SHA && !objectExists(remoteSha)) {
      throw new GateError(`push: remote sha ${remoteSha} is not a known object`)
    }
    requireCommit(localSha, 'pushed ref')
    const entries = walkRawDiff([localSha, '--not', `--remotes=${remote}`])
    hits.push(...evaluateEntries(entries))
  }
  return dedupeReport(hits)
}

function runHistory() {
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true') {
    throw new GateError('history mode refuses a shallow clone: run against full history')
  }
  const entries = walkRawDiff(['--all'], { reverse: true })
  const hits = evaluateEntries(entries)

  // Fail on any blob/tree reachable only via a tag/ref pointing at it
  // directly, never via a commit's tree walk. `rev-list --objects` prints
  // an empty path both for that case AND for a commit's legitimate root
  // tree, so root trees (collected from every commit reachable via --all)
  // are the one allowed exception - a blob can never legitimately have an
  // empty path, root or not.
  const rootTrees = new Set(
    git(['log', '--all', '--format=%T']).toString('utf8').split('\n').filter(Boolean),
  )
  const objLines = git(['rev-list', '--objects', '--all'])
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
  const pathless = []
  for (const line of objLines) {
    const sp = line.indexOf(' ')
    const sha = sp === -1 ? line : line.slice(0, sp)
    const path = sp === -1 ? null : line.slice(sp + 1)
    if (!path) pathless.push(sha)
  }
  // One batch-check spawn for every pathless object, never one per object.
  if (pathless.length > 0) {
    const res = spawnSync('git', [...GIT_QUIET_FLAGS, 'cat-file', '--batch-check'], {
      input: pathless.join('\n') + '\n',
      maxBuffer: 1 << 30,
    })
    for (const line of res.stdout.toString('utf8').split('\n')) {
      if (!line) continue
      const [sha, type] = line.split(' ')
      if (type === 'tree' && rootTrees.has(sha)) continue // a commit's own root tree
      if (type === 'blob' || type === 'tree') {
        throw new GateError(`unreachable-by-path ${type} ${sha}: a ref/tag points at it directly`)
      }
    }
  }
  return dedupeReport(hits)
}

function dedupeReport(hits) {
  const seen = new Set()
  const out = []
  for (const h of hits) {
    const key = `${h.rule}\0${h.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h)
  }
  return out
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const [mode, ...rest] = argv
  let hits
  if (mode === 'staged') {
    hits = runStaged()
  } else if (mode === 'range') {
    hits = runRange(rest[0], rest[1])
  } else if (mode === 'push') {
    const stdinText = readFileSync(0, 'utf8')
    hits = runPush(rest[0], stdinText)
  } else if (mode === 'history') {
    hits = runHistory()
  } else {
    process.stderr.write(
      'usage: check-content.mjs [staged | range BASE HEAD | push REMOTE | history]\n',
    )
    process.exit(2)
  }

  for (const h of hits) console.log(formatHit(h))
  if (hits.length > 0) {
    if (mode !== 'history') {
      console.log('')
      console.log('Blocked by tools/scripts/check-content.mjs.')
      console.log("Override with 'git commit --no-verify' only with a stated reason.")
    }
    process.exit(1)
  }
  process.exit(0)
}

const invokedDirectly = /check-content\.mjs$/.test(process.argv[1] ?? '')
if (invokedDirectly) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    if (err instanceof GateError) {
      process.stderr.write(`check-content: ${err.message}\n`)
      process.exit(2)
    }
    throw err
  }
}
