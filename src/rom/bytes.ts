/** Little-endian readers over any byte container (Buffer, Uint8Array, plain array). */
export const le16 = (b: ArrayLike<number>, at: number): number => b[at]! | (b[at + 1]! << 8)
/** Bank kept: a read, not a key. Folding $FE/$FF onto $7E/$7F would make a 4 MB ROM's code unreadable; comparisons wrap it in `mirror()`. */
export const le24 = (b: ArrayLike<number>, at: number): number => le16(b, at) | (b[at + 2]! << 16)
