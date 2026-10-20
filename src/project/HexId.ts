/**
 * Parse an id as people type it: `109`, `$109`, `0x109`, `1fc`. All hex, as the
 * explorers print ids (`$1FC`), so `109` means slot $109 and not decimal 109.
 *
 * Shared by the alias file reader (Aliases.ts) and the explorer search box so
 * both accept the same spellings. No shell imports, same rule as src/project/.
 */
export function parseHexId(raw: string): number | null {
  const stripped = raw.trim().replace(/^\$/, '').replace(/^0x/i, '')
  if (!/^[0-9a-f]+$/i.test(stripped)) return null
  return parseInt(stripped, 16)
}

/**
 * The canonical key for an id: uppercase hex, at least two digits.
 *
 * Two digits is the natural width of a BGM command; a wider id (a map's
 * three-digit translevel) keeps its own width rather than being truncated.
 * Fixed here rather than at each call site so a key written by the music
 * panel is the same string the map tree would write.
 */
export function aliasKey(id: number): string {
  return id.toString(16).toUpperCase().padStart(2, '0')
}
