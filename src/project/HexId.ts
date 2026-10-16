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
