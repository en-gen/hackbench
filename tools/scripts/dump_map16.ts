/**
 * Dump raw Map16 data for specific tiles to compare against Lunar Magic.
 * Run: npx tsx tools/scripts/dump_map16.ts
 */
import { SmwRom } from '../src/rom/SmwRom'
import { RomFile } from '../src/rom/RomFile'
import { MAP16_PAGE0, MAP16_PAGE1, MAP16_TILE_BYTES } from '../src/rom/Map16'

const rom = SmwRom.open('test/roms/Super Mario World (USA).vanilla.sfc')

// Verify the ROM addresses by dumping raw bytes
console.log('Map16 page 0 address: $' + MAP16_PAGE0.toString(16).toUpperCase())
console.log('Map16 page 1 address: $' + MAP16_PAGE1.toString(16).toUpperCase())

// Read first 16 bytes at page 0 (tiles $000 and $001)
const raw0 = rom.rom.readAt(MAP16_PAGE0, 16)!
console.log('\nRaw bytes at $0D8000 (tile $000 and $001):')
console.log('  ' + Array.from(raw0).map(b => b.toString(16).padStart(2, '0')).join(' '))

// Read first 16 bytes at page 1 (tiles $100 and $101)
const raw1 = rom.rom.readAt(MAP16_PAGE1, 16)!
console.log('Raw bytes at $0DC000 (tile $100 and $101):')
console.log('  ' + Array.from(raw1).map(b => b.toString(16).padStart(2, '0')).join(' '))

// Decode a few tiles and show their subtile info
// In LM, click a tile to see its 4 subtile char numbers
function dumpTile(id: number) {
  const page = id < 256 ? MAP16_PAGE0 : MAP16_PAGE1
  const idx = id < 256 ? id : id - 256
  const addr = page + idx * MAP16_TILE_BYTES
  const buf = rom.rom.readAt(addr, 8)!

  const w0 = buf.readUInt16LE(0)
  const w1 = buf.readUInt16LE(2)
  const w2 = buf.readUInt16LE(4)
  const w3 = buf.readUInt16LE(6)

  function decode(w: number, label: string) {
    const ch = w & 0x3FF
    const pal = (w >> 10) & 7
    const pri = (w >> 13) & 1
    const fx = (w >> 14) & 1
    const fy = (w >> 15) & 1
    console.log(`  ${label}: raw=$${w.toString(16).padStart(4,'0')} char=$${ch.toString(16).padStart(3,'0')} pal=${pal} pri=${pri} flipX=${fx} flipY=${fy}`)
  }

  console.log(`\nTile $${id.toString(16).toUpperCase().padStart(3,'0')} (raw: ${Array.from(buf).map(b=>b.toString(16).padStart(2,'0')).join(' ')}):`)
  console.log('  (Our decode: word0=TL, word1=BL, word2=TR, word3=BR)')
  decode(w0, 'word0→TL')
  decode(w1, 'word1→BL')
  decode(w2, 'word2→TR')
  decode(w3, 'word3→BR')
}

// Tiles to check — compare these against LM
// In LM: click a tile, look at the 4 boxes showing subtile chars
dumpTile(0x000)  // empty/first tile
dumpTile(0x001)  // second tile
dumpTile(0x00F)  // ground
dumpTile(0x025)  // air/empty
dumpTile(0x100)  // first page 1 tile
dumpTile(0x101)  // second page 1 tile
dumpTile(0x0CF)  // canopy top
dumpTile(0x0DD)  // fence post
