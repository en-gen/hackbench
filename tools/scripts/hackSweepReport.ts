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

export function summarize(records: HackRecord[], topBlockers = 8): string {
  const views = [...new Set(records.flatMap(r => Object.keys(r.readers)))]
  const out = [`# Hack sweep`, '', `${records.length} hacks.`, '', '## Per view', '']
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
    const tally = new Map<string, { sole: number; total: number }>()
    for (const r of records) {
      const x = r.readers[v]
      if (x?.verdict !== 'unavailable') continue
      const keys = [...new Set(x.reasons.map(blockerKey))]
      for (const k of keys) {
        const t = tally.get(k) ?? { sole: 0, total: 0 }
        t.total++
        if (keys.length === 1) t.sole++
        tally.set(k, t)
      }
    }
    if (tally.size === 0) continue
    out.push(`### ${v}`, '', '| only blocker | blocks | gate |', '|---|---|---|')
    const ranked = [...tally].sort((a, b) => b[1].sole - a[1].sole || b[1].total - a[1].total)
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
