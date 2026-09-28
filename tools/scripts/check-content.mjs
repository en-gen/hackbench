#!/usr/bin/env node
// Content gate (issue #678). One node script, one git object read per blob
// (a single `git cat-file --batch` pipe), instead of a subprocess per file
// per mode. Rules and rationale: docs/testing.md ("The content gate").
//
// Threat model: stops ACCIDENTS (captures, dumps, fixtures, disassembly
// landing in a commit or push), airtight for the migration push. Not
// meant to resist a determined insider inventing an encoding.
//
// Exports checkPath/checkBlob/checkTextContent/evaluateEntry as pure
// functions for unit tests; everything else is CLI plumbing. Modes:
// staged, range BASE HEAD, push <remote> (reads stdin ref-update lines),
// history.

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Rules (docs/testing.md has the prose version)
// ---------------------------------------------------------------------------

const ROM_EXT = /\.(smc|sfc|rom|srm|mss|ips|bps|spc|cdl)$/i
const NATIVE_EXT = /\.(wasm|dll|so|dylib)$/i
const ASM_EXT = /\.(asm|s|inc|a65|65s|65816)$/i
const IMAGE_DUMP_EXT =
  /\.(ppm|pgm|pbm|pnm|bmp|tga|gif|png|jpg|jpeg|webp|tif|tiff|ico|pcx|xpm|svg|chr|bin|raw|dmp|pal|act|2bpp|4bpp|gfx)$/i
const ICON_EXT = /\.(png|svg|ico|icns)$/i
const STYLE_EXT = /\.(md|ts|tsx|js|mjs|cjs|html|css|lua|ps1|sh|json|yml|yaml)$/i

const BYTE_TOKEN_THRESHOLD = 1024
const BASE64_THRESHOLD = 300
const DISASM_LINE_THRESHOLD = 20
const OVERSIZE_THRESHOLD = 8 * 1024 * 1024 // 8 MB
const ICON_SIZE_LIMIT = 512 * 1024

// A real 65816 mnemonic, case-insensitive. Deliberately a closed list
// rather than "any 2-5 letters": that alone matched short JS/TS keywords
// and identifiers throughout this codebase (`if`, `let`, `and()`, ...).
const MNEMONICS = new Set(
  (
    'ADC AND ASL BCC BCS BEQ BIT BMI BNE BPL BRA BRK BRL BVC BVS CLC CLD CLI CLV CMP COP CPX CPY ' +
    'DEC DEX DEY EOR INC INX INY JML JMP JSL JSR LDA LDX LDY LSR MVN MVP NOP ORA PEA PEI PER PHA ' +
    'PHB PHD PHK PHP PHX PHY PLA PLB PLD PLP PLX PLY REP ROL ROR RTI RTL RTS SBC SEC SED SEI SEP ' +
    'STA STP STX STY STZ TAX TAY TCD TCS TDC TRB TSB TSC TSX TXA TXS TXY TYA TYX WAI WDM XBA XCE'
  ).split(' '),
)
const MNEMONIC_RE = new RegExp(`\\b(?:${[...MNEMONICS].join('|')})\\b`, 'i')

// Address-and-bytes or address-and-mnemonic disassembly line, e.g.
// "81/8014:\tBD8815  \tlda $1588,X" or "058803:  LDA [$65],Y" or the
// SMWDisX/asar label style "CODE_00A1B2:  LDA #$00" / bare "DATA_05F800:".
const DISASM_LINE =
  /^(?:\$?[0-9A-Fa-f]{2,6}(?:\/[0-9A-Fa-f]{2,6})?|[A-Za-z_][A-Za-z0-9_]{2,}):(?:\s+[0-9A-Fa-f]{2,}\s+)?(?:\s+.*)?$/
const DATA_DIRECTIVE = /^\s*\.?(db|dw|dl|byte|word)\s+(.+)$/i
const DATA_DIRECTIVE_BYTES = { db: 1, byte: 1, dw: 2, word: 2, dl: 3 }

// Built from its UTF-8 bytes so this file contains no literal em-dash and
// therefore does not flag itself (and now that .mjs is style-checked too,
// really would).
const EMDASH = Buffer.from([0xe2, 0x80, 0x94]).toString('utf8')
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICO_MAGIC = Buffer.from([0x00, 0x00, 0x01, 0x00])
const ICNS_MAGIC = Buffer.from('icns', 'ascii')

/** Windows lets a path end in trailing dots/spaces that get silently
 * stripped on access; normalize before any extension check. */
function normalizePath(path) {
  return path.replace(/[ .]+$/, '')
}

function isAllowlistedExt(path) {
  return /^build\/icons\//i.test(path) && ICON_EXT.test(path)
}

function isFixture(path) {
  return !/^test\/fixtures\/readme\.md$/i.test(path) && /^test\/fixtures\//i.test(path)
}

function isMesenTrace(path) {
  return (
    /^tools\/mesen\//i.test(path) &&
    !(/\.lua$/i.test(path) || /^tools\/mesen\/readme\.md$/i.test(path))
  )
}

function isLockfile(path) {
  return /(^|\/)(package-lock\.json|yarn\.lock)$/i.test(path)
}

/** Path-only rules: no content needed. Hard blocks first, never allow-listed. */
export function checkPath(rawPath) {
  const path = normalizePath(rawPath)
  const hits = []
  if (ROM_EXT.test(path)) hits.push({ rule: 'rom-ext', path: rawPath })
  if (NATIVE_EXT.test(path)) hits.push({ rule: 'native-ext', path: rawPath })
  if (ASM_EXT.test(path)) hits.push({ rule: 'asm-ext', path: rawPath })
  if (isMesenTrace(path)) hits.push({ rule: 'mesen-trace', path: rawPath })
  if (isFixture(path)) hits.push({ rule: 'fixture', path: rawPath })
  if (IMAGE_DUMP_EXT.test(path) && !isAllowlistedExt(path))
    hits.push({ rule: 'image-ext', path: rawPath })
  return hits
}

/** binary = a NUL anywhere, OR the blob is not valid UTF-8 anywhere. */
function isBinary(buf) {
  if (buf.includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return false
  } catch {
    return true
  }
}

/** build/icons/**: binary allowed only if magic bytes match the extension
 * and the file is 512 KB or less. Never allow-listed anywhere else -
 * theia/no-native's real content is 0-byte stubs, which pass on their
 * own (no NUL, valid empty UTF-8), so it needs no exemption at all. */
function isAllowlistedIconBlob(path, buf) {
  if (!/^build\/icons\//i.test(path) || buf.length > ICON_SIZE_LIMIT) return false
  if (/\.png$/i.test(path)) return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)
  if (/\.ico$/i.test(path)) return buf.length >= 4 && buf.subarray(0, 4).equals(ICO_MAGIC)
  if (/\.icns$/i.test(path)) return buf.length >= 4 && buf.subarray(0, 4).equals(ICNS_MAGIC)
  return false // .svg is never binary in the first place if it's real SVG
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

const EXEMPTABLE_RULES = new Set(['base64', 'data-uri', 'byte-tokens', 'disasm-listing', 'em-dash'])

// Only at the start of a line, inside a comment marker, with a non-empty
// reason. Never matches a JS/TS string VALUE that merely contains this
// text mid-line (this file's own tests rely on that to test the pragma
// without carrying a live one).
const PRAGMA_LINE =
  /^\s*(?:\/\/|#|;|<!--|\/\*|\*)\s*content-gate:\s*allow\s+([a-z][a-z0-9-]*)\s*--\s*(\S.*)$/i

/** content-gate: allow <rule> -- <reason> pragmas. Returns {allowed, badNames}. */
function scanPragmas(text) {
  const allowed = new Set()
  const badNames = new Set()
  for (const rawLine of text.split('\n')) {
    const m = PRAGMA_LINE.exec(rawLine)
    if (!m) continue
    const name = m[1].toLowerCase()
    if (EXEMPTABLE_RULES.has(name)) allowed.add(name)
    else badNames.add(name)
  }
  return { allowed, badNames }
}

/**
 * A single "AND #$0F" or "0xa9" is an ASM operand citation (CLAUDE.md's own
 * claim-discipline style, cited by the hundreds in ROM-handler code) - not
 * ROM-derived data, and must not count. Only a RUN of 2+ same-style tokens
 * counts (adjacent, with or without a separator depending on style), so a
 * table split across several runs in one file still adds up ("per FILE,
 * not per run"), while isolated citations never contribute at all.
 */
function countByteTokens(text) {
  let count = 0
  let t = text
  const consumeRuns = (tokenRe, sep, bytesPerToken) => {
    const runRe = new RegExp(`(?:${tokenRe.source}${sep}){1,}${tokenRe.source}`, 'g')
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
  consumeRuns(/0x[0-9a-fA-F]{4}\b/, '[,\\s]+', 2) // 16-bit words, before the 8-bit rule
  consumeRuns(/0x[0-9a-fA-F]{2}\b/, '[,\\s]+', 1)
  consumeRuns(/\$[0-9a-fA-F]{2}\b/, '[,\\s]+', 1)
  consumeRuns(/\\x[0-9a-fA-F]{2}/, '[,\\s]*', 1) // escapes are typically back-to-back, no separator
  // xxd -p / plain space-separated single-byte pairs, 4+ in a row.
  t = t.replace(/(?:\b[0-9a-fA-F]{2}\b[ \t]+){3,}[0-9a-fA-F]{2}\b/g, m => {
    count += (m.match(/[0-9a-fA-F]{2}/g) || []).length
    return ' '.repeat(m.length)
  })
  // Default `xxd`: 2-byte (4 hex digit) groups, "a900 8d00 0203 ...".
  t = t.replace(/(?:\b[0-9a-fA-F]{4}\b[ \t]+){2,}[0-9a-fA-F]{4}\b/g, m => {
    count += (m.match(/[0-9a-fA-F]{4}/g) || []).length * 2
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
  // One-per-line data directives: db/dw/dl/.byte/.word, hex or decimal.
  for (const rawLine of t.split('\n')) {
    const m = DATA_DIRECTIVE.exec(rawLine)
    if (!m) continue
    const bytesEach = DATA_DIRECTIVE_BYTES[m[1].toLowerCase()]
    const operands = m[2]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    count += operands.length * bytesEach
  }
  return count
}

function countDisasmLines(text) {
  let n = 0
  for (const line of text.split('\n')) {
    if (!DISASM_LINE.test(line)) continue
    // The label-only/label+mnemonic branch of DISASM_LINE is permissive
    // (any identifier followed by ':'), so require an actual mnemonic
    // somewhere on the line unless it's the address-prefixed byte-dump
    // shape, which is unambiguous on its own.
    if (
      /^\$?[0-9A-Fa-f]{2,6}(?:\/[0-9A-Fa-f]{2,6})?:\s+[0-9A-Fa-f]{2,}\s+/.test(line) ||
      MNEMONIC_RE.test(line)
    ) {
      n++
    }
  }
  return n
}

/** Text-content rules shared by blob content, commit messages and tag
 * bodies. `path` is a label only (may be synthetic, e.g. "<commit SHA>"). */
export function checkTextContent(path, text) {
  const hits = []
  const { allowed, badNames } = scanPragmas(text)
  for (const name of badNames) hits.push({ rule: 'bad-pragma', path, detail: name })
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

/** Content rules: read the blob's bytes. Binary check runs regardless of allow-list. */
export function checkBlob(rawPath, buf) {
  const path = normalizePath(rawPath)
  if (buf.length > OVERSIZE_THRESHOLD) {
    return [{ rule: 'oversize', path: rawPath, detail: buf.length }] // never sniffed: avoids a
    // catastrophic regex walk over a many-MB single line, and a text blob
    // that big is already the wrong shape for this repo regardless.
  }
  if (isBinary(buf)) {
    if (!isAllowlistedIconBlob(path, buf)) return [{ rule: 'binary', path: rawPath }]
    return []
  }
  if (isLockfile(path)) return []
  return checkTextContent(rawPath, buf.toString('utf8'))
}

/** Combines checkPath + checkBlob for one (path, blob-bytes) entry. */
export function evaluateEntry(path, buf) {
  return [...checkPath(path), ...checkBlob(path, buf)]
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

class GateError extends Error {}

// --no-replace-objects and grafts: a replace ref or a graft can make the
// history git shows us differ from what a plain clone/fetch would receive,
// which is exactly the case that must never silently under-scan.
const GIT_GLOBAL_FLAGS = [
  '-c',
  'core.quotePath=false',
  '-c',
  'log.showRoot=true',
  '--no-replace-objects',
]
const GIT_DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv']
const GIT_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }

function spawnGit(args, opts = {}) {
  return spawnSync('git', [...GIT_GLOBAL_FLAGS, ...args], { env: GIT_ENV, ...opts })
}

function git(args) {
  const res = spawnGit(args, { maxBuffer: 1 << 30 })
  if (res.error) throw new GateError(`git ${args.join(' ')}: ${res.error.message}`)
  if (res.status !== 0) {
    throw new GateError(`git ${args.join(' ')} failed (exit ${res.status}): ${res.stderr}`)
  }
  return res.stdout
}

function assertNoGrafts() {
  const res = spawnGit(['rev-parse', '--git-path', 'info/grafts'])
  const graftPath = res.stdout.toString().trim()
  if (graftPath && existsSync(graftPath)) {
    throw new GateError('refusing to run with a grafts file present (info/grafts)')
  }
}

function revParseVerify(spec) {
  const res = spawnGit(['rev-parse', '--verify', '--quiet', spec])
  return res.status === 0 ? res.stdout.toString().trim() : null
}

function objectExists(sha) {
  return spawnGit(['cat-file', '-e', sha]).status === 0
}

/** Verifies a ref/sha exists and peels to a commit. Throws (fail closed) otherwise. */
function requireCommit(sha, label) {
  if (!objectExists(sha)) throw new GateError(`${label} ${sha} is not a known object`)
  const commit = revParseVerify(`${sha}^{commit}`)
  if (!commit) throw new GateError(`${label} ${sha} does not peel to a commit`)
  return commit
}

const ZERO_SHA = '0'.repeat(40)

// Delimiters that never occur in a path, hash, or (git disallows NUL in
// commit messages) a commit message: SOH before the hash, STX before the
// message, ETX after it.
const REC_HASH = '\x01'
const REC_MSG = '\x02'
const REC_END = '\x03'
const COMMIT_FIELD_RE = new RegExp(`^${REC_HASH}([0-9a-f]{40})${REC_MSG}([\\s\\S]*)${REC_END}\\n?$`)

/**
 * Walks `git log --raw -z -m --root --no-renames --no-abbrev` over the given
 * revision args and returns { entries: [{commit, path, blob, status}],
 * messages: [{commit, text}] } - the commit's own %B comes back in the same
 * log call, so checking commit messages costs no extra spawn.
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
    `--format=${REC_HASH}%H${REC_MSG}%B${REC_END}`,
  ]
  if (reverse) args.push('--reverse')
  args.push(...revArgs)

  const out = git(args).toString('binary')
  const fields = out.split('\0')
  const entries = []
  const messages = []
  const seenCommits = new Set()
  let commit = null
  const modeLineRe = /^\n?:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Za-z])\d*$/

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f.startsWith(REC_HASH)) {
      const m = COMMIT_FIELD_RE.exec(f)
      if (m) {
        commit = m[1]
        if (!seenCommits.has(commit)) {
          seenCommits.add(commit)
          messages.push({ commit, text: Buffer.from(m[2], 'binary').toString('utf8') })
        }
      } else {
        // Fallback: shouldn't happen, but never lose the hash silently.
        commit = f.slice(1, 41)
      }
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
  return { entries, messages }
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

/** Batch-reads object content for every distinct sha in `shas` (any type),
 * in one pipe. Never one spawn per object. */
function batchReadObjects(shas) {
  const unique = [...new Set(shas)]
  if (unique.length === 0) return new Map()
  const res = spawnGit(['cat-file', '--batch'], {
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
    if (parts[1] === 'missing') throw new GateError(`missing endpoint object: ${sha}`)
    const size = +parts[2]
    if (!Number.isFinite(size)) throw new GateError(`cat-file --batch: bad header "${header}"`)
    out.set(sha, Buffer.from(buf.subarray(nl + 1, nl + 1 + size)))
    off = nl + 1 + size + 1
  }
  return out
}

/** Evaluates a de-duplicated (path, blob) entry set plus commit messages. */
function evaluateEntries(entries, messages = []) {
  const seen = new Map() // `${path}\0${blob}` -> first entry (for "first added")
  for (const e of entries) {
    const key = `${e.path}\0${e.blob}`
    if (!seen.has(key)) seen.set(key, e)
  }
  const blobs = batchReadObjects([...seen.values()].map(e => e.blob))
  const hits = []
  for (const e of seen.values()) {
    const buf = blobs.get(e.blob)
    if (buf === undefined) throw new GateError(`missing endpoint object: ${e.blob} (${e.path})`)
    for (const hit of evaluateEntry(e.path, buf))
      hits.push({ ...hit, commit: e.commit, blob: e.blob })
  }
  const reviewed = reviewedMessages()
  for (const msg of messages) {
    for (const hit of checkTextContent(`<commit message ${msg.commit}>`, msg.text)) {
      if (reviewed.has(`${msg.commit} ${hit.rule}`)) continue
      hits.push({ ...hit, commit: msg.commit })
    }
  }
  return hits
}

/** Commit messages already on protected history that a person reviewed and
 * found clean, as `<sha> <rule> -- <reason>` lines. Messages only: file
 * content is never exempt. A message cannot be amended once it is on
 * develop, so without this one false positive would red history mode forever. */
function reviewedMessages() {
  const file = new URL('content-gate-reviewed.txt', import.meta.url)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return new Set()
    throw err
  }
  const out = new Set()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([0-9a-f]{40}) ([a-z0-9-]+) -- \S.*$/.exec(line)
    if (!m) throw new GateError(`content-gate-reviewed.txt: malformed line "${line}"`)
    out.add(`${m[1]} ${m[2]}`)
  }
  return out
}

/** Annotated tag bodies (lightweight tags carry no message). One extra
 * git call total, never one per tag. */
function tagBodyHits() {
  const res = spawnGit([
    'for-each-ref',
    '--format=%(objectname) %(objecttype) %(refname)',
    'refs/tags',
  ])
  if (res.status !== 0) return []
  const tagShas = []
  const nameFor = new Map()
  for (const line of res.stdout.toString('utf8').split('\n')) {
    if (!line) continue
    const [sha, type, refname] = line.split(' ')
    if (type === 'tag') {
      tagShas.push(sha)
      nameFor.set(sha, refname)
    }
  }
  if (tagShas.length === 0) return []
  const objs = batchReadObjects(tagShas)
  const hits = []
  for (const sha of tagShas) {
    const buf = objs.get(sha)
    if (!buf) continue
    const text = buf.toString('utf8')
    const idx = text.indexOf('\n\n')
    const message = idx === -1 ? '' : text.slice(idx + 2)
    const label = `<tag ${nameFor.get(sha)}>`
    for (const hit of checkTextContent(label, message)) hits.push({ ...hit, commit: sha })
  }
  return hits
}

/** em-dash on added lines only (staged/range). Tracks the current path
 * from `diff --git a/PATH b/PATH` headers; a genuine added line whose
 * CONTENT starts with another literal '+' (e.g. "++x") is never mistaken
 * for the "+++ b/path" file header, which is matched as a whole line. */
function emDashHits(diffArgs) {
  const out = git([
    'diff',
    '-U0',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...GIT_DIFF_FLAGS,
    ...diffArgs,
  ]).toString('utf8')
  const hits = []
  let path = null
  for (const line of out.split('\n')) {
    const gitHeader = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
    if (gitHeader) {
      path = gitHeader[2]
      continue
    }
    if (line === '+++ /dev/null') continue
    if (/^\+\+\+ b\//.test(line) && !line.slice(4).includes('\t')) continue // file header, not content
    if (!line.startsWith('+')) continue
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
  assertNoGrafts()
  const hits = [...evaluateEntries(stagedEntries()), ...emDashHits(['--cached'])]
  return dedupeReport(hits)
}

function runRange(base, head) {
  assertNoGrafts()
  requireCommit(base, 'range base')
  requireCommit(head, 'range head')
  const { entries, messages } = walkRawDiff([head, '--not', base])
  const hits = [...evaluateEntries(entries, messages), ...emDashHits([base, head])]
  return dedupeReport(hits)
}

/** Live `git ls-remote`, not the local (possibly stale) refs/remotes/*.
 * Exits 2 if it fails - never treats an unreachable remote as "nothing to
 * exclude", which would scan (and pass) less than it should. */
function remoteShas(remote) {
  const res = spawnGit(['ls-remote', remote])
  if (res.status !== 0) throw new GateError(`git ls-remote ${remote} failed: ${res.stderr}`)
  const shas = new Set()
  for (const line of res.stdout.toString('utf8').split('\n')) {
    const sha = line.split('\t')[0]
    if (/^[0-9a-f]{40}$/.test(sha)) shas.add(sha)
  }
  return shas
}

function runPush(remote, stdinText) {
  assertNoGrafts()
  const localShas = []
  for (const line of stdinText.split('\n')) {
    if (!line.trim()) continue
    const [, localSha] = line.trim().split(/\s+/)
    if (!localSha) throw new GateError(`push: malformed ref-update line "${line}"`)
    if (localSha !== ZERO_SHA) localShas.push(localSha)
  }
  if (localShas.length === 0) return [] // every line was a delete: nothing pushed to inspect

  // One ls-remote call for the whole push, not per ref line. Only exclude
  // shas the remote reports that we actually have locally - otherwise
  // `--not <unknown-sha>` is silently ignored by git, but we'd rather know
  // we're excluding real, verified history.
  const known = [...remoteShas(remote)].filter(sha => objectExists(sha))

  const hits = []
  for (const localSha of localShas) {
    requireCommit(localSha, 'pushed ref')
    const { entries, messages } = walkRawDiff([localSha, '--not', ...known])
    hits.push(...evaluateEntries(entries, messages))
  }
  hits.push(...tagBodyHits())
  return dedupeReport(hits)
}

function runHistory() {
  assertNoGrafts()
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true') {
    throw new GateError('history mode refuses a shallow clone: run against full history')
  }
  const { entries, messages } = walkRawDiff(['--all'], { reverse: true })
  const hits = [...evaluateEntries(entries, messages), ...tagBodyHits()]

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
    const res = spawnGit(['cat-file', '--batch-check'], {
      input: pathless.join('\n') + '\n',
      maxBuffer: 1 << 30,
    })
    for (const line of res.stdout.toString('utf8').split('\n')) {
      if (!line) continue
      const parts = line.split(' ')
      const [sha, type] = parts
      if (type === 'missing') throw new GateError(`cat-file --batch-check: missing object ${sha}`)
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

const invokedDirectly = /check-content\.mjs$/i.test(process.argv[1] ?? '')
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
