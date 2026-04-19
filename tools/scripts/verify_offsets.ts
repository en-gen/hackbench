import { SmwRom } from '../../src/rom/SmwRom'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`
const rom = SmwRom.open(ROM_PATH)

function dump(addr: number, len: number, label: string) {
  const bytes: number[] = []
  for (let i = 0; i < len; i++) {
    bytes.push(rom.rom.readByte(addr + i) ?? 0)
  }
  const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')
  console.log(`${label} $${addr.toString(16).padStart(6, '0').toUpperCase()}:`)
  // break into lines every 16
  for (let i = 0; i < len; i += 16) {
    const slice = bytes.slice(i, i + 16).map(b => b.toString(16).padStart(2, '0')).join(' ')
    console.log(`  +${i.toString().padStart(3, '0')}: ${slice}`)
  }
}

dump(0x0DDCEA, 64, 'CODE_0DDCEA')
console.log()
dump(0x0DDD2E, 64, 'CODE_0DDD2E')
console.log()
dump(0x0DE135, 96, 'CODE_0DE135')
