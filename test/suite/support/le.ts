/** Little-endian byte builders for synthetic ROM fixtures. */
export const le16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff]
export const le24 = (v: number): number[] => [...le16(v), (v >> 16) & 0xff]
