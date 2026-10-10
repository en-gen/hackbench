/**
 * Re-derives the docs/rom/hack-corpus.md survey figures (#543) over the hack
 * store plus the vanilla-based corpus ROMs. Hand-run, never CI:
 *
 *   npx tsx tools/scripts/hack-survey.ts [--out figures.json]
 *
 * HACKBENCH_HACKS names the store (read only). Prints counts only; no ROM bytes.
 * Compare with the doc's dated figures, then update the doc by hand.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { calibrate, figures, surveyRom, type RomFacts } from './hackSurvey'
import { CORPUS, romPath, VANILLA } from '../../test/suite/support/corpus'

const store = process.env.HACKBENCH_HACKS ?? join(romPath(VANILLA), '..', '..', 'hacks')
const outFlag = process.argv.indexOf('--out')
const vanilla = new Uint8Array(readFileSync(romPath(VANILLA)))
const cal = calibrate(vanilla)
const index = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8')) as {
  hacks: { smwc_id: number; patched_rom_file?: string; patch_result?: string }[]
}
const built = index.hacks.filter(h => h.patch_result === 'success' && h.patched_rom_file)
const facts = (path: string): RomFacts =>
  surveyRom(vanilla, new Uint8Array(readFileSync(path)), cal)
const hacks = built.map(h => facts(join(store, h.patched_rom_file!)))
const corpus = CORPUS.map(name => facts(romPath(name)))
const result = { store: figures(hacks), storePlusCorpus: figures([...hacks, ...corpus]) }
console.log(JSON.stringify(result, null, 2))
if (outFlag > 0) writeFileSync(process.argv[outFlag + 1]!, JSON.stringify(result, null, 2))
