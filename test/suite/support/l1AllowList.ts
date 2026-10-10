/**
 * What the #351 differential is allowed to find, and exactly how much of it.
 *
 * Each disagreement entry names a routine (the last one dispatched to), the
 * cases it covers, why, and three measured numbers: the disagreeing cases it
 * absorbs, all compared cases its predicate matches (agreeing ones too), and a
 * digest of the interpreter's output over the absorbed cases, plus a fourth
 * digest of the PORT's written cells (last value per cell, $25 writes included,
 * #759) over the same cases. Without that one, a disagreement row would absorb
 * a change to what the port writes unseen (#751).
 * Widening a predicate, a new disagreement landing under an old entry, or a
 * change in what either side writes for the cases a row absorbs moves a number
 * and fails. This covers the disagreement rows and the refusal entries below,
 * and nothing else: an agreeing case outside them is compared, not pinned.
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
  /** [absorbed disagreements, compared cases the predicate matches, interpreter digest, port digest] */
  expect: [number, number, string, string]
  /**
   * Absorb only differences off the object's own screen; an on-screen one is
   * unexpected (#453). Valid only for objects whose footprint stays on screen 5
   * (rows 0-26, columns 80-95): a wider object placed at col 15 legitimately
   * draws onto screen 6, and a port bug there would be absorbed.
   */
  offScreenOnly?: boolean
  /**
   * Absorb only cases where the grids agree but the written-cell maps differ,
   * that is, the two sides disagree only on writes of the empty tile $25
   * (#759). Such a row never absorbs a case whose grids differ.
   */
  emptyTilesOnly?: boolean
}

const hi = (r: DiffRun) => r.size >> 4
const lo = (r: DiffRun) => r.size & 0x0f
const all = () => true
const row = (
  routine: number,
  when: Known['when'],
  why: Known['why'],
  expect: Known['expect'],
  offScreenOnly?: boolean,
  emptyTilesOnly?: boolean,
): Known => ({
  routine,
  when,
  why,
  expect,
  ...(offScreenOnly && { offScreenOnly }),
  ...(emptyTilesOnly && { emptyTilesOnly }),
})

/** In-range game behavior the ports do not follow (#369). */
const UMBRELLA = 690
const EMPTY = 'the ROM writes $25 into blank footprint cells; the port skips them (#759)'
const DRIFT =
  'no bookmark restore: once a row crosses a screen edge the next row starts a screen right'

// prettier-ignore
export const KNOWN_DISAGREEMENTS: Known[] = [
  // Port bugs, one issue each.
  // The port draws this only as the interpreter's refusal fallback; production draws it from the interpreter (#342).
  row(0x0dadeb, all, 440, [450, 480, 'cfbc58f35e', 'f058aa4925']),
  // #350 wraps the counter now; the 257 rows run past the 27-row screen, which is #300.
  row(0x0db49e, r => hi(r) === 0, 300, [240, 240, '25441b371f', '52d73446ad'], true),
  // #369: a zero nibble wraps a DEC/BNE counter to 256.
  ...([
    [0x0daa26, [195, 240, 'd73c1e0be0', '19148e7d53']],
    [0x0db224, [240, 240, '47589a6414', 'ccccf59395']],
    [0x0db51f, [240, 240, 'e9f5ff5b18', '2bbf5ceee4']],
    [0x0dc5d8, [48, 48, 'd99ec01f7d', '482f43160c']],
    [0x0dd1a5, [48, 48, 'e1b74da3b5', 'e8cbeb214b']],
    [0x0deec0, [48, 48, '7a53472354', '1b6d37e43a']],
  ] as [number, Known['expect']][]).map(([a, e]) => row(a, r => hi(r) === 0, UMBRELLA, e)),
  ...([
    [0x0db547, [240, 240, '9f2e79fbbc', '917784f3d9']],
    [0x0db5b7, [48, 48, '1c85ba93dd', 'cfe54bdb53']],
    [0x0dc478, [48, 48, 'e642b4f89d', 'a273fb72ed']],
    [0x0dd103, [48, 48, '76b1dbb72c', 'b472465be3']],
    [0x0dd145, [48, 48, 'f3c6b3abe9', 'cd5a772bfc']],
    [0x0dd182, [48, 48, '8274745b11', '9988805da1']],
    [0x0de135, [48, 48, '189837d5b7', 'ffa00b5616']],
    [0x0ded12, [48, 48, '81c88dfa91', '3932f82d46']],
    [0x0ded43, [48, 48, '221725d9dd', '9ad0248ff7']],
    [0x0dedb9, [48, 48, '76b1dbb72c', '9ad0248ff7']],
    [0x0def45, [48, 48, '0be4a28f6f', '5a7cd1b1b1']],
  ] as [number, Known['expect']][]).map(([a, e]) => row(a, r => lo(r) === 0, UMBRELLA, e)),
  row(0x0defa8, r => hi(r) === 0 || lo(r) === 0, UMBRELLA, [90, 90, '831d0cedfe', '7eee770d50']),
  // #369: the size indexes past a data table.
  row(0x0daab4, r => hi(r) >= 4, UMBRELLA, [2880, 2880, '3f57d102a1', '0cef828b0f']),
  row(0x0daab4, r => lo(r) === 0, UMBRELLA, [30, 240, '480bbabd66', '06bdcc5f7f']),
  row(0x0dcef2, r => hi(r) >= 2, UMBRELLA, [672, 672, '5765de9705', '75beea9b45']),
  row(0x0dd1d9, r => lo(r) >= 4, UMBRELLA, [576, 576, 'a0bcf50c14', '3b0e71558e']),
  row(0x0ddac8, r => lo(r) >= 2, UMBRELLA, [666, 672, '641b5fed57', '145127fce7']),
  // #369: too big to fit in 27 rows anywhere.
  ...([
    [0x0db7aa, [63, 64, '13fdb9f80c', '34d4b27801']],
    [0x0db863, [63, 63, '9fc190c1da', '9166e26036']],
    [0x0dc58a, [144, 144, '7420c3fd23', '9c51328c8c']],
    [0x0dd080, [9, 9, '3b0af2388b', 'c917dbd79c']],
    [0x0dd0c3, [9, 9, 'eea529b43c', '0c0c332503']],
    [0x0ddd99, [96, 96, 'dd096c8150', 'bbbc8e15e9']],
    [0x0dde3c, [96, 96, 'b22691c781', 'd3c86868d9']],
  ] as [number, Known['expect']][]).map(([a, e]) => row(a, r => !r.fits, UMBRELLA, e)),
  // Game quirks: the port draws the intent. bank_0D/MEMO.md has the traces.
  row(0x0dc4c9, r => r.col + lo(r) >= 15, `${DRIFT} (U only; E1 adds it, bank_0D.asm:5079-5090)`, [336, 336, 'c16790ce2b', '60cddfc005']),
  row(0x0dec33, r => r.col !== 0, `${DRIFT} (bank_0D.asm:7857-7872)`, [2, 2, '6556ac72bc', '6b947cd2c8']),
  ...([
    [0x0deabf, [1, 1, '9a044613d3', '726064714a']],
    [0x0deb6a, [1, 1, 'ee50ee8005', 'a02af6b4f3']],
    [0x0dc2e9, [1, 1, 'e6d56ac740', 'f483c9639c']],
    [0x0dc31e, [1, 1, '37d4c04964', '80d7218c1c']],
    [0x0da846, [2, 2, '954b2caa48', '2e541834ae']],
    [0x0dec8e, [4, 4, '665cdc19b7', 'e895f739fd']],
  ] as [number, Known['expect']][]).map(([a, e]) => row(a, r => r.col === 15, DRIFT, e)),
  row(0x0dbadc, all, 'rows wrap through LevelLoadPos, not _E, and blocks step $B0 (bank_0D.asm:4433-4470)', [558, 584, '8ab91c97a6', '8edf17dcaf']),
  // #759: grids agree, the written-cell maps do not. The ROM stores $25 across the blank cells of the object's rectangle; the port skips them.
  ...([
    [0x0da71b, [3, 3, 'e71f66dc6c', 'c777abd7ea']],
    [0x0da760, [3, 3, 'ace326f422', '018586d827']],
    [0x0dc2e9, [2, 3, '8ed789c7b2', 'edc48da7f4']],
  ] as [number, Known['expect']][]).map(([a, e]) => row(a, all, EMPTY, e, false, true)),
]

export interface KnownRefusal {
  reason: string
  top: number
  count: number
  /**
   * Aggregate digest of the port's written cells over these cases, run on a
   * clean grid only to be pinned (a refusal never reaches the port in
   * production). Pins the port for these cases, not the interpreter's refusal.
   */
  port: string
}

/** Keyed by the top-level handler: a sub-dispatch past its table has no routine of its own. */
// prettier-ignore
export const KNOWN_REFUSALS: KnownRefusal[] = [
  { reason: 'is not ROM', top: 0, count: 42, port: '38f9660605' }, // ext $02-$0F are null
  { reason: 'is not ROM', top: 0x0dcf53, count: 480, port: '1717f2e840' }, // index past the inline table
  { reason: 'is not ROM', top: 0x0dd070, count: 576, port: '730b0666ba' },
  { reason: 'not in the allowed set', top: 0x0dd070, count: 96, port: '654eab20b7' }, // runs on into the bytes after it
  { reason: 'unknown pointer byte at $65', top: 0x0da512, count: 3, port: '79c2f30954' }, // ext $00 reads the level stream
  { reason: 'write budget', top: 0x0defa8, count: 3, port: 'a6fe4419ff' }, // size 0: 256 x 256 cells
  { reason: 'write outside the tile buffer', top: 0x0da53d, count: 3, port: '79c2f30954' }, // ext $01 writes $1928
  { reason: 'write outside the tile buffer', top: 0x0db604, count: 48, port: 'e80ec0f3ad' }, // low nibble 0 wraps 256 wide
  { reason: 'write outside the tile buffer', top: 0x0ddf3a, count: 48, port: 'f6c1be05b3' }, // castle wall size 0 (bank_0D/MEMO.md)
  { reason: 'write into the direct page', top: 0x0dbadc, count: 184, port: 'dbc22c984f' }, // drift runs the pointer into WRAM
]

export interface Tally {
  disagreements: { routine: string; why: number | string; expect: Known['expect'] }[]
  refusals: KnownRefusal[]
  unexpected: string[]
  unexplainedRefusals: string[]
}

/** 10 hex digits over a list of per-case digests; empty when there are none. */
export const aggregate = (ds: string[]): string =>
  ds.length ? createHash('sha1').update(ds.join(',')).digest('hex').slice(0, 10) : ''

/** What the runs actually contain, in the allow-list's own shape. */
export function tally(
  runs: DiffRun[],
  name: (r: DiffRun) => string,
  known: Known[] = KNOWN_DISAGREEMENTS,
  knownRefusals: KnownRefusal[] = KNOWN_REFUSALS,
): Tally {
  const absorbed = known.map(() => [] as string[])
  const ported = known.map(() => [] as string[])
  const inside = known.map(() => 0)
  const refused = knownRefusals.map(() => 0)
  const refusedPort = knownRefusals.map(() => [] as string[])
  const unexpected: string[] = []
  const unexplainedRefusals: string[] = []
  for (const r of runs) {
    if (r.refusal !== null) {
      const i = knownRefusals.findIndex(k => k.top === r.top && r.refusal?.includes(k.reason))
      if (i >= 0) {
        refused[i]++
        refusedPort[i].push(r.portDigest ?? '')
      } else unexplainedRefusals.push(`${name(r)} (${hex6(r.top)}): ${r.refusal}`)
      continue
    }
    if (r.differs === null) continue
    known.forEach((k, i) => k.routine === r.leaf && k.when(r) && inside[i]++)
    if (!r.differs && r.writtenDiffers) {
      const e = known.findIndex(k => k.emptyTilesOnly && k.routine === r.leaf && k.when(r))
      if (e >= 0) {
        absorbed[e].push(r.digest)
        ported[e].push(r.portDigest ?? '')
      } else unexpected.push(`${name(r)} leaf ${hex6(r.leaf)}: empty-tile writes differ`)
      continue
    }
    if (!r.differs) continue
    const i = known.findIndex(k => !k.emptyTilesOnly && k.routine === r.leaf && k.when(r))
    if (i >= 0 && known[i].offScreenOnly && r.ownScreenDiffers)
      unexpected.push(`${name(r)} leaf ${hex6(r.leaf)}: own screen differs`)
    else if (i >= 0) {
      absorbed[i].push(r.digest)
      ported[i].push(r.portDigest ?? '')
    } else unexpected.push(`${name(r)} leaf ${hex6(r.leaf)}`)
  }
  const disagreements = known.map((k, i) => ({
    routine: hex6(k.routine),
    why: k.why,
    expect: [
      absorbed[i].length,
      inside[i],
      aggregate(absorbed[i]),
      aggregate(ported[i]),
    ] as Known['expect'],
  }))
  disagreements.forEach((d, i) => {
    if (d.expect[3] !== known[i].expect[3])
      unexpected.push(
        `${d.routine} (${typeof d.why === 'number' ? '#' : ''}${d.why}): port output differs from the pinned digest`,
      )
  })
  knownRefusals.forEach((k, i) => {
    const port = aggregate(refusedPort[i])
    if (port !== k.port)
      unexpected.push(
        `refusal ${hex6(k.top)} "${k.reason}": port output differs from the pinned digest`,
      )
  })
  return {
    disagreements,
    refusals: knownRefusals.map((k, i) => ({
      ...k,
      count: refused[i],
      port: aggregate(refusedPort[i]),
    })),
    unexpected,
    unexplainedRefusals,
  }
}
