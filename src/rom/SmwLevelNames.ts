/**
 * SmwLevelNames.ts
 *
 * Display names for vanilla Super Mario World (US) ROM level indices.
 * Used for labelling the explorer tree only — NOT an authoritative level list.
 * The actual list of levels is always derived from ROM data by SmwRom.classifyLevels().
 *
 * Source: Lunar Magic "Edit Level Names" dialog, vanilla unmodified ROM.
 * Modded ROMs will show unnamed entries (index hex) for any slot not in this map.
 */

const NAMES: Record<number, string> = {
  // ── Main overworld ($000–$024) ─────────────────────────────────────────────
  0x000: 'VANILLA SECRET 2',
  0x001: 'VANILLA SECRET 3',
  0x002: 'VANILLA SECRET 4',
  0x003: 'TOP SECRET AREA',
  0x004: 'DONUT GHOST HOUSE',
  0x005: 'DONUT PLAINS 3',
  0x006: 'DONUT PLAINS 4',
  0x007: "#2 MORTON'S CASTLE",
  0x008: 'GREEN SWITCH PALACE',
  0x009: 'DONUT PLAINS 2',
  0x00A: 'DONUT SECRET 1',
  0x00B: 'VANILLA FORTRESS',
  0x00C: 'BUTTER BRIDGE 1',
  0x00D: 'BUTTER BRIDGE 2',
  0x00E: "LUDWIG'S CASTLE",
  0x00F: 'CHEESE BRIDGE AREA',
  0x010: 'COOKIE MOUNTAIN',
  0x011: 'SODA LAKE',
  0x012: 'STAR ROAD',
  0x013: 'DONUT SECRET HOUSE',
  0x014: 'YELLOW SWITCH PALACE',
  0x015: 'DONUT PLAINS 1',
  0x016: 'STAR ROAD',
  0x017: "#2 MORTON'S PLAINS",
  0x018: 'SUNKEN GHOST SHIP',
  0x019: "#2 MORTON'S PLAINS",
  0x01A: "#6 WENDY'S CASTLE",
  0x01B: 'CHOCOLATE FORTRESS',
  0x01C: 'CHOCOLATE ISLAND 5',
  0x01D: 'CHOCOLATE ISLAND 4',
  0x01E: 'STAR ROAD',
  0x01F: 'FOREST FORTRESS',
  0x020: "#5 ROY'S CASTLE",
  0x021: 'CHOCO-GHOST HOUSE',
  0x022: 'CHOCOLATE ISLAND 1',
  0x023: 'CHOCOLATE ISLAND 3',
  0x024: 'CHOCOLATE ISLAND 2',

  // ── Yoshi's Island sub-map ($101–$106) ─────────────────────────────────────
  0x101: "#1 IGGY'S CASTLE",
  0x102: "YOSHI'S ISLAND 4",
  0x103: "YOSHI'S ISLAND 3",
  0x104: "YOSHI'S HOUSE",
  0x105: "YOSHI'S ISLAND 1",
  0x106: "YOSHI'S ISLAND 2",

  // ── Mixed sub-maps ($107–$10D) ──────────────────────────────────────────────
  0x107: 'VANILLA GHOST HOUSE',
  0x108: 'STAR ROAD',
  0x109: 'VANILLA SECRET 1',
  0x10A: 'VANILLA DOME 3',
  0x10B: 'DONUT SECRET 2',
  0x10C: 'STAR ROAD',
  0x10D: 'FRONT DOOR',

  // ── Valley of Bowser / assorted ($110–$11C) ─────────────────────────────────
  0x110: "#7 LARRY'S CASTLE",
  0x111: 'VALLEY FORTRESS',
  // 0x112 has no name in vanilla
  0x113: 'VALLEY OF BOWSER 3',
  0x114: 'VALLEY GHOST HOUSE',
  0x115: 'VALLEY OF BOWSER 2',
  0x116: 'VALLEY OF BOWSER 1',
  0x117: 'CHOCOLATE SECRET',
  0x118: 'VANILLA DOME 2',
  0x119: 'VANILLA DOME 4',
  0x11A: 'VANILLA DOME 1',
  0x11B: 'RED SWITCH PALACE',
  0x11C: "#3 LEMMY'S CASTLE",

  // ── Forest of Illusion ($11D–$123) ──────────────────────────────────────────
  0x11D: 'FOREST GHOST HOUSE',
  0x11E: 'FOREST OF ILLUSION 1',
  0x11F: 'FOREST OF ILLUSION 4',
  0x120: 'FOREST OF ILLUSION 2',
  0x121: 'BLUE SWITCH PALACE',
  0x122: 'FOREST SECRET AREA',
  0x123: 'FOREST OF ILLUSION 3',

  // ── Special World ($124–$12D) ───────────────────────────────────────────────
  0x124: 'STAR ROAD',
  0x125: 'FUNKY',
  0x126: 'OUTRAGEOUS',
  0x127: 'MONDO',
  0x128: 'GROOVY',
  0x129: 'STAR ROAD',
  0x12A: 'GNARLY',
  0x12B: 'TUBULAR',
  0x12C: 'WAY COOL',
  0x12D: 'AWESOME',

  // ── Star World ($12E–$138) ───────────────────────────────────────────────────
  0x12E: 'STAR ROAD',
  0x12F: 'STAR ROAD',
  0x130: 'STAR WORLD 2',
  0x131: 'STAR ROAD',
  0x132: 'STAR WORLD 3',
  0x133: 'STAR ROAD',
  0x134: 'STAR WORLD 1',
  0x135: 'STAR WORLD 4',
  0x136: 'STAR WORLD 5',
  0x137: 'STAR ROAD',
  0x138: 'STAR ROAD',
}

/**
 * Returns the display name for a translevel in the vanilla SMW ROM,
 * or `undefined` if the level has no overworld-visible name.
 */
export function getVanillaLevelName(translevel: number): string | undefined {
  return NAMES[translevel]
}

