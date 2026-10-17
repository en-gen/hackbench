/**
 * The synthetic cart's stand-in for CODE_009FB8 (Layer 3 handling, bank_00.asm:4870) and its
 * tide helper CODE_00A045 (bank_00.asm:4219-4238). The lookup prefix and the helper carry the
 * shapes the level loader byte-checks; the rest is hand-written (non-tide exits are a bare RTS).
 * Table: tileset 0 = [1, 2, $C0], tileset 1 = [1, $80, $81], the Layer3TilemapSettings layout
 * (bank_00.asm:4121): below $80 is a tide, $80 and up is not.
 */
export const LAYER3_TABLE_AT = 0x009f88
export const LAYER3_AT = 0x009fb8
export const TIDE_HELPER_AT = 0x00a045
/** The first and last byte of the interaction buffer the helper clears ($7E:E400, $7E:FDFE). */
export const BUFFER_FIRST = 0x7ee400
export const BUFFER_LAST = 0x7efdfe

// prettier-ignore
export const LAYER3_PREFIX: readonly number[] = [
  0xad, 0x31, 0x19, 0x0a, 0x18, 0x6d, 0x31, 0x19, 0x85, 0x00, // tileset * 3 into $00
  0xad, 0xe3, 0x1b, 0xf0, 0x4b,                                 // Layer3Setting = 0: skip
  0x3a, 0x18, 0x65, 0x00, 0xaa, 0xbd, 0x88, 0x9f,               // table byte
  0x30, 0x19, 0x8d, 0x03, 0x14, 0x4a, 0x08, 0x20, 0x45, 0xa0,   // negative: skip; else the tide helper
]

// prettier-ignore
export const TIDE_HELPER: readonly number[] = [
  0xc2, 0x30, 0xa2, 0x00, 0x01, 0xa0, 0x58, 0x00, 0xa9, 0x00, 0x00, 0x9f, 0x00, 0xe3, 0x7e, 0xe8,
  0xe8, 0x88, 0xd0, 0xf7, 0x8a, 0x18, 0x69, 0x00, 0x01, 0xaa, 0xe0, 0x00, 0x1b, 0x90, 0xe6, 0xe2,
  0x30, 0xa9, 0x80, 0x04, 0x5b, 0x60,
]

export function putLayer3(put: (snes: number, bytes: number[]) => void): void {
  put(LAYER3_TABLE_AT, [1, 2, 0xc0, 1, 0x80, 0x81])
  put(LAYER3_AT, [...LAYER3_PREFIX, 0x28, 0x60]) // PLP, RTS
  put(0x009fea, [0x60])
  put(0x00a012, [0x60])
  put(TIDE_HELPER_AT, [...TIDE_HELPER])
}
