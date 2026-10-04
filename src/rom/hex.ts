/** Zero-padded uppercase hex string helpers - no `$` prefix, callers add as needed. */
export const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0')
export const hex3 = (n: number): string => n.toString(16).toUpperCase().padStart(3, '0')
export const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0')
export const hex6 = (n: number): string => n.toString(16).toUpperCase().padStart(6, '0')
/** `$`-prefixed three-digit slot form, e.g. `$105`. */
export const hex3s = (n: number): string => `$${hex3(n)}`
