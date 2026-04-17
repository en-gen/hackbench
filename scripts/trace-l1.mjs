import { readFileSync } from 'fs'
const raw = readFileSync('C:/Users/engenb/Super Mario World (USA).sfc')
const hdrOff = (raw.length % 1024) === 512 ? 512 : 0
const off = s => hdrOff + ((s>>>16)&0x7F)*0x8000 + ((s&0xFFFF)-0x8000)
const rd = s => raw[off(s)]
const base = 0x05E000 + 0x105*3
const ptr = (rd(base+2)<<16)|(rd(base+1)<<8)|rd(base)
const data = raw.subarray(off(ptr), off(ptr)+0x800)

// Print raw L1 bytes from offset 0 to 0x100
let pos = 5, screen = 0, i = 0
console.log('Header:', [...data.subarray(0,5)].map(b=>b.toString(16).padStart(2,'0')).join(' '))
console.log()
while (pos < data.length) {
  const b0 = data[pos]
  if (b0 === 0xFF) { console.log(`offset ${pos}: 0xFF (terminator)`); break }
  const b1 = data[pos+1], b2 = data[pos+2]
  const NS = (b0 & 0x80) !== 0
  const HC = (b0 & 0x10) !== 0
  const objNum = ((b1>>4)&0xF) | ((b0&0x60)>>1)
  const isExt = objNum === 0
  const consumedBytes = (isExt && b2 === 0) ? 4 : 3
  if (NS) screen++

  const yLocal = (b0 & 0x0F) + (HC ? 16 : 0)
  const xLocal = b1 & 0x0F
  const tag = isExt ? `ext $${b2.toString(16).padStart(2,'0')}` : `std $${objNum.toString(16).padStart(2,'0')}`
  const rawHex = [...data.subarray(pos, pos + consumedBytes)].map(b=>b.toString(16).padStart(2,'0')).join(' ')
  const flags = (NS?'NS':'  ') + ' ' + (HC?'HC':'  ')
  console.log(`#${String(i).padStart(3)} off=${String(pos).padStart(3)} scr=0x${screen.toString(16).padStart(2,'0')} x=${xLocal} y=${yLocal} ${tag} size=0x${b2.toString(16).padStart(2,'0')} ${flags}  ${rawHex}`)

  pos += consumedBytes
  if (isExt && b2 === 0x01) screen = b0 & 0x1F
  i++
  if (i > 50) break
}
