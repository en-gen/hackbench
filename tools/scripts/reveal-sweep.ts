/**
 * The reveal audit over every map of one or more ROMs (#1132 acceptance 2, 4, 6, 10). Local only; writes text of
 * ids, maps, columns and counts, never ROM bytes or images, to the paths given.
 *
 *   npx tsx tools/scripts/reveal-sweep.ts --rom <file> [--rom <file>...] --out <report.txt> [--solid <list.txt>]
 *
 * The report is deterministic (sorted, no times); the run time goes to stdout only.
 */
import { readFileSync, writeFileSync } from 'fs'
import { basename, resolve } from 'path'
import { REVEAL_TEXT } from '../../theia/extension/src/node/map-sprites'
import {
  isInside,
  reasonClass,
  type RevealRow,
  solidToDoorText,
  sweepSection,
} from './spriteReport'
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

// Reports hold map, column and id lists of a copyrighted ROM; they stay out of the public checkout.
for (const p of [out, solid].filter(Boolean))
  if (isInside(p, resolve(__dirname, '..', '..'))) {
    console.error(`refusing ${p}: it is inside the hackbench checkout. Nothing written.`)
    process.exit(2)
  }

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
  sections.push(sweepSection(roms.length > 1 ? basename(rom) : 'ROM', rows, skipped))
}
writeFileSync(out, sections.join('\n'))
if (solid) writeFileSync(solid, solidToDoorText(all, say))
console.log(
  `${roms.length} ROM(s), ${all.length} sprites, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
)
