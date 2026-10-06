/**
 * Level modes whose sprite layering has not been checked against the ROM. The
 * map view warns on these; rendering is unchanged. Mode 1E: #617.
 */
export const UNVERIFIED_MODES: ReadonlySet<number> = new Set([0x1e])

export function isUnverifiedMode(mode: number | undefined): boolean {
  return mode !== undefined && UNVERIFIED_MODES.has(mode)
}
