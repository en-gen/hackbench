// Writes a copy of the 65816 core whose ADC ignores the carry flag, for proving
// the comparator goes red:  node plant_adc_defect.mjs <Cpu65816.ts> <out.ts>
// then: compare_sprite_trace.mts <fixtures> --core <out.ts>. The original is
// never touched; the plant is refused if its anchor line is not found once.
import { readFileSync, writeFileSync } from 'node:fs'

const [src, out] = process.argv.slice(2)
const anchor = 'const r = a + b + +this.c'
const text = readFileSync(src, 'utf8')
if (text.split(anchor).length !== 2) throw new Error(`anchor "${anchor}" not found exactly once in ${src}`)
writeFileSync(out, text.replace(anchor, "const r = a + b + (name === 'ADC' ? 0 : +this.c) // PLANTED DEFECT: ADC ignores carry-in"))
console.log('planted ->', out)
