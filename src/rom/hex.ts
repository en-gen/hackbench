/** Zero-padded uppercase hex string helpers - no `$` prefix, callers add as needed. */
export const hex = (n: number, width = 0): string =>
  n.toString(16).toUpperCase().padStart(width, '0')
export const hex2 = (n: number): string => hex(n, 2)
export const hex3 = (n: number): string => hex(n, 3)
export const hex4 = (n: number): string => hex(n, 4)
export const hex6 = (n: number): string => hex(n, 6)
/** `$`-prefixed forms. The six-digit one is `formatAddr` in addressing.ts. */
export const hexs = (n: number, width = 0): string => `$${hex(n, width)}`
export const hex2s = (n: number): string => hexs(n, 2)
export const hex3s = (n: number): string => hexs(n, 3)
export const hex4s = (n: number): string => hexs(n, 4)
