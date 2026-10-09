/**
 * Verdicts and the summary for tools/scripts/hack-sweep.ts, kept apart from the
 * runner so they are testable without a ROM.
 */
import { createHash } from 'crypto'

/** `reasons` lists every failing gate the reader exposes, not only the first. */
export type ReaderOutcome =
  | { verdict: 'ok'; summary: string }
  | { verdict: 'unavailable'; reasons: string[]; summary?: string }
export type ReaderRecord = ReaderOutcome | { verdict: 'crash'; error: string; frame: string }

export type InteropRecord =
  | { verdict: 'match' | 'mismatch'; resultSha256: string }
  | { verdict: 'refused' | 'index-hash-invalid' | 'unchecked'; reason: string }

export interface HackRecord {
  smwcId: number
  name: string
  romSha256: string | null
  romSize: number | null
  readers: Record<string, ReaderRecord>
  interop: InteropRecord
  /** Set on a record kept from an earlier run; absent on one swept in this run. */
  carried?: true
}

/** Output never carries ROM bytes: a run longer than an opcode and its operand is elided. */
export function stripByteRuns(text: string): string {
  return text.replace(
    /(?<![\w?])(?:(?:[0-9a-fA-F]{2}|\?\?) ){4,}(?:[0-9a-fA-F]{2}|\?\?)(?![\w?])/g,
    '<bytes>',
  )
}

/** A reader that returns is judged by what it returned; one that throws is a crash, never a refusal. */
export function runReader(read: () => ReaderOutcome): ReaderRecord {
  try {
    const r = read()
    return r.verdict === 'ok' ? r : { ...r, reasons: r.reasons.map(stripByteRuns) }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    const frame = (e.stack ?? '').split('\n').find(l => l.trim().startsWith('at ')) ?? ''
    return {
      verdict: 'crash',
      error: stripByteRuns(`${e.name}: ${e.message}`),
      frame: frame.trim(),
    }
  }
}

/** The shapes decodeGfxSheet throws on purpose, which the view shows as its message. */
const GFX_REFUSAL =
  /^(GFX file \$[0-9A-F]{2}[ :]|No readable GFX data at file \$|Palette column 1 is unavailable: |Unsupported GFX format: )/

/** The refusal a graphics decode throw stands for, or null when it is a bug. */
export function gfxRefusal(err: unknown): string | null {
  if (!(err instanceof Error) || err.constructor !== Error) return null
  return GFX_REFUSAL.test(err.message) ? err.message : null
}

/** Every refusal across the listed files; a decode throw that is not a refusal propagates as a crash. */
export function gfxRefusals(
  files: readonly { index: number; unavailable?: string }[],
  decode: (index: number) => unknown,
): string[] {
  const refusals: string[] = []
  for (const f of files) {
    if (f.unavailable) {
      refusals.push(f.unavailable)
      continue
    }
    try {
      decode(f.index)
    } catch (err) {
      const reason = gfxRefusal(err)
      if (reason === null) throw err
      refusals.push(reason)
    }
  }
  return refusals
}

/** 64 lowercase hex characters, or null: tolerates the leading backslash and case a sha256sum line can carry. */
export function normalizeSha256(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const hex = raw.trim().replace(/^\\/, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

export type Applied = { ok: true; bytes: Uint8Array } | { ok: false; reason: string }

/** Our applier's output against the index's hash, which another patcher produced. */
export function decideInterop(indexSha256: unknown, applied: Applied): InteropRecord {
  const expected = normalizeSha256(indexSha256)
  if (!expected) return { verdict: 'index-hash-invalid', reason: String(indexSha256) }
  if (!applied.ok) return { verdict: 'refused', reason: stripByteRuns(applied.reason) }
  const resultSha256 = createHash('sha256').update(applied.bytes).digest('hex')
  return { verdict: resultSha256 === expected ? 'match' : 'mismatch', resultSha256 }
}

/** Bucket key: the gate, not what a hack put there; a FastROM bank ($80-$FF) folds onto its mirror. */
export function blockerKey(reason: string): string {
  return reason
    .replace(/(GFX file|at file) \$[0-9A-F]{2}\b/g, '$1 $nn')
    .replace(/\) holds .*, not the stock .*$/, ') is not stock.')
    .replace(
      /\$([89A-F][0-9A-F])([0-9A-F]{4})\b/g,
      (_, bank: string, rest: string) =>
        `$${(parseInt(bank, 16) & 0x7f).toString(16).toUpperCase().padStart(2, '0')}${rest}`,
    )
}

/** What each view's `ok` does and does not establish. */
const OK_MEANS: Record<string, string> = {
  maps: 'the map tree built; roots and unassigned are listed per hack below',
  overworld: 'the entrance derivation read the overworld',
  mapDetails: 'every map the catalog calls real opened without a throw',
  graphics: 'every GFX file listed and decoded to a sheet',
  map16: 'tileset 0 decoded for both layers',
  palettes:
    'the ROM loaded and the stock tables were read at their fixed addresses; that is not a check that the hack still uses them',
  music: 'all three music banks were located and listed',
  sfx: 'both SFX tables were located and listed',
}

const pct = (n: number, of: number): string => (of === 0 ? '-' : `${((100 * n) / of).toFixed(1)}%`)

/** One ranking for summary.md and the run diff, so a gate cannot rank differently in each. */
export function rankBlockers(
  records: HackRecord[],
  view: string,
): [string, { sole: number; total: number }][] {
  const tally = new Map<string, { sole: number; total: number }>()
  for (const r of records) {
    const x = r.readers[view]
    if (x?.verdict !== 'unavailable') continue
    const keys = [...new Set(x.reasons.map(blockerKey))]
    for (const k of keys) {
      const t = tally.get(k) ?? { sole: 0, total: 0 }
      t.total++
      if (keys.length === 1) t.sole++
      tally.set(k, t)
    }
  }
  return [...tally].sort((a, b) => b[1].sole - a[1].sole || b[1].total - a[1].total)
}

const viewsOf = (records: HackRecord[]): string[] => [
  ...new Set(records.flatMap(r => Object.keys(r.readers))),
]

/** Works-on % per view, with the same `ok / reporting hacks` rule summarize prints. */
function worksOn(records: HackRecord[], view: string): string {
  const got = records.map(r => r.readers[view]).filter((x): x is ReaderRecord => !!x)
  return pct(got.filter(x => x.verdict === 'ok').length, got.length)
}

export interface RunDiff {
  compared: number
  carried: number
  added: string[]
  notCovered: string[]
  newCrashes: string[]
  clearedCrashes: string[]
  verdictChanges: string[]
  worksOn: { view: string; before: string; after: string }[]
  blockerMoves: string[]
}

const label = (r: HackRecord): string => `${r.smwcId} ${r.name}`

/** The new results: this run's records, plus the previous run's for hacks outside the batch, marked carried. */
export function mergeCarried(prev: HackRecord[], swept: HackRecord[]): HackRecord[] {
  const ids = new Set(swept.map(r => r.smwcId))
  const kept = prev.filter(r => !ids.has(r.smwcId)).map(r => ({ ...r, carried: true as const }))
  return [...swept.map(({ carried: _, ...r }) => r), ...kept].sort((a, b) => a.smwcId - b.smwcId)
}

/** Only hacks swept this run and present before are diffed; a carried record did not run, so it cannot have changed. */
export function diffRuns(prev: HackRecord[], cur: HackRecord[], topBlockers = 8): RunDiff {
  const before = new Map(prev.map(r => [r.smwcId, r]))
  const after = new Map(cur.map(r => [r.smwcId, r]))
  const swept = cur.filter(r => !r.carried)
  const pairs = swept.flatMap(c =>
    before.has(c.smwcId) ? [[before.get(c.smwcId)!, c] as const] : [],
  )
  const d: RunDiff = {
    compared: pairs.length,
    carried: cur.length - swept.length,
    added: swept.filter(r => !before.has(r.smwcId)).map(label),
    notCovered: prev.filter(r => !after.has(r.smwcId)).map(label),
    newCrashes: [],
    clearedCrashes: [],
    verdictChanges: [],
    worksOn: [],
    blockerMoves: [],
  }
  for (const [p, c] of pairs) {
    for (const v of new Set([...Object.keys(p.readers), ...Object.keys(c.readers)])) {
      const from = p.readers[v]?.verdict
      const to = c.readers[v]?.verdict
      if (!from || !to || from === to) continue
      d.verdictChanges.push(`${label(c)} / ${v}: ${from} -> ${to}`)
      if (to === 'crash') d.newCrashes.push(`${label(c)} / ${v}`)
      if (from === 'crash') d.clearedCrashes.push(`${label(c)} / ${v}`)
    }
  }
  // A crash that stays a crash is in neither list, so one that changes its error still reads as unchanged.
  const pp = pairs.map(([p]) => p)
  const cc = pairs.map(([, c]) => c)
  for (const view of [...new Set([...viewsOf(pp), ...viewsOf(cc)])]) {
    const b = worksOn(pp, view)
    const a = worksOn(cc, view)
    if (a !== b) d.worksOn.push({ view, before: b, after: a })
    const rank = (rs: HackRecord[]): Map<string, number> =>
      new Map(
        rankBlockers(rs, view)
          .slice(0, topBlockers)
          .map(([k], i) => [k, i + 1]),
      )
    const rb = rank(pp)
    const ra = rank(cc)
    for (const gate of new Set([...rb.keys(), ...ra.keys()])) {
      const f = rb.get(gate)
      const t = ra.get(gate)
      if (f !== t)
        d.blockerMoves.push(
          `${view}: ${gate}: ${f ? `#${f}` : 'unranked'} -> ${t ? `#${t}` : 'unranked'}`,
        )
    }
  }
  return d
}

/** A stable order, so the cursor means the same hack next run; wraps, and tolerates any cursor. */
export function pickBatch<T extends { smwc_id: number }>(
  index: readonly T[],
  cursor: number,
  n: number,
): { batch: T[]; next: number } {
  const sorted = [...index].sort((a, b) => a.smwc_id - b.smwc_id)
  if (sorted.length === 0 || !(n > 0)) return { batch: [], next: 0 }
  const start = ((Math.trunc(cursor) % sorted.length) + sorted.length) % sorted.length
  const count = Math.min(Math.trunc(n), sorted.length)
  const batch = Array.from({ length: count }, (_, i) => sorted[(start + i) % sorted.length]!)
  return { batch, next: (start + count) % sorted.length }
}

/** Ids, names, verdicts and the summary only: nothing here is read from a ROM. */
export function trackingIssueBody(diff: RunDiff | null, summary: string): string {
  const list = (items: string[]): string[] => (items.length ? items.map(i => `- ${i}`) : ['None.'])
  const out = ['# Hack sweep run', '']
  if (!diff) {
    out.push('First run: no earlier results to compare against.')
  } else {
    out.push(
      `${diff.compared} hacks compared with the previous run; ${diff.carried} carried from earlier runs, not re-swept.`,
      '',
    )
    const sections: [string, string[]][] = [
      ['New crashes', diff.newCrashes],
      ['Cleared crashes', diff.clearedCrashes],
      ['Verdict changes', diff.verdictChanges],
      ['Works on', diff.worksOn.map(w => `${w.view}: ${w.before} -> ${w.after}`)],
      ['Blocker ranking moves', diff.blockerMoves],
      ['Added (not in the previous run)', diff.added],
      ['Not covered this run', diff.notCovered],
    ]
    for (const [title, items] of sections) out.push(`## ${title}`, '', ...list(items), '')
  }
  out.push('<details><summary>Full summary</summary>', '', summary.trimEnd(), '', '</details>', '')
  return out.join('\n')
}

export function summarize(records: HackRecord[], topBlockers = 8): string {
  const views = viewsOf(records)
  const carried = records.filter(r => r.carried).length
  const out = [
    `# Hack sweep`,
    '',
    `${records.length} hacks.${carried ? ` ${records.length - carried} swept this run, ${carried} carried from earlier runs.` : ''}`,
    '',
    '## Per view',
    '',
  ]
  out.push('| View | ok | unavailable | crash | works on |', '|---|---|---|---|---|')
  for (const v of views) {
    const got = records.map(r => r.readers[v]).filter((x): x is ReaderRecord => !!x)
    const n = (verdict: string): number => got.filter(x => x.verdict === verdict).length
    out.push(
      `| ${v} | ${n('ok')} | ${n('unavailable')} | ${n('crash')} | ${pct(n('ok'), got.length)} |`,
    )
  }
  out.push(
    '',
    '`ok` means:',
    '',
    ...views.map(v => `- ${v}: ${OK_MEANS[v] ?? 'the reader returned'}`),
  )

  out.push(
    '',
    '## Blockers',
    '',
    'Every failing gate, ranked by the hacks it alone blocks, then by all it blocks.',
    '',
  )
  for (const v of views) {
    const ranked = rankBlockers(records, v)
    if (ranked.length === 0) continue
    out.push(`### ${v}`, '', '| only blocker | blocks | gate |', '|---|---|---|')
    for (const [k, t] of ranked.slice(0, topBlockers)) out.push(`| ${t.sole} | ${t.total} | ${k} |`)
    out.push('')
  }

  const flat = records.filter(r => {
    const m = r.readers.maps
    return m?.verdict === 'ok' && /\b0 roots\b/.test(m.summary)
  }).length
  out.push('## Map tree per hack', '', `${flat} hacks load with 0 roots: every map is flat.`, '')
  for (const r of records) {
    const m = r.readers.maps
    if (m) out.push(`- ${r.smwcId} ${r.name}: ${m.verdict === 'ok' ? m.summary : m.verdict}`)
  }

  out.push('', '## Crashes', '')
  const crashes = records.flatMap(r =>
    Object.entries(r.readers).flatMap(([v, x]) =>
      x.verdict === 'crash' ? [`- ${r.smwcId} ${r.name} / ${v}: ${x.error} (${x.frame})`] : [],
    ),
  )
  out.push(...(crashes.length ? crashes : ['None.']), '', '## Store issues', '')
  const headered = records.filter(r => r.romSize !== null && r.romSize % 0x8000 === 512)
  out.push(
    ...(headered.length
      ? headered.map(
          r =>
            `- ${r.smwcId} ${r.name}: ${r.romSize} bytes, a copier header's 512 over a bank multiple. ` +
            'Likely a patch made for a headered ROM applied to headerless vanilla, so its refusals are a store issue.',
        )
      : ['None.']),
  )

  out.push('', '## Patch interop', '')
  const interop = new Map<string, number>()
  for (const r of records) interop.set(r.interop.verdict, (interop.get(r.interop.verdict) ?? 0) + 1)
  for (const [verdict, count] of [...interop].sort()) out.push(`- ${verdict}: ${count}`)
  for (const r of records) {
    if (r.interop.verdict !== 'match') {
      const detail = 'reason' in r.interop ? r.interop.reason : r.interop.resultSha256
      out.push(`- ${r.interop.verdict}: ${r.smwcId} ${r.name}: ${detail}`)
    }
  }
  return out.join('\n') + '\n'
}
