/**
 * Placed-sprite list ids that the level loader turns into stationary Koopa shells.
 *
 * CODE_02A8D0 (SMWDisX bank_02.asm:5339-5340, 5349-5350) takes list ids $DA-$DD and $DF; $DE and
 * $E0 branch away earlier (5312, 5325: Eeries and platforms) and $E1 and up go elsewhere (5349-5358).
 * It stores status 9 (5361, stored 5455) and, for status >= 9, the sprite number
 * `id - $DA + 4` (SEC; SBC #$DA; CLC; ADC #$04, 5456-5462). The status-1 INIT never runs; only
 * InitSpriteTables does (5498).
 *
 * 5464-5471 also remap 4 -> 7 and 5 -> 6 when OWLevelTileSettings+$49 is negative (the special
 * world flag in the save). That flag is read as clear (a fresh save), so no remap happens here.
 */
export const SHELL_STATUS = 9

/** The sprite number the loader gives list id `id`, or undefined when `id` is not a shell. */
export function shellSpriteNumber(id: number): number | undefined {
  if (id < 0xda || id > 0xdf || id === 0xde) return undefined
  return id - 0xda + 4
}
