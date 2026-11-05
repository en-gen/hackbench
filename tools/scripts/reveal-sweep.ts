/**
 * The reveal audit over every map of one or more ROMs (#1132 acceptance 2, 4, 6, 10). Local only; writes text of
 * ids, maps, columns and counts, never ROM bytes or images, to the paths given.
 *
 *   npx tsx tools/scripts/reveal-sweep.ts --rom <file> [--rom <file>...] --out <report.txt> [--solid <list.txt>]
 *
 * The report is deterministic (sorted, no times); the run time goes to stdout only.
 */
import { readFileSync, writeFileSync } from 'fs'
import { basename } from 'path'
import { REVEAL_TEXT } from '../../theia/extension/src/node/map-sprites'
import { type RevealRow, revealReport, solidToDoorText } from './spriteReport'
import { revealRows } from './spriteReportRun'

const args = process.argv.slice(2)
const roms: string[] = []
let out = ''
let solid = ''
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--rom') roms.push(args[++i] ?? '')
  else if (args[i] === '--out') out = args[++i] ?? ''
  else if (args[i] === '--solid') solid = args[++i] ?? ''
}
if (!roms.length || !out) {
  console.error(
    'usage: reveal-sweep --rom <file> [--rom <file>...] --out <report.txt> [--solid <list.txt>]',
  )
  process.exit(2)
}

/** A marker reason with its ids and numbers blanked, so the same refusal counts once. */
const reasonClass = (m: string) =>
  m
    .replace(/\$[0-9a-f]+/gi, '$..')
    .replace(/\d+/g, 'N')
    .slice(0, 110)
const say = (code: string) => (REVEAL_TEXT as Record<string, string>)[code] ?? code

const t0 = Date.now()
const sections: string[] = []
const all: RevealRow[] = []
for (const rom of roms) {
  const bytes = readFileSync(rom)
  const rows: RevealRow[] = []
  const skipped: string[] = []
  for (let map = 0; map < 0x200; map++) {
    try {
      rows.push(...revealRows(bytes, rom, map))
    } catch (e) {
      skipped.push(
        `map ${map.toString(16)}: ${reasonClass((e as Error).message.replace(/^map [0-9a-f]+: /, ''))}`,
      )
    }
  }
  all.push(...rows)
  const markers = new Map<string, number>()
  for (const r of rows)
    if (r.marker) markers.set(reasonClass(r.marker), (markers.get(reasonClass(r.marker)) ?? 0) + 1)
  const byCondition = new Map<string, number>()
  for (const r of rows)
    if (r.condition) byCondition.set(r.condition, (byCondition.get(r.condition) ?? 0) + 1)
  sections.push(
    [
      `=== ${roms.length > 1 ? basename(rom) : 'ROM'} ===`,
      revealReport(rows),
      'Revealed per condition:',
      ...[...byCondition].sort().map(([k, n]) => `${k}: ${n}`),
      '',
      'Markers per reason:',
      ...[...markers].sort().map(([k, n]) => `${k}: ${n}`),
      '',
      `Maps not run: ${skipped.length}`,
      ...skipped,
      '',
    ].join('\n'),
  )
}
writeFileSync(out, sections.join('\n'))
if (solid) writeFileSync(solid, solidToDoorText(all, say))
console.log(
  `${roms.length} ROM(s), ${all.length} sprites, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
)
