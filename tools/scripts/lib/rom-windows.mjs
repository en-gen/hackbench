// ROM-window probe core (report-only, see docs/testing.md "ROM-window probe").
// Does any `width` consecutive bytes of a text, fixture or assembled blob also
// occur in the vanilla ROM? Holds no ROM bytes: the ROM is read at run time.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// The ROM lookup is corpus.cjs's own resolver, not a port, so the two cannot drift.
const corpus = createRequire(import.meta.url)('../../../test/suite/support/corpus.cjs')

export const WINDOW_BYTES = 8
const MIN_DISTINCT = 3

/** Where the vanilla ROM would be; the file may not exist. */
export function locateVanillaRom(env, repoRoot, exists = existsSync) {
  return join(corpus.resolveRomDir(env, repoRoot, exists), corpus.VANILLA)
}

/** A window worth looking up: all-00 or all-FF runs and the like match any
 *  ROM, so fewer than MIN_DISTINCT distinct values are ignored. The one filter. */
export const isCandidate = w => new Set(w).size >= MIN_DISTINCT

// Map key for a window: its bytes as a latin1 string.
const key = w => Buffer.from(w).toString('latin1')

/** Every candidate window of the ROM, 512-byte copier header stripped. */
export function windowSet(rom, width = WINDOW_BYTES) {
  const body = rom.length % 1024 === 512 ? rom.subarray(512) : rom
  const set = new Set()
  for (let i = 0; i + width <= body.length; i++) {
    const w = body.subarray(i, i + width)
    if (isCandidate(w)) set.add(key(w))
  }
  return set
}

/** Runs of `{ at, windows, end }` where consecutive windows of `bytes` are in
 *  `set`; `at` and `end` are lineOf() of the run's first and last byte. */
function hitRuns(bytes, lineOf, set, width) {
  const out = []
  let open = null
  for (let i = 0; i + width <= bytes.length; i++) {
    const w = bytes.slice(i, i + width)
    if (isCandidate(w) && set.has(key(w))) {
      if (!open) out.push((open = { at: lineOf(i), windows: 0 }))
      open.windows++
      open.end = lineOf(i + width - 1)
    } else open = null
  }
  return out
}

/** Hits in assembled bytes: `at` is the offset of a run's first window. */
export const bytesHits = (bytes, set, width = WINDOW_BYTES) => hitRuns(bytes, i => i, set, width)

// One token class: 0x.. or $.. with 1-2 hex digits, bare 2-digit hex, decimal 0-999
// (over 255 ends the run). A digits-only 2-char token next to a comma is decimal.
const TOKEN =
  /(?<![\w.$])(?:0[xX]([0-9a-fA-F]{1,2})|\$([0-9a-fA-F]{1,2})|([0-9a-fA-F]{2})|(\d{1,3}))(?![\w.])/g
const SEP = /^[\s,;[\]()|]*$/

// Comments are read only where the language has them: // and block comments in JS/TS, a
// semicolon in asm, nothing elsewhere (markdown, Lua, ...).
export const commentMode = path =>
  /\.(asm|inc|s)$/i.test(path) ? 'asm' : /\.(m?[jt]sx?|cjs|cts)$/i.test(path) ? 'js' : 'none'

const blank = m => m.replace(/[^\n]/g, ' ')
// Comments become spaces (newlines kept) so positions and line numbers hold. Quoted strings are
// skipped whole, so a quoted a//b or src/* blanks nothing. Single and double quotes end at a
// newline (prose apostrophes); a template literal may span lines.
export function stripComments(t, mode = 'js') {
  if (mode === 'none') return t
  const special = mode === 'js' ? /[/'"`]/g : /[;'"`]/g
  let out = ''
  let i = 0
  while (i < t.length) {
    special.lastIndex = i
    const m = special.exec(t)
    if (!m) break
    const c = m[0]
    out += t.slice(i, m.index)
    i = m.index
    let end = i + 1
    if (c === '"' || c === "'" || c === '`') {
      while (end < t.length && t[end] !== c && (c === '`' || t[end] !== '\n'))
        end += t[end] === '\\' ? 2 : 1
      end = Math.min(t[end] === c ? end + 1 : end, t.length)
      out += t.slice(i, end)
    } else if (mode === 'js' && t[i + 1] === '*') {
      const close = t.indexOf('*/', i + 2)
      end = close < 0 ? t.length : close + 2
      out += blank(t.slice(i, end))
    } else if (mode === 'asm' || t[i + 1] === '/') {
      const nl = t.indexOf('\n', i)
      end = nl < 0 ? t.length : nl
      out += blank(t.slice(i, end))
    } else out += c
    i = end
  }
  return out + t.slice(i)
}

/** Byte runs in `text` as `{ bytes, lines }`; a run is byte tokens separated
 *  only by whitespace, , ; [ ] ( ) | and comments. `base` numbers the first line. */
export function textRuns(text, base = 1, mode = 'js') {
  let src = stripComments(text, mode)
  // An asm data directive joins the lines of a table; as a word it would read as the byte 0xDB.
  if (mode === 'asm')
    src = src.replace(/(?<![\w$])\.?(?:db|byte)(?![\w$])/gi, d => ' '.repeat(d.length))
  // Tokens arrive in ascending index order, so the line counter only moves forward.
  let line = base
  let nl = src.indexOf('\n')
  const lineAt = pos => {
    while (nl >= 0 && nl < pos) {
      line++
      nl = src.indexOf('\n', nl + 1)
    }
    return line
  }
  const toks = [...src.matchAll(TOKEN)]
  const runs = []
  let cur = null
  toks.forEach((m, i) => {
    const gap = src.slice(i ? toks[i - 1].index + toks[i - 1][0].length : 0, m.index)
    const nextGap = toks[i + 1] ? src.slice(m.index + m[0].length, toks[i + 1].index) : ''
    if (!(cur && SEP.test(gap))) cur = null
    // Only a comma between two tokens of the same run says "decimal"; one outside the run does not.
    const comma =
      (cur !== null && gap.includes(',')) || (SEP.test(nextGap) && nextGap.includes(','))
    const v =
      m[1] !== undefined
        ? parseInt(m[1], 16)
        : m[2] !== undefined
          ? parseInt(m[2], 16)
          : m[3] !== undefined && !(/^\d\d$/.test(m[3]) && comma)
            ? parseInt(m[3], 16)
            : parseInt(m[3] ?? m[4], 10)
    if (v > 255) cur = null
    else {
      if (!cur) runs.push((cur = { bytes: [], lines: [] }))
      cur.bytes.push(v)
      cur.lines.push(lineAt(m.index))
    }
  })
  return runs
}

/** Hits in text: `at` is the line of a run's first matching window. */
export const textHits = (text, set, base = 1, width = WINDOW_BYTES, mode = 'js') =>
  textRuns(text, base, mode).flatMap(r => hitRuns(r.bytes, i => r.lines[i], set, width))
