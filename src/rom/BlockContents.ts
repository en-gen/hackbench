/**
 * BlockContents.ts - what an item block holds, from its acts-like Map16
 * number ($111-$12D) and map X column. Pure: no shell imports. Tables are
 * read from the ROM by `readBlockContentTables` and passed in, so tests feed
 * synthetic bytes. Derivation and the resolved table: docs/rom/block-contents.md.
 *
 * Selector byte decoding (content = byte >> 1, progressive = byte & 1, bit 7 =
 * column lookup) is traced to SMWDisX lines in the doc and at each branch below.
 */

import type { RomFile } from './RomFile'

export const FIRST_ITEM_BLOCK = 0x111
export const LAST_ITEM_BLOCK = 0x12d

/** DATA_00F080 has 36 entries; only the first 29 are reachable from $111-$12D. */
const SELECTOR_LEN = 36
const COLUMN_CYCLE_LEN = 32
const SPRITE_TABLE_LEN = 17

/** Sprite ids named by the game's SpriteInBlock table. */
export const SPRITE_NAMES: Readonly<Record<number, string>> = {
  0x04: 'Green Koopa shell',
  0x09: 'Green bouncing Koopa',
  0x2c: 'Yoshi egg',
  0x3e: 'P-switch',
  0x45: 'Directional coins',
  0x74: 'Mushroom',
  0x75: 'Fire Flower',
  0x76: 'Star',
  0x77: 'Feather',
  0x78: '1-up',
  0x79: 'Vine',
  0x7d: 'Balloon',
  0x7e: 'Flying red coin',
  0x80: 'Key',
}

/** ROM tables the resolver reads (SNES addresses from SMW_U.sym). */
export interface BlockContentTables {
  readonly selector: Uint8Array // DATA_00F080
  readonly columnCycle: Uint8Array // DATA_00F100
  readonly spriteInBlock: Uint8Array // SpriteInBlock, $0288A3
  readonly statusOfSprInBlk: Uint8Array // StatusOfSprInBlk, $0288C5
  /** DATA_0288D6[0..3]: index 3 reads past the table into DATA_0288D9. */
  readonly columnOverride: Uint8Array
  /** DATA_0288D9[0..3]: index 3 reads past the table into code (status $A4). */
  readonly columnOverrideStatus: Uint8Array
}

function slice(rom: RomFile, addr: number, len: number): Uint8Array {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = rom.readByte(addr + i) ?? 0
  return out
}

export function readBlockContentTables(rom: RomFile): BlockContentTables {
  return {
    selector: slice(rom, 0x00f080, SELECTOR_LEN),
    columnCycle: slice(rom, 0x00f100, COLUMN_CYCLE_LEN),
    spriteInBlock: slice(rom, 0x0288a3, SPRITE_TABLE_LEN),
    statusOfSprInBlk: slice(rom, 0x0288c5, SPRITE_TABLE_LEN),
    columnOverride: slice(rom, 0x0288d6, 4),
    columnOverrideStatus: slice(rom, 0x0288d9, 4),
  }
}

export type BlockContent =
  | { kind: 'sprite'; sprite: number; status: number; label: string }
  | { kind: 'coin'; label: string }
  | { kind: 'multiCoin'; label: string }

export interface ContentAlternative {
  /** Plain-words condition under which this content is given; null = otherwise/always. */
  readonly when: string | null
  readonly content: BlockContent
}

export interface BlockContents {
  /** Empty for a block with no item. The first alternative is the default. */
  readonly alternatives: readonly ContentAlternative[]
  /** Distinct sprite ids across alternatives, for the sprite table engine. */
  readonly spriteIds: readonly number[]
  /** Mushroom-then-item pair when the item depends on Mario's size. */
  readonly progressive: { readonly small: number; readonly big: number } | null
  readonly multiCoin: boolean
  /** One line for the Properties "Contains" row. */
  readonly condition: string
  readonly caveat?: string
}

/**
 * Position inside the X-column cycle: $111 and $11A cycle every 3 columns
 * (DATA_00F100 index = X pixel bits 7-4, bank_00.asm:12868-12876); $125
 * every 4 (bank_02.asm:1202-1208). Pixel-X bits 7-4 wrap every 16 columns.
 */
export function cycleColumn(actsLike: number, col: number): { index: number; of: number } | null {
  if (actsLike === 0x111 || actsLike === 0x11a) return { index: (col & 15) % 3, of: 3 }
  if (actsLike === 0x125) return { index: col & 3, of: 4 }
  return null
}

const CONTENT_COIN = 6
const CONTENT_MULTICOIN = 7
const CONTENT_COLUMN_OVERRIDE = 0x0b
const CONTENT_STAR = 3
const CONTENT_ONE_UP = 5

function contentFor(id: number, t: BlockContentTables, override?: number): BlockContent | null {
  if (id === CONTENT_COIN) return { kind: 'coin', label: 'Coin' }
  if (id === CONTENT_MULTICOIN) return { kind: 'multiCoin', label: 'Multiple coins' }
  const sprite = override ?? t.spriteInBlock[id] ?? 0
  if (sprite === 0) return null
  const status = override === undefined ? (t.statusOfSprInBlk[id] ?? 8) : 8
  const label = SPRITE_NAMES[sprite] ?? `Sprite $${sprite.toString(16)}`
  return { kind: 'sprite', sprite, status, label }
}

/** CODE_00F1BA (bank_00.asm:12877-12891): one selector value to alternatives. */
function decode(value: number, t: BlockContentTables): ContentAlternative[] {
  const id = value >> 1
  const item = contentFor(id, t)
  if (!item) return []
  if ((value & 1) === 0) return [{ when: null, content: item }]
  if (id === CONTENT_STAR) {
    // Star only while InvinsibilityTimer is nonzero, else coin (bank_00.asm:12887-12891).
    // ASM reading, not yet confirmed in an emulator.
    return [
      { when: 'Mario is invincible', content: item },
      { when: null, content: contentFor(CONTENT_COIN, t) as BlockContent },
    ]
  }
  // Mushroom unless Powerup is nonzero (bank_00.asm:12882-12885).
  return [
    { when: 'Mario is small', content: contentFor(1, t) as BlockContent },
    { when: null, content: item },
  ]
}

function describe(alts: readonly ContentAlternative[]): string {
  if (alts.length === 0) return 'Nothing'
  if (alts.length === 1) return alts[0].content.label
  return `${alts[0].content.label} if ${alts[0].when}, otherwise ${alts[1].content.label}`
}

/** Resolve the contents of the block with acts-like `actsLike` at map column `col`. */
export function resolveBlockContents(
  actsLike: number,
  col: number,
  t: BlockContentTables,
): BlockContents | null {
  if (actsLike < FIRST_ITEM_BLOCK || actsLike > LAST_ITEM_BLOCK) return null
  const raw = t.selector[actsLike - FIRST_ITEM_BLOCK]
  let alts: ContentAlternative[]
  let caveat: string | undefined

  if (raw === 0xff) {
    // Green star block: coin until GreenStarBlockCoins (30, constants.asm:97)
    // reaches zero, then 1-up (bank_00.asm:12863-12866).
    alts = [
      { when: 'fewer than 30 coins are collected', content: contentFor(CONTENT_COIN, t)! },
      { when: null, content: contentFor(CONTENT_ONE_UP, t)! },
    ]
  } else if (raw >= 0x80) {
    // Bit 7: DATA_00F100[(raw & 1) * 16 + (col & 15)] (bank_00.asm:12868-12876).
    alts = decode(t.columnCycle[(raw & 1) * 16 + (col & 15)], t)
  } else if (raw >> 1 === CONTENT_COLUMN_OVERRIDE) {
    // $125: SpriteInBlock gives $7D, then bank_02.asm:1199-1212 rewrites it by X column.
    const i = col & 3
    const item = contentFor(CONTENT_COLUMN_OVERRIDE, t, t.columnOverride[i])!
    const layer2 = 'on layer 2 the item depends on scroll position'
    if (item.kind === 'sprite') item.status = t.columnOverrideStatus[i]
    if (i === 3) {
      const hex = t.columnOverrideStatus[i].toString(16).toUpperCase()
      caveat = `reads past DATA_0288D6; spawn status $${hex} has no handler; ${layer2}`
    } else caveat = layer2
    alts = [{ when: null, content: item }]
  } else {
    alts = decode(raw, t)
  }

  const cyc = cycleColumn(actsLike, col)
  const condition = describe(alts) + (cyc ? ` (X column ${cyc.index + 1} of ${cyc.of})` : '')
  const spriteIds = [
    ...new Set(alts.flatMap(a => (a.content.kind === 'sprite' ? [a.content.sprite] : []))),
  ]
  const [small, big] = alts.map(a => a.content)
  const progressive =
    alts.length === 2 &&
    alts[0].when === 'Mario is small' &&
    small.kind === 'sprite' &&
    big.kind === 'sprite'
      ? { small: small.sprite, big: big.sprite }
      : null
  return {
    alternatives: alts,
    spriteIds,
    progressive,
    multiCoin: alts.some(a => a.content.kind === 'multiCoin'),
    condition,
    ...(caveat ? { caveat } : {}),
  }
}
