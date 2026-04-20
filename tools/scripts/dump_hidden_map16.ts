import { SmwRom } from '../../src/rom/SmwRom'
import { loadAllMap16 } from '../../src/rom/Map16'

const rom = SmwRom.open(`${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`)
for (const tileset of [0, 1, 2, 14]) {
  console.log(`\n=== tileset ${tileset} ===`)
  const defs = loadAllMap16(rom.rom, tileset)
  for (const id of [0x1F, 0x20, 0x27, 0x28, 0x29, 0x24, 0x2A, 0x2B, 0x2F]) {
    const d = defs[id]
    const s = (x: { charNum: number; palette: number; flipX: boolean; flipY: boolean }) =>
      `c=$${x.charNum.toString(16).padStart(3, '0')} p=${x.palette}${x.flipX ? 'H' : ''}${x.flipY ? 'V' : ''}`
    console.log(`  tile $${id.toString(16).toUpperCase().padStart(2, '0')}: TL[${s(d.tl)}] TR[${s(d.tr)}] BL[${s(d.bl)}] BR[${s(d.br)}]`)
  }
}
