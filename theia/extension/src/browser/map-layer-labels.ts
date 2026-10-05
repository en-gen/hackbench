/**
 * Toolbar wording for the map tab's layers. Layer 2 is the interactive
 * foreground on the level modes whose VerticalTable bit 7 is set
 * (bank_00.asm:11736-11738), whether or not the map has a layer 3 (#562).
 */
export const layer2Label = (l?: { layer2Interactive: boolean }): string =>
  l?.layer2Interactive ? 'Layer 2 · Foreground' : 'Layer 2 · Background'
