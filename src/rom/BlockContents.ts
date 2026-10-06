/**
 * BlockContents.ts - what an item block holds, from its acts-like Map16
 * number ($111-$12D) and map X column. Pure: no shell imports. Tables are
 * read from the ROM by `readBlockContentTables` and passed in, so tests feed
 * synthetic bytes. Derivation and the resolved table: docs/rom/block-contents.md.
 *
 * Selector byte decoding (content = byte >> 1, progressive = byte & 1, bit 7 =
 * column lookup) is traced to SMWDisX lines in the doc and at each branch below.
 * Special cases are keyed on the SPAWNED SPRITE, as the ROM does, not on the tile.
 */

import { findUnique, WILD } from './BytePattern'
import type { RomFile } from './RomFile'

export const FIRST_ITEM_BLOCK = 0x111
export const LAST_ITEM_BLOCK = 0x12d

/** Sprites the spawn code treats specially (bank_02.asm:1199, 1228, 1230). */
const SPRITE_PSWITCH = 0x3e
const SPRITE_YOSHI_EGG = 0x2c
const SPRITE_BALLOON = 0x7d

/** Colours for the two vanilla DATA_028A42 attribute values. */
export const PSWITCH_COLOURS: Readonly<Record<number, string>> = { 0x06: 'blue', 0x02: 'silver' }

/** Sprite ids named by the game's SpriteInBlock table. */
export const SPRITE_NAMES: Readonly<Record<number, string>> = {
  0x04: 'Green Koopa shell',
  0x09: 'Green bouncing Koopa',
  0x2c: 'Yoshi egg',
  0x35: 'Yoshi',
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
const nameOf = (sprite: number): string => SPRITE_NAMES[sprite] ?? `Sprite $${sprite.toString(16)}`

/** ROM tables the resolver reads (SNES addresses from SMW_U.sym). */
export interface BlockContentTables {
  readonly selector: Uint8Array // DATA_00F080
  readonly columnCycle: Uint8Array // DATA_00F100
  /**
   * SpriteInBlock, $0288A3, read contiguously like the ROM: the second copy
   * (used when Yoshi is loose) starts 17 bytes in, and an id past the table
   * reads whatever follows (bank_02.asm:1077-1089).
   */
  readonly spriteInBlock: Uint8Array
  readonly statusOfSprInBlk: Uint8Array // StatusOfSprInBlk, $0288C5
  /** DATA_0288D6[0..3]: index 3 reads past the table into DATA_0288D9. */
  readonly columnOverride: Uint8Array
  /** DATA_0288D9[0..3]: index 3 reads past the table into code (status $A4). */
  readonly columnOverrideStatus: Uint8Array
  readonly pSwitchAttribute: Uint8Array // DATA_028A42[0..1]
  readonly eggContents: Uint8Array // DATA_0288A1[0..1]: [no Yoshi out, Yoshi out]
  /** Immediate of the green star counter reset (bank_00.asm:1980); null if not found. */
  readonly greenStarCoins: number | null
}

const SPRITE_SPAN = 0xa0 // id up to $7F, plus $11 when Yoshi is loose
const STATUS_SPAN = 0x80

function slice(rom: RomFile, addr: number, len: number): Uint8Array {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = rom.readByte(addr + i) ?? 0
  return out
}

/** BNE / LDA #imm / STA GreenStarBlockCoins ($0DC0), bank_00.asm:1979-1981; the lone STA alone matches twice. */
function readGreenStarCoins(rom: RomFile): number | null {
  const at = findUnique(rom, [0xd0, 0x05, 0xa9, WILD, 0x8d, 0xc0, 0x0d])
  return at === null ? null : (rom.readAtFileOffset(at + 3, 1)?.[0] ?? null)
}

export function readBlockContentTables(rom: RomFile): BlockContentTables {
  return {
    selector: slice(rom, 0x00f080, 36),
    columnCycle: slice(rom, 0x00f100, 32),
    spriteInBlock: slice(rom, 0x0288a3, SPRITE_SPAN),
    statusOfSprInBlk: slice(rom, 0x0288c5, STATUS_SPAN),
    columnOverride: slice(rom, 0x0288d6, 4),
    columnOverrideStatus: slice(rom, 0x0288d9, 4),
    pSwitchAttribute: slice(rom, 0x028a42, 2),
    eggContents: slice(rom, 0x0288a1, 2),
    greenStarCoins: readGreenStarCoins(rom),
  }
}

export type BlockContent =
  | {
      kind: 'sprite'
      sprite: number
      status: number
      label: string
      /** OBJ attribute byte for the P-switch colour (DATA_028A42). */
      attribute?: number
      /** Position in the spawn code's own X-column cycle, e.g. "X column 2 of 4". */
      position?: string
      caveat?: string
    }
  | { kind: 'coin'; label: string }
  | { kind: 'multiCoin'; label: string }

export interface ContentAlternative {
  /** Plain-words condition under which this content is given; null = otherwise/always. */
  readonly when: string | null
  readonly content: BlockContent
}

export interface BlockContents {
  /** Empty for a block with no item. */
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
 * Vanilla position inside the X-column cycle, for the two tile behaviours
 * that PR B replaces. The resolver itself reads the cycle from the ROM tables.
 */
export function cycleColumn(actsLike: number, col: number): { index: number; of: number } | null {
  if (actsLike === 0x111 || actsLike === 0x11a) return { index: (col & 15) % 3, of: 3 }
  if (actsLike === 0x125) return { index: col & 3, of: 4 }
  return null
}

/** Smallest period of one 16-entry half of DATA_00F100 (16 = no repetition). */
function cyclePeriod(half: ArrayLike<number>): number {
  for (let p = 1; p < 16; p++) {
    let ok = true
    for (let i = 0; i < 16; i++) if (half[i] !== half[i % p]) ok = false
    if (ok) return p
  }
  return 16
}

const CONTENT_COIN = 6
const CONTENT_MULTICOIN = 7
const CONTENT_STAR = 3
const CONTENT_ONE_UP = 5

interface Ctx {
  readonly t: BlockContentTables
  readonly col: number
  /** Read the second SpriteInBlock copy, as the ROM does when YoshiIsLoose. */
  readonly loose: boolean
}

function contentFor(id: number, c: Ctx): BlockContent | null {
  if (id === CONTENT_COIN) return { kind: 'coin', label: 'Coin' }
  if (id === CONTENT_MULTICOIN) return { kind: 'multiCoin', label: 'Multiple coins' }
  const { t, col } = c
  let sprite = t.spriteInBlock[id + (c.loose ? 0x11 : 0)] ?? 0
  let status = t.statusOfSprInBlk[id] ?? 8
  let position: string | undefined
  let caveat: string | undefined
  let attribute: number | undefined
  const layer2 = 'on layer 2 the item depends on scroll position'
  if (sprite === SPRITE_BALLOON) {
    // bank_02.asm:1199-1212: the spawned balloon is rewritten by X column.
    const i = col & 3
    sprite = t.columnOverride[i] ?? 0
    status = t.columnOverrideStatus[i] ?? 8
    position = `X column ${i + 1} of 4`
    const hex = status.toString(16).toUpperCase()
    caveat =
      i === 3 ? `reads past DATA_0288D6; spawn status $${hex} has no handler; ${layer2}` : layer2
  }
  if (sprite === 0) return null
  let label = nameOf(sprite)
  if (sprite === SPRITE_PSWITCH) {
    // CODE_028A2A (bank_02.asm:1280-1295): colour by column parity.
    attribute = t.pSwitchAttribute[col & 1]
    const colour = PSWITCH_COLOURS[attribute ?? -1]
    if (colour) label += ` (${colour})`
    caveat = layer2
  }
  if (sprite === SPRITE_YOSHI_EGG) {
    // bank_02.asm:1232-1251, DATA_0288A1.
    const [alone, withYoshi] = [t.eggContents[0], t.eggContents[1]].map(nameOf)
    label += ` (${alone}, or ${withYoshi} if a baby Yoshi exists or Yoshi is loose)`
  }
  return { kind: 'sprite', sprite, status, label, attribute, position, caveat }
}

/** Drop empty contents; the last alternative is the unconditional one. */
function chain(pairs: [string | null, BlockContent | null][]): ContentAlternative[] {
  const alts = pairs.flatMap(([when, content]) => (content ? [{ when, content }] : []))
  if (alts.length) alts[alts.length - 1] = { when: null, content: alts[alts.length - 1].content }
  return alts
}

/** CODE_00F1BA (bank_00.asm:12877-12891): one selector value to alternatives. */
function decode(value: number, c: Ctx): ContentAlternative[] {
  const id = value >> 1
  const item = contentFor(id, c)
  if (!item) return []
  if ((value & 1) === 0) return chain([[null, item]])
  if (id === CONTENT_STAR) {
    // Star only while InvinsibilityTimer is nonzero, else coin (bank_00.asm:12887-12891).
    // ASM reading, not yet confirmed in an emulator.
    return chain([
      ['Mario is invincible', item],
      [null, contentFor(CONTENT_COIN, c)],
    ])
  }
  // Mushroom unless Powerup is nonzero (bank_00.asm:12882-12885).
  return chain([
    ['Mario is small', contentFor(1, c)],
    [null, item],
  ])
}

function describe(alts: readonly ContentAlternative[]): string {
  if (alts.length === 0) return 'Nothing'
  return alts
    .map((a, i) => {
      const last = i === alts.length - 1 && i > 0
      return (last ? 'otherwise ' : '') + a.content.label + (a.when ? ` if ${a.when}` : '')
    })
    .join(', ')
}

function altsFor(raw: number, c: Ctx): { alts: ContentAlternative[]; position?: string } {
  const { t, col } = c
  if (raw === 0xff) {
    // Green star block: coin until GreenStarBlockCoins reaches zero, then 1-up
    // (bank_00.asm:12863-12866; the counter starts at the immediate at :1980; a start of 0 gives the 1-up at once).
    const n = t.greenStarCoins
    const when =
      n === null
        ? "this block's coin countdown is above zero"
        : `fewer than ${n} coins are collected`
    return {
      alts: chain([
        [when, n === 0 ? null : contentFor(CONTENT_COIN, c)],
        [null, contentFor(CONTENT_ONE_UP, c)],
      ]),
    }
  }
  if (raw >= 0x80) {
    // Bit 7: DATA_00F100[(raw & 1) * 16 + (col & 15)] (bank_00.asm:12868-12876).
    const base = (raw & 1) * 16
    const p = cyclePeriod(t.columnCycle.subarray(base, base + 16))
    return {
      alts: decode(t.columnCycle[base + (col & 15)] ?? 0, c),
      position: p > 1 && p < 16 ? `X column ${((col & 15) % p) + 1} of ${p}` : undefined,
    }
  }
  return { alts: decode(raw, c) }
}

/** Resolve the contents of the block with acts-like `actsLike` at map column `col`. */
export function resolveBlockContents(
  actsLike: number,
  col: number,
  t: BlockContentTables,
): BlockContents | null {
  if (actsLike < FIRST_ITEM_BLOCK || actsLike > LAST_ITEM_BLOCK) return null
  const raw = t.selector[actsLike - FIRST_ITEM_BLOCK] ?? 0
  const normal = altsFor(raw, { t, col, loose: false })
  let alts = normal.alts
  // Vanilla's second copy is identical, so this adds nothing there (bank_02.asm:1143-1149).
  const loose = altsFor(raw, { t, col, loose: true }).alts
  if (JSON.stringify(loose) !== JSON.stringify(alts)) {
    const tag = (w: string | null): string => ['Yoshi is loose', w].filter(Boolean).join(' and ')
    alts = [...loose.map(a => ({ ...a, when: tag(a.when) })), ...alts]
  }

  const contents = alts.map(a => a.content)
  const sprites = contents.flatMap(x => (x.kind === 'sprite' ? [x] : []))
  const position = normal.position ?? sprites.find(x => x.position)?.position
  const condition = describe(alts) + (position ? ` (${position})` : '')
  const caveats = [...new Set(sprites.flatMap(x => (x.caveat ? [x.caveat] : [])))]
  const [small, big] = contents
  const progressive =
    alts.length === 2 &&
    alts[0].when === 'Mario is small' &&
    small.kind === 'sprite' &&
    big.kind === 'sprite'
      ? { small: small.sprite, big: big.sprite }
      : null
  return {
    alternatives: alts,
    spriteIds: [...new Set(sprites.map(x => x.sprite))],
    progressive,
    multiCoin: contents.some(x => x.kind === 'multiCoin'),
    condition,
    ...(caveats.length ? { caveat: caveats.join('; ') } : {}),
  }
}
