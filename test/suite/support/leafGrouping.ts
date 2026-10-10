/** Groups differential runs by leaf routine (#653 Stage A). Pure, so CI can test it without a ROM. */
import type { DiffRun } from './l1Differential'

export type LeafRow = Pick<DiffRun, 'kind' | 'leaf' | 'top' | 'refusal' | 'differs'>

export interface LeafStats {
  cases: number
  /** Refusal reason -> case count. */
  refused: Record<string, number>
  differs: number
  /** Cases that ran and matched the port. */
  agrees: number
  /** Cases the interpreter completed but the port was not run on (differs null). */
  notRun: number
}

/** The sweep gives a case refused before any ExecutePtrLong the leaf 0. */
export const NO_LEAF = 0

/** Bit 23 only: $80+ banks mirror $00+ on LoROM/FastROM up to 4 MB; SA-1 and ExLoROM break the mirror. */
export const leafKey = (leaf: number): number => leaf & 0x7fffff

/** Standard rows only: extended objects have no leaf in the dispatchStandard sense. */
export function groupLeaves(rows: readonly LeafRow[]): Map<number, LeafStats> {
  const out = new Map<number, LeafStats>()
  for (const r of rows) {
    if (r.kind !== 'standard') continue
    const key = leafKey(r.leaf)
    const s = out.get(key) ?? { cases: 0, refused: {}, differs: 0, agrees: 0, notRun: 0 }
    s.cases++
    if (r.refusal !== null) s.refused[r.refusal] = (s.refused[r.refusal] ?? 0) + 1
    else if (r.differs === true) s.differs++
    else if (r.differs === false) s.agrees++
    else s.notRun++
    out.set(key, s)
  }
  return out
}

/** A leaf agrees when every one of its cases ran and matched. */
export const agreeingStandardLeaves = (rows: readonly LeafRow[]): number[] =>
  [...groupLeaves(rows)]
    .filter(([, s]) => s.agrees === s.cases)
    .map(([leaf]) => leaf)
    .sort((a, b) => a - b)

const hex6 = (n: number) => n.toString(16).padStart(6, '0')
const reasons = (r: Record<string, number>) =>
  Object.entries(r)
    .map(([k, n]) => `${k}: ${n}`)
    .join('; ')

export function formatTable(g: Map<number, LeafStats>, leaves: readonly number[]): string {
  return leaves
    .map(l => {
      const s = g.get(l)
      if (!s) return `${hex6(l)}\tno cases`
      return `${hex6(l)}\t${s.cases}\trefused ${reasons(s.refused) || 0}\tdiffers ${s.differs}\tagrees ${s.agrees}\tnot run ${s.notRun}`
    })
    .join('\n')
}

/** Totals over every key, so refusals before any leaf dispatch and leaves outside `leaves` still show. */
export function formatHeader(g: Map<number, LeafStats>, leaves: readonly number[]): string {
  const keep = new Set(leaves)
  const refused: Record<string, number> = {}
  let cases = 0
  let outside = 0
  let outsideKeys = 0
  for (const [k, s] of g) {
    cases += s.cases
    for (const [why, n] of Object.entries(s.refused)) refused[why] = (refused[why] ?? 0) + n
    if (!keep.has(k) && k !== NO_LEAF) {
      outside += s.cases
      outsideKeys++
    }
  }
  const before = g.get(NO_LEAF)?.cases ?? 0
  return [
    `leaf keys are folded (bank bit 23 cleared)`,
    `standard cases ${cases}; refused by reason: ${reasons(refused) || 0}`,
    `refused before any leaf dispatch (key ${hex6(NO_LEAF)}): ${before}`,
    `cases on keys outside the vanilla set: ${outside} across ${outsideKeys} keys`,
  ].join('\n')
}
