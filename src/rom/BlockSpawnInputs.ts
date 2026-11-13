/**
 * The WRAM cells the item block spawn (CODE_0288DC, SMWDisX bank_02.asm:1097-1292) reads, seeded
 * generically for a block at a map pixel. Shared by the map view's block art and by YoshiWings,
 * so neither carries its own copy.
 */

/** rammap.asm cells: the content index and the block's position. */
const IN = { content: 0x05, touchY: 0x98, touchX: 0x9a, directCoinInit: 0x1432, yoshiLoose: 0x18e2, layer: 0x1933 } as const // prettier-ignore

/** The cells the spawn reads, for a block at map pixel (x, y): generic, no per-sprite values. */
export function spawnInputs(content: number, x: number, y: number): Record<number, number> {
  const [px, py] = [Math.max(0, x), Math.max(0, y)]
  return {
    [IN.content]: content,
    [IN.touchX]: px & 0xff,
    [IN.touchX + 1]: (px >> 8) & 0xff,
    [IN.touchY]: py & 0xff,
    [IN.touchY + 1]: (py >> 8) & 0xff,
    [IN.layer]: 0,
    [IN.yoshiLoose]: 0,
    [IN.directCoinInit]: 0,
  }
}
