/**
 * Corpus-backed suite for the L1 (foreground) data gate (en-gen/hackbench
 * #421 phase 1): runs `runGate` against the real vanilla ROM and the real
 * `layers_v5` Mesen captures, over the committed 143-map roster.
 *
 * Gated with `describe.skipIf`, never generated from a directory listing
 * (test/suite/gates/testRegistrationGate.test.ts bans that): the case list
 * is `FG_GATE_MAPS`, a committed constant, so every case exists whether or
 * not the corpus is present, and only its ASSERTIONS are skipped without it.
 *
 * Defs and chars are clean against real data. Grid is not: three filed
 * HackBench defects (not this gate's to fix - #567, #569, #570) produce a
 * known set of mismatches, checked below by map, table, COUNT and a
 * SHA-256 of the sorted mismatch set - `fixtures/fgKnownFailures.json`.
 * The fixture holds no literal cells: a per-map dump would reconstruct
 * level layout (docs/testing.md forbids a ROM-derived fixture), and a
 * count+hash pair is still exact - a mismatch moving to a different id or
 * a different map changes the hash, so it goes red here the same as a fix
 * that removes one.
 *
 * Pipes are clean: #571 (the vanilla pipe-color bug, bank_05.asm:103,
 * 110-143, 899-929, 931-945) is no longer a known failure, because
 * `checkPipes` now allows exactly that bug, tightly (ALLOWED_PIPE_BUG_H_S0,
 * ALLOWED_PIPE_BUG_V_S0_DEFAULT, ALLOWED_PIPE_BUG_VERTICAL) instead of
 * skipping it, so 0 pipe mismatches is the expected result on every map.
 */
import { beforeAll, describe, it, expect } from 'vitest'
import { hasCaptures, hasRom, romPath, CAPTURE_DIR, VANILLA } from '../support/corpus'
import { FG_GATE_MAPS, idToHex } from '../../../tools/scripts/fgGateMaps'
import {
  runGate,
  hashMismatches,
  ALLOWED_PIPE_BUG_H_S0,
  ALLOWED_PIPE_BUG_V_S0_DEFAULT,
  ALLOWED_PIPE_BUG_VERTICAL,
  type GateMismatch,
  type GateResult,
} from '../../../tools/scripts/capture_gate'
import knownFailures from './fixtures/fgKnownFailures.json'

const corpusReady = hasRom(VANILLA) && hasCaptures()
if (hasRom(VANILLA) && !hasCaptures()) {
  console.warn(`\n[CaptureGate.corpus.test.ts] ROM present but no captures: set HACKBENCH_CAPTURES to the layers_v5 folder (see docs/testing.md) to run the Foreground data gate suite.\n`) // prettier-ignore
}

interface KnownEntry {
  map: string
  table: string
  issue: number
  count: number
  sha256: string
}
interface KnownExample {
  issue: number
  map: string
  table: string
  cell: string
  expected: string
  actual: string
}
const KNOWN = knownFailures as { entries: KnownEntry[]; examples: KnownExample[] }
const KNOWN_MAP_IDS = new Set(KNOWN.entries.map(e => e.map))

// A corpus run reads 143 captures and a ~500KB ROM; generous but bounded.
const TIMEOUT = 60_000

function byTable(mismatches: readonly GateMismatch[]): Map<string, GateMismatch[]> {
  const m = new Map<string, GateMismatch[]>()
  for (const x of mismatches) (m.get(x.table) ?? m.set(x.table, []).get(x.table)!).push(x)
  return m
}

describe.skipIf(!corpusReady)('L1 data gate: $105 alone (owner sign-off map)', () => {
  let result: GateResult
  beforeAll(() => {
    ;[result] = runGate(romPath(VANILLA), CAPTURE_DIR, [0x105], undefined, Infinity)
  }, TIMEOUT)

  it('is read; its only mismatches are the known #567 grid cells', () => {
    const known = KNOWN.entries.find(e => e.map === '$105' && e.table === 'grid')!
    expect(result.unavailable).toBeUndefined()
    expect(result.totals).toEqual({ grid: known.count, defs: 0, pipes: 0, chars: 0, palette: 0 })
    expect(hashMismatches(result.mismatches)).toBe(known.sha256)
  })
})

describe.skipIf(!corpusReady)('L1 data gate: the 143-map roster', () => {
  let results: GateResult[]
  beforeAll(() => {
    results = runGate(romPath(VANILLA), CAPTURE_DIR, FG_GATE_MAPS, undefined, Infinity)
  }, TIMEOUT)

  it(
    'reads every listed map (a missing capture is a failure, not a skip)',
    () => {
      const missing = results.filter(r => r.unavailable)
      expect(missing.map(r => `${idToHex(r.id)}: ${r.unavailable}`)).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'Table 2 (Map16 definitions) matches word for word, bit 13 included',
    () => {
      expect(results.reduce((n, r) => n + r.totals.defs, 0)).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'Table 4 (L1 chars) matches by pixel index, animated chars included',
    () => {
      expect(results.reduce((n, r) => n + r.totals.chars, 0)).toBe(0)
    },
    TIMEOUT,
  )

  it(
    // N43: real vanilla levels animate CGRAM $64 every frame (project memory:
    // "Level NMI animates $64"), so a single captured frame almost never
    // equals the STATIC color there; this passing across the whole roster is
    // real evidence `gateMap` forwards its `paletteAnim` argument into
    // `checkPalette` rather than a wiring bug silently dropping it for an
    // empty map (which would turn every such level's row into a mismatch).
    'Table 5 (L1 palette) matches on every row the grid cites, animated colors included (N43)',
    () => {
      expect(results.reduce((n, r) => n + r.totals.palette, 0)).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'N30/N31: the report cap (a small maxReported) limits mismatches, but never totals',
    () => {
      const capped = runGate(romPath(VANILLA), CAPTURE_DIR, [0x103], undefined, 1) // $103 has 97 known grid mismatches
      expect(capped[0]!.mismatches.length).toBe(1)
      expect(capped[0]!.totals.grid).toBe(97)
    },
    TIMEOUT,
  )

  it(
    'every map/table mismatch group matches its known count and hash exactly, with no unlisted group',
    () => {
      const expected = new Map(KNOWN.entries.map(e => [`${e.map}:${e.table}`, e]))
      const seen = new Set<string>()
      const problems: string[] = []
      for (const r of results) {
        for (const [table, group] of byTable(r.mismatches)) {
          const key = `${idToHex(r.id)}:${table}`
          seen.add(key)
          const entry = expected.get(key)
          if (!entry) {
            problems.push(`${key}: ${group.length} mismatch(es), not in the known-failure fixture`)
          } else if (group.length !== entry.count) {
            problems.push(`${key}: ${group.length} mismatch(es), fixture says ${entry.count}`)
          } else if (hashMismatches(group) !== entry.sha256) {
            problems.push(`${key}: same count (${entry.count}) but the mismatch set changed`)
          }
        }
      }
      for (const key of expected.keys()) {
        if (!seen.has(key))
          problems.push(`${key}: in the fixture, but this run has no mismatch for it`)
      }
      expect(problems).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'ok is false for exactly the known-failing maps, true for every other listed map',
    () => {
      const notOk = results.filter(r => !r.ok).map(r => idToHex(r.id))
      const ok = results.filter(r => r.ok).map(r => idToHex(r.id))
      expect(new Set(notOk)).toEqual(KNOWN_MAP_IDS)
      expect(ok.some(id => KNOWN_MAP_IDS.has(id))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'the known-failure hash catches a moved cell, proven on the real corpus data (not a literal-vs-literal pair)',
    () => {
      const withMismatches = results.find(r => r.mismatches.length > 0)!
      const [table, group] = [...byTable(withMismatches.mismatches)][0]!
      const entry = KNOWN.entries.find(
        e => e.map === idToHex(withMismatches.id) && e.table === table,
      )!
      expect(hashMismatches(group)).toBe(entry.sha256) // sanity: the real group matches its committed hash
      const moved = group.map((m, i) => (i === 0 ? { ...m, cell: `${m.cell}-moved` } : m))
      expect(hashMismatches(moved)).not.toBe(entry.sha256) // moving one real cell changes it
    },
    TIMEOUT,
  )

  it('#567, #569 and #570 are the only issues, each with a citable example', () => {
    // #571 (the vanilla pipe-color bug) is no longer a known failure: the
    // gate's own `checkPipes` now allows exactly that bug (ALLOWED_PIPE_BUG),
    // so it never reaches this fixture.
    expect(new Set(KNOWN.entries.map(e => e.issue))).toEqual(new Set([567, 570, 587]))
    expect(new Set(KNOWN.examples.map(e => e.issue))).toEqual(new Set([567, 570, 587]))
    for (const ex of KNOWN.examples) {
      const r = results.find(x => idToHex(x.id) === ex.map)!
      expect(r.mismatches).toContainEqual({ table: ex.table, cell: ex.cell, expected: ex.expected, actual: ex.actual }) // prettier-ignore
    }
  })

  it(
    // #571, round 5d: round 5c's "any of the 4 variants" widening rested on
    // a misdiagnosis of $108 and is gone. The tight rules (H_S0: f(s0) or
    // f(s0+$1F) only; V_S0_DEFAULT: the ROM-read compiled default for
    // $133-$13A, read here too, never hardcoded; VERTICAL: the unchanged
    // post-load freeze) still reach 0 pipe mismatches across the full
    // 143-map roster - $108's own s0 is CODE_0581FB's compiled default
    // ($84E0, variant 1 on vanilla), not a stale-DP third variant.
    '#571: 0 pipe mismatches across the full roster with the tightened (round 5d) rules',
    () => {
      expect(results.reduce((n, r) => n + r.totals.pipes, 0)).toBe(0)
    },
    TIMEOUT,
  )

  it(
    // Per-rule counts, measured against the real corpus (round 5d):
    // H_S0=27 (horizontal maps whose s0 matches f(s0+$1F), each confirmed
    // with a full 32-strip load pass - bank_05.asm:907-909's DP-indexed
    // pick with X=2); V_S0_DEFAULT=6 (vertical maps whose s0 keeps
    // CODE_0581FB's compiled default rather than f(s0) - the 7th vertical
    // map's default equals f(s0) outright, so it needs no exemption and is
    // not counted here); VERTICAL=655 (post-load builds outside the load
    // pass, frozen at f(s0+$20)). Asserted per rule, not as an aggregate,
    // so a rule attributing its count to the wrong bucket is caught.
    '#571 per-rule counts (round 5d): H_S0=27, V_S0_DEFAULT=6, VERTICAL=655',
    () => {
      const counts = new Map<string, number>()
      for (const r of results) {
        for (const a of r.allowed) counts.set(a.rule, (counts.get(a.rule) ?? 0) + a.count)
      }
      expect(counts.get(ALLOWED_PIPE_BUG_H_S0) ?? 0).toBe(27)
      expect(counts.get(ALLOWED_PIPE_BUG_V_S0_DEFAULT) ?? 0).toBe(6)
      expect(counts.get(ALLOWED_PIPE_BUG_VERTICAL) ?? 0).toBe(655)
    },
    TIMEOUT,
  )

  it(
    "#571 $0D0: the load's strips 247-250 (frame 452) - 247 got $84E0, 248 onward got $8B30 - are exactly what f(s0) vs f(s0+$1F) predicts, not a mismatch",
    () => {
      const r = results.find(x => idToHex(x.id) === '$0D0')!
      expect(r.totals.pipes).toBe(0)
    },
    TIMEOUT,
  )
})

// Not gated on hasRom: the missing-capture path returns before the ROM path
// is ever read, so this needs no ROM on disk at all.
describe('L1 data gate: capture directory absent', () => {
  it('fails every listed map rather than skipping, without needing a ROM read', () => {
    const results = runGate(romPath(VANILLA), `${CAPTURE_DIR}-does-not-exist`, [0x105, 0x106])
    expect(results.every(r => r.unavailable)).toBe(true)
  })
})
