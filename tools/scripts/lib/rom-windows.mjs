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

const key = (bytes, from, width) =>
  Buffer.from(
    bytes.subarray ? bytes.subarray(from, from + width) : bytes.slice(from, from + width),
  ).latin1Slice(0, width)

/** Every candidate window of the ROM, 512-byte copier header stripped. */
export function windowSet(rom, width = WINDOW_BYTES) {
  const body = rom.length % 1024 === 512 ? rom.subarray(512) : rom
  const set = new Set()
  for (let i = 0; i + width <= body.length; i++) {
    const w = body.subarray(i, i + width)
    if (isCandidate(w)) set.add(Buffer.from(w).latin1Slice(0, width))
  }
  return set
}

/** Runs of `{ at, windows }` where consecutive windows of `bytes` are in `set`. */
function hitRuns(bytes, lineOf, set, width) {
  const out = []
  let open = null
  for (let i = 0; i + width <= bytes.length; i++) {
    const w = bytes.slice(i, i + width)
    if (isCandidate(w) && set.has(key(w, 0, width))) {
      if (open) open.windows++
      else out.push((open = { at: lineOf(i), windows: 1 }))
    } else open = null
  }
  return out
}

/** Hits in assembled bytes: `at` is the offset of a run's first window. */
export const bytesHits = (bytes, set, width = WINDOW_BYTES) => hitRuns(bytes, i => i, set, width)

// 0x.. literals, bare hex bytes ("c9 de", "$c9"), decimal 0-255 comma lists.
const HEXTOK =
  /0x([0-9a-fA-F]{2})(?![0-9a-zA-Z_])|(?<![0-9A-Za-z_])\$?([0-9a-fA-F]{2})(?![0-9A-Za-z_.])/g
const DECLIST = /(?<![\w.])\d{1,3}(?:[ \t]*,[ \t\r\n]*\d{1,3})+(?![\w.])/g
const SEP = /^[\s,;[\]()|]*$/

/** Byte runs in `text` as `{ bytes, lines }`; a run is byte tokens separated
 *  only by whitespace, , ; [ ] ( ) | and comments. `base` numbers the first line. */
export function textRuns(text, base = 1) {
  const lineAt = pos => {
    let n = base
    for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) n++
    return n
  }
  const runs = []
  let cur = null
  let lastEnd = 0
  for (const m of text.matchAll(HEXTOK)) {
    const gap = text.slice(lastEnd, m.index).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*/g, ' ')
    if (!(cur && SEP.test(gap))) runs.push((cur = { bytes: [], lines: [] }))
    cur.bytes.push(parseInt(m[1] || m[2], 16))
    cur.lines.push(lineAt(m.index))
    lastEnd = m.index + m[0].length
  }
  for (const m of text.matchAll(DECLIST)) {
    cur = null
    for (const s of m[0].split(/\s*,\s*/)) {
      const v = parseInt(s, 10)
      if (v > 255) cur = null
      else {
        if (!cur) runs.push((cur = { bytes: [], lines: [] }))
        cur.bytes.push(v)
        cur.lines.push(lineAt(m.index))
      }
    }
  }
  return runs
}

/** Hits in text: `at` is the line of a run's first matching window. */
export const textHits = (text, set, base = 1, width = WINDOW_BYTES) =>
  textRuns(text, base).flatMap(r => hitRuns(r.bytes, i => r.lines[i], set, width))
