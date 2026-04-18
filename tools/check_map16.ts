import { SmwRom } from '../src/rom/SmwRom'
import { loadAllMap16 } from '../src/rom/Map16'
const rom = SmwRom.open('test/roms/Super Mario World (USA).vanilla.sfc')
const tiles = loadAllMap16(rom.rom)
console.log('Total:', tiles.length)
console.log('First 10 IDs:', tiles.slice(0, 10).map(t => t.id))
console.log('ID at index 0xCF:', tiles[0xCF].id)
let sequential = true
for (let i = 0; i < tiles.length; i++) {
  if (tiles[i].id !== i) { sequential = false; console.log('Break at', i, '→ id', tiles[i].id); break }
}
console.log('Sequential IDs:', sequential)

// Compare with LM: tile $001 should be the mushroom block
// Show its subtile chars
const t1 = tiles[1]
console.log('\nTile $001:', 'TL=$' + t1.tl.charNum.toString(16), 'TR=$' + t1.tr.charNum.toString(16),
  'BL=$' + t1.bl.charNum.toString(16), 'BR=$' + t1.br.charNum.toString(16))
console.log('  palettes:', t1.tl.palette, t1.tr.palette, t1.bl.palette, t1.br.palette)

// Tile $002 (ON/OFF switch in LM?)
const t2 = tiles[2]
console.log('Tile $002:', 'TL=$' + t2.tl.charNum.toString(16), 'TR=$' + t2.tr.charNum.toString(16))
