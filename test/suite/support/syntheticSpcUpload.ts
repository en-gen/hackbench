/**
 * Byte builders shared by the synthetic SPC upload tests: the routine that
 * stages a ROM address in $00-$02, 65816 call encoding, and the SPC upload
 * block format. Synthetic only; no ROM bytes.
 */

/** LDA #lo : STA $0000 : LDA #hi : STA $0001 : LDA #bank : STA $0002 */
export const uploadRoutine = (romAddr: number): number[] => [
  0xa9,
  romAddr & 0xff,
  0x8d,
  0x00,
  0x00,
  0xa9,
  (romAddr >> 8) & 0xff,
  0x8d,
  0x01,
  0x00,
  0xa9,
  (romAddr >> 16) & 0xff,
  0x8d,
  0x02,
  0x00,
]

export const jsr = (target: number): number[] => [0x20, target & 0xff, (target >> 8) & 0xff]

export const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]

/** An upload block: [size, aramDest] then the data. */
export const block = (dest: number, bytes: number[]): number[] => [
  ...u16(bytes.length),
  ...u16(dest),
  ...bytes,
]

/** LoROM SNES address to file offset for a 0x80000-byte (or larger) cart. */
export const fileOffset = (snes: number): number => ((snes >> 16) & 0x7f) * 0x8000 + (snes & 0x7fff)
