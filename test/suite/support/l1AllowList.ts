/**
 * What the #351 differential is allowed to find, and exactly how much of it.
 *
 * Each disagreement entry names a routine (the last one dispatched to), the
 * cases it covers, why, and three measured numbers: the disagreeing cases it
 * absorbs, all compared cases its predicate matches (agreeing ones too), and a
 * digest of the interpreter's output over the absorbed cases. Widening a
 * predicate, a new disagreement landing under an old entry, or any change in
 * what the interpreter draws for those cases moves a number and fails.
 *
 * To regenerate after a deliberate change, run the corpus test and copy the
 * `actual` side of the failing diff.
 */
import { createHash } from 'node:crypto'
import { hex6, type DiffRun } from './l1Differential'

export interface Known {
  routine: number
  when: (r: DiffRun) => boolean
  /** An issue number, or the reason a game quirk is allowed without one. */
  why: number | string
  /** [absorbed disagreements, compared cases the predicate matches, digest] */
  expect: [number, number, string]
}

const hi = (r: DiffRun) => r.size >> 4
const lo = (r: DiffRun) => r.size & 0x0f
const all = () => true
const row = (routine: number, when: Known['when'], why: Known['why'], expect: Known['expect']): Known =>
  ({ routine, when, why, expect }) // prettier-ignore

/** In-range game behavior the ports do not follow (#369). */
const UMBRELLA = 690
const DRIFT =
  'no bookmark restore: once a row crosses a screen edge the next row starts a screen right'

// prettier-ignore
export const KNOWN_DISAGREEMENTS: Known[] = [
  // Port bugs, one issue each.
  // The port draws this only as the interpreter's refusal fallback; production draws it from the interpreter (#342).
  row(0x0dadeb, all, 440, [450, 480, 'cfbc58f35e']),
  row(0x0da68e, r => r.col === 0, 689, [1, 1, '1ac3aaa57d']),
  // #350 wraps the counter now; the 257 rows run past the 27-row screen, which is #300.
  row(0x0db49e, r => hi(r) === 0, 300, [240, 240, '25441b371f']),
  // #369: a zero nibble wraps a DEC/BNE counter to 256.
  ...([
    [0x0daa26, [195, 240, 'd73c1e0be0']],
    [0x0db224, [240, 240, '47589a6414']],
    [0x0db51f, [240, 240, 'e9f5ff5b18']],
    [0x0dc5d8, [48, 48, 'd99ec01f7d']],
    [0x0dd1a5, [48, 48, 'e1b74da3b5']],
    [0x0deec0, [48, 48, '7a53472354']],
  ] as [number, Known['expect']][]).map(([a, e]) => row(a, r => hi(r) === 0, UMBRELLA, e)),
  ...([
    [0x0db547, [240, 240, '9f2e79fbbc']],
    [0x0db5b7, [48, 48, '1c85ba93dd']],
    [0x0dc478, [48, 48, 'e642b4f89d']],
    [0x0dd103, [48, 48, '76b1dbb72c']],
    [0x0dd145, [48, 48, 'f3c6b3abe9']],
    [0x0dd182, [48, 48, '8274745b11']],
    [0x0de135, [48, 48, '189837d5b7']],
    [0x0ded12, [48, 48, '81c88dfa91']],
    [0x0ded43, [48, 48, '221725d9dd']],
    [0x0dedb9, [48, 48, '76b1dbb72c']],
    [0x0def45, [48, 48, '0be4a28f6f']],
  ] as [number, Known['expect']][]).map(([a, e]) => row(a, r => lo(r) === 0, UMBRELLA, e)),
  row(0x0defa8, r => hi(r) === 0 || lo(r) === 0, UMBRELLA, [90, 90, '831d0cedfe']),
  // #369: the size indexes past a data table.
  row(0x0daab4, r => hi(r) >= 4, UMBRELLA, [2880, 2880, '3f57d102a1']),
  row(0x0daab4, r => lo(r) === 0, UMBRELLA, [30, 240, '480bbabd66']),
  row(0x0dcef2, r => hi(r) >= 2, UMBRELLA, [672, 672, '5765de9705']),
  row(0x0dd1d9, r => lo(r) >= 4, UMBRELLA, [576, 576, 'a0bcf50c14']),
  row(0x0ddac8, r => lo(r) >= 2, UMBRELLA, [666, 672, '641b5fed57']),
  // #369: too big to fit in 27 rows anywhere.
  ...([
    [0x0db7aa, [63, 64, '13fdb9f80c']],
    [0x0db863, [63, 63, '9fc190c1da']],
    [0x0dc58a, [144, 144, '7420c3fd23']],
    [0x0dd080, [9, 9, '3b0af2388b']],
    [0x0dd0c3, [9, 9, 'eea529b43c']],
    [0x0ddd99, [96, 96, 'dd096c8150']],
    [0x0dde3c, [96, 96, 'b22691c781']],
  ] as [number, Known['expect']][]).map(([a, e]) => row(a, r => !r.fits, UMBRELLA, e)),
  // Game quirks: the port draws the intent. bank_0D/MEMO.md has the traces.
  row(0x0dc4c9, r => r.col + lo(r) >= 15, `${DRIFT} (U only; E1 adds it, bank_0D.asm:5079-5090)`, [336, 336, 'c16790ce2b']),
  row(0x0dec33, r => r.col !== 0, `${DRIFT} (bank_0D.asm:7857-7872)`, [2, 2, '6556ac72bc']),
  ...([
    [0x0deabf, [1, 1, '9a044613d3']],
    [0x0deb6a, [1, 1, 'ee50ee8005']],
    [0x0dc2e9, [1, 1, 'e6d56ac740']],
    [0x0dc31e, [1, 1, '37d4c04964']],
    [0x0da846, [2, 2, '954b2caa48']],
    [0x0dec8e, [4, 4, '665cdc19b7']],
  ] as [number, Known['expect']][]).map(([a, e]) => row(a, r => r.col === 15, DRIFT, e)),
  row(0x0dbadc, all, 'rows wrap through LevelLoadPos, not _E, and blocks step $B0 (bank_0D.asm:4433-4470)', [558, 584, '8ab91c97a6']),
]

export interface KnownRefusal {
  reason: string
  top: number
  count: number
}

/** Keyed by the top-level handler: a sub-dispatch past its table has no routine of its own. */
// prettier-ignore
export const KNOWN_REFUSALS: KnownRefusal[] = [
  { reason: 'is not ROM', top: 0, count: 42 }, // ext $02-$0F are null
  { reason: 'is not ROM', top: 0x0dcf53, count: 480 }, // index past the inline table
  { reason: 'is not ROM', top: 0x0dd070, count: 576 },
  { reason: 'not in the allowed set', top: 0x0dd070, count: 96 }, // runs on into the bytes after it
  { reason: 'unknown pointer byte at $65', top: 0x0da512, count: 3 }, // ext $00 reads the level stream
  { reason: 'write budget', top: 0x0defa8, count: 3 }, // size 0: 256 x 256 cells
  { reason: 'write outside the tile buffer', top: 0x0da53d, count: 3 }, // ext $01 writes $1928
  { reason: 'write outside the tile buffer', top: 0x0db604, count: 48 }, // low nibble 0 wraps 256 wide
  { reason: 'write outside the tile buffer', top: 0x0ddf3a, count: 48 }, // castle wall size 0 (bank_0D/MEMO.md)
  { reason: 'write into the direct page', top: 0x0dbadc, count: 184 }, // drift runs the pointer into WRAM
]

export interface Tally {
  disagreements: { routine: string; why: number | string; expect: [number, number, string] }[]
  refusals: KnownRefusal[]
  unexpected: string[]
  unexplainedRefusals: string[]
}

/** What the runs actually contain, in the allow-list's own shape. */
export function tally(runs: DiffRun[], name: (r: DiffRun) => string): Tally {
  const absorbed = KNOWN_DISAGREEMENTS.map(() => [] as string[])
  const inside = KNOWN_DISAGREEMENTS.map(() => 0)
  const refused = KNOWN_REFUSALS.map(() => 0)
  const unexpected: string[] = []
  const unexplainedRefusals: string[] = []
  for (const r of runs) {
    if (r.refusal !== null) {
      const i = KNOWN_REFUSALS.findIndex(k => k.top === r.top && r.refusal?.includes(k.reason))
      if (i >= 0) refused[i]++
      else unexplainedRefusals.push(`${name(r)} (${hex6(r.top)}): ${r.refusal}`)
      continue
    }
    if (r.differs === null) continue
    KNOWN_DISAGREEMENTS.forEach((k, i) => k.routine === r.leaf && k.when(r) && inside[i]++)
    if (!r.differs) continue
    const i = KNOWN_DISAGREEMENTS.findIndex(k => k.routine === r.leaf && k.when(r))
    if (i >= 0) absorbed[i].push(r.digest)
    else unexpected.push(`${name(r)} leaf ${hex6(r.leaf)}`)
  }
  const digest = (ds: string[]) =>
    ds.length ? createHash('sha1').update(ds.join(',')).digest('hex').slice(0, 10) : ''
  return {
    disagreements: KNOWN_DISAGREEMENTS.map((k, i) => ({
      routine: hex6(k.routine),
      why: k.why,
      expect: [absorbed[i].length, inside[i], digest(absorbed[i])],
    })),
    refusals: KNOWN_REFUSALS.map((k, i) => ({ ...k, count: refused[i] })),
    unexpected,
    unexplainedRefusals,
  }
}
