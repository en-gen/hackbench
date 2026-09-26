/**
 * Run the L1 (foreground) data gate (en-gen/hackbench#421) from the
 * command line.
 *
 *   npm run capture:gate -- [captures-dir] [--maps 105,1bd] [--rom <path>] [--known <file>]
 *
 * Exits 1 on any not-ok map, or when the ROM or the captures cannot be
 * found. Without `[captures-dir]`, uses `CAPTURE_DIR`; without `--maps`,
 * gates the full committed 143-map roster; without `--rom`, uses the
 * vanilla ROM from the ROM corpus. With `--known <file>` (typically
 * `test/suite/unit/fixtures/fgKnownFailures.json`), a map whose mismatches
 * match that file's counts and hashes exactly, table for table, exits 0
 * instead of 1 - the shape the nightly job needs, since the roster is not
 * fully clean (see the file's own issues). `parseArgs` and `report` are
 * exported for testing without a ROM: neither one reads the filesystem.
 */
import { parseArgs as nodeParseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { romPath, VANILLA, CAPTURE_DIR } from '../../test/suite/support/corpus'
import { FG_GATE_MAPS, idToHex } from './fgGateMaps'
import { runGate, hashMismatches, type GateMismatch, type GateResult } from './capture_gate'

const MAP_ID = /^[0-9a-f]{1,3}$/i
const USAGE = 'usage: capture_gate_cli.ts [captures-dir] [--maps 105,1bd] [--rom <path>] [--known <file>]' // prettier-ignore

export interface KnownEntry {
  map: string
  table: string
  count: number
  sha256: string
}

export interface CliArgs {
  captures: string
  maps: number[]
  rom: string
  known?: string
}

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): CliArgs | { error: string } {
  const base = env.INIT_CWD ?? cwd
  let values: { rom?: string; maps?: string; known?: string }
  let positionals: string[]
  try {
    ;({ values, positionals } = nodeParseArgs({
      args: argv,
      options: { rom: { type: 'string' }, maps: { type: 'string' }, known: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    }))
  } catch (e) {
    return { error: (e as Error).message }
  }
  if (positionals.length > 1) return { error: `unexpected extra argument(s): ${positionals.slice(1).join(' ')}` } // prettier-ignore
  let maps = [...FG_GATE_MAPS]
  if (values.maps !== undefined) {
    const ids = values.maps.split(',').map(s => s.trim())
    if (ids.some(s => !MAP_ID.test(s))) return { error: `--maps: not a hex map id (1-3 hex digits): ${values.maps}` } // prettier-ignore
    maps = ids.map(s => parseInt(s, 16))
  }
  return {
    captures: positionals[0] ? resolve(base, positionals[0]) : CAPTURE_DIR,
    maps,
    rom: values.rom ? resolve(base, values.rom) : romPath(VANILLA),
    known: values.known ? resolve(base, values.known) : undefined,
  }
}

/** True iff every table with a mismatch on this map matches a known entry's count and hash exactly, and no known entry for this map is now silently absent. `unavailable` never matches: the fixture has no shape for "could not be read". */ // prettier-ignore
export function matchesKnown(result: GateResult, known: readonly KnownEntry[]): boolean {
  if (result.unavailable !== undefined) return false
  const mapId = idToHex(result.id)
  const byTable = new Map<string, GateMismatch[]>()
  for (const m of result.mismatches) (byTable.get(m.table) ?? byTable.set(m.table, []).get(m.table)!).push(m) // prettier-ignore
  const expected = new Map(known.filter(k => k.map === mapId).map(k => [k.table, k]))
  const tables = new Set([...byTable.keys(), ...expected.keys()])
  for (const table of tables) {
    const observed = byTable.get(table) ?? []
    const entry = expected.get(table)
    if (!entry || observed.length !== entry.count || hashMismatches(observed) !== entry.sha256) return false // prettier-ignore
  }
  return true
}

/** The run's printed lines and exit code (1 on any not-ok, un-known map, else 0). Allowed pipe-bug differences print even on an otherwise-clean map, so the exemption stays visible and bounded rather than silently folded into "pass". */ // prettier-ignore
export function report(
  results: readonly GateResult[],
  known?: readonly KnownEntry[],
): { lines: string[]; exitCode: number } {
  const lines: string[] = []
  let failed = 0
  for (const r of results) {
    const accepted = r.ok || (!!known && matchesKnown(r, known))
    if (!accepted) failed++
    if (accepted && r.allowed.length === 0) continue
    if (accepted) {
      lines.push(`${idToHex(r.id)}  ok`)
    } else if (r.unavailable) {
      lines.push(`${idToHex(r.id)}  FAIL  ${r.unavailable}`)
    } else {
      const shown = r.mismatches.length
      const total = Object.values(r.totals).reduce((a, b) => a + b, 0)
      lines.push(`${idToHex(r.id)}  FAIL  ${shown} of ${total} mismatch(es) shown`)
      for (const m of r.mismatches.slice(0, 10)) {
        lines.push(`      ${m.table} ${m.cell}: expected ${m.expected}, actual ${m.actual}`)
      }
    }
    for (const a of r.allowed) lines.push(`      (allowed) ${a.rule}: ${a.count}`)
    for (const note of r.overflow) lines.push(`      (informational) ${note}`)
  }
  lines.push(`\n${results.length} map(s): ${results.length - failed} pass, ${failed} fail`)
  return { lines, exitCode: failed ? 1 : 0 }
}

/* istanbul ignore if -- exercised by the tests through parseArgs/report directly, not this entry point */
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2))
  if ('error' in args) {
    console.error(USAGE)
    console.error(args.error)
    process.exit(2)
  }
  const known = args.known
    ? (JSON.parse(readFileSync(args.known, 'utf8')).entries as KnownEntry[])
    : undefined
  const results = runGate(args.rom, args.captures, args.maps, undefined, known ? Infinity : undefined) // prettier-ignore
  const { lines, exitCode } = report(results, known)
  for (const line of lines) console.log(line)
  process.exit(exitCode)
}
