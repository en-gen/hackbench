/** Groups differential runs by leaf routine (#653 Stage A). Pure, so CI can test it without a ROM. */
import type { DiffRun } from './l1Differential'

type Row = Pick<DiffRun, 'kind' | 'leaf' | 'top' | 'refusal' | 'differs'>

export interface LeafStats {
  cases: number
  /** Refusal reason -> case count. */
  refused: Record<string, number>
  differs: number
  /** Cases that ran and matched the port. */
  agrees: number
}

/** Banks $80+ mirror $00+ on LoROM: Invictus and Seven Vanilla Levels write $8D where vanilla writes $0D. */
export const leafKey = (leaf: number): number => leaf & 0x7fffff

/** Standard rows only: extended objects have no leaf in the dispatchStandard sense. */
export function groupLeaves(rows: readonly Row[]): Map<number, LeafStats> {
  const out = new Map<number, LeafStats>()
  for (const r of rows) {
    if (r.kind !== 'standard') continue
    const key = leafKey(r.leaf)
    const s = out.get(key) ?? { cases: 0, refused: {}, differs: 0, agrees: 0 }
    s.cases++
    if (r.refusal !== null) s.refused[r.refusal] = (s.refused[r.refusal] ?? 0) + 1
    else if (r.differs) s.differs++
    else s.agrees++
    out.set(key, s)
  }
  return out
}

/** A leaf agrees when every one of its cases ran and matched. */
export const agreeingStandardLeaves = (rows: readonly Row[]): number[] =>
  [...groupLeaves(rows)]
    .filter(([, s]) => s.agrees === s.cases)
    .map(([leaf]) => leaf)
    .sort((a, b) => a - b)

export function formatTable(g: Map<number, LeafStats>, leaves: readonly number[]): string {
  return leaves
    .map(l => {
      const s = g.get(l)
      if (!s) return `${l}\tno cases`
      const refused = Object.entries(s.refused)
        .map(([k, n]) => `${k}: ${n}`)
        .join('; ')
      return `${l}\t${s.cases}\trefused ${refused || 0}\tdiffers ${s.differs}\tagrees ${s.agrees}`
    })
    .join('\n')
}
