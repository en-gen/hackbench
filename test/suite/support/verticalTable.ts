/**
 * A synthetic VerticalTable-shaped fixture, for unit tests that build their
 * own header bytes and need a table to pass parseLevelObjects. NOT ROM
 * content (docs/testing.md): entries cycle every 8-byte format bit, bit 0 =
 * L1 (foreground) vertical, bit 1 = L2 (background) vertical, bit 7 (a
 * boss-level flag this project ignores) set alone at index 4 of each cycle
 * to prove it does not count as vertical on its own. Production code always
 * reads this table from the ROM via LevelTableGate.readVerticalTable.
 */
export const SYNTHETIC_VERTICAL_TABLE: readonly number[] = [
  0x00, 0x01, 0x02, 0x03, 0x80, 0x81, 0x82, 0x83, 0x00, 0x01, 0x02, 0x03, 0x80, 0x81, 0x82, 0x83,
  0x00, 0x01, 0x02, 0x03, 0x80, 0x81, 0x82, 0x83, 0x00, 0x01, 0x02, 0x03, 0x80, 0x81, 0x82, 0x83,
]
