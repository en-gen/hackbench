/**
 * BlockContents.ts - what an item block holds, from its acts-like Map16
 * number ($111-$12D, and $021-$024 when hit from below) and map X column. Pure: no shell imports. Tables are
 * read from the ROM by `readBlockContentTables` and passed in, so tests feed
 * synthetic bytes. Derivation and the resolved table: docs/rom/block-contents.md.
 *
 * Selector byte decoding (content = byte >> 1, progressive = byte & 1, bit 7 =
 * column lookup) is traced to SMWDisX lines in the doc and at each branch below.
 * Special cases are keyed on the SPAWNED SPRITE, as the ROM does, not on the tile.
 */

import { findExactlyOneSite, WILD, type BytePattern } from './BytePattern'
import type { RomFile } from './RomFile'
import { hiromToOffset, loromToOffset } from './addressing'

export const FIRST_ITEM_BLOCK = 0x111
export const LAST_ITEM_BLOCK = 0x12d
/**
 * Page-0 tiles $021-$024 reach the same code while Mario moves up with his head point
 * in the tile (PlayerYSpeed+1 negative; the point CODE_00F44D just loaded at the
 * EC8A call is the head one, bank_00.asm:12194-12212, offsets bank_00.asm:11686-11699):
 * selector index = tile - 4, so $1D-$20.
 */
export const FIRST_UPWARD_TILE = 0x21
export const LAST_UPWARD_TILE = 0x24

/** Sprites the spawn code treats specially (bank_02.asm:1199, 1228, 1230). */
const SPRITE_PSWITCH = 0x3e
const SPRITE_YOSHI_EGG = 0x2c
const SPRITE_BALLOON = 0x7d
const SPRITE_DIRECT_COINS = 0x45 // bank_02.asm:1162-1168

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
const nameOf = (sprite: number): string =>
  SPRITE_NAMES[sprite] ?? `Sprite $${sprite.toString(16).padStart(2, '0')}`

/** ROM tables the resolver reads (SNES addresses from SMW_U.sym). */
export interface BlockContentTables {
  readonly selector: Uint8Array // DATA_00F080
  readonly columnCycle: Uint8Array // DATA_00F100
  /** DATA_00F0A4: which hit directions open each index (bit 3 head bump, 0-1 sides, 2 above). */
  readonly gate: Uint8Array
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
  /** Why `greenStarCoins` is null (site missing or ambiguous), from findExactlyOneSite. */
  readonly greenStarCoinsReason?: string
}

const SPRITE_SPAN = 0xa0 // id up to $7F, plus $11 when Yoshi is loose
const STATUS_SPAN = 0x80

/** The loader's refusal: a required table could not be read, so nothing is resolved. */
export interface TablesUnavailable {
  readonly kind: 'unavailable'
  readonly unavailable: string
}

/** True for the refusal, from the loader or from the resolver (which passes it through). */
export function isUnavailable(
  x: BlockContentTables | BlockContents | TablesUnavailable | null,
): x is TablesUnavailable {
  return x !== null && (x as { kind?: string }).kind === 'unavailable'
}

class ShortTable extends Error {}

/** One table byte; an index past a hand-built table's end refuses instead of defaulting. */
function at(table: Uint8Array, i: number, name: string): number {
  if (i >= table.length)
    throw new ShortTable(`${name}[${i}] is past the end of a ${table.length}-byte table`)
  return table[i]
}

/** A table's bytes, or null when any of them lies past the end of the ROM (no zero fill). */
function slice(rom: RomFile, addr: number, len: number): Uint8Array | null {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    const b = rom.readByte(addr + i)
    if (b === null) return null
    out[i] = b
  }
  return out
}

/** BNE / LDA #imm / STA GreenStarBlockCoins ($0DC0), bank_00.asm:1979-1981; the lone STA alone matches twice. */
function readGreenStarCoins(rom: RomFile): { value: number | null; reason?: string } {
  const what = 'the green star counter reset (bank_00.asm:1979-1981)'
  const site = findExactlyOneSite(rom, [0xd0, 0x05, 0xa9, WILD, 0x8d, 0xc0, 0x0d], what)
  if (!site.ok) return { value: null, reason: site.reason }
  const value = rom.readAtFileOffset(site.offset + 3, 1)?.[0] ?? null
  return value === null
    ? { value, reason: `${what} operand is past the end of this ROM` }
    : { value }
}

const GATE_LABEL = 'DATA_00F0A4'
const GATE_LENGTH = 36
// TYX / LDA.L DATA_00F0EC,X / PLX / AND.L DATA_00F0A4,X / BEQ (bank_00.asm:12849-12853). Without the
// TYX, hack 19720 has an unrelated TAX / LDA.L / PLX / AND.L / BEQ that makes the site ambiguous.
// prettier-ignore
const GATE_READER: BytePattern = [0xbb, 0xbf, WILD, WILD, WILD, 0xfa, 0x3f, WILD, WILD, WILD, 0xf0, WILD]
const GATE_OPERAND_AT = 7

/** DATA_00F0A4 from the operand of the AND.L that reads it, or why that read is not on this ROM. */
function readGate(rom: RomFile): { bytes: Uint8Array } | { reason: string } {
  const what = `the reader of ${GATE_LABEL} (bank_00.asm:12850-12853)`
  const site = findExactlyOneSite(rom, GATE_READER, what)
  if (!site.ok) return { reason: `${GATE_LABEL}: ${site.reason}` }
  const op = rom.readAtFileOffset(site.offset + GATE_OPERAND_AT, 3)!
  const operand = op[0]! | (op[1]! << 8) | (op[2]! << 16)
  // Per byte, like the fixed tables: AND long,X carries into the bank, so a table that crosses a
  // bank end does not continue in the next ROM bank.
  const bytes = slice(rom, operand, GATE_LENGTH)
  if (bytes) return { bytes }
  const hex = (n: number): string => `$${n.toString(16).toUpperCase().padStart(6, '0')}`
  const first = Array.from({ length: GATE_LENGTH }, (_, i) => operand + i).find(
    a => rom.readByte(a) === null,
  )!
  const mapped =
    rom.mapMode === 'hirom' ? hiromToOffset(first) : loromToOffset(first, Number.MAX_SAFE_INTEGER)
  const why = mapped === null ? `${hex(first)} is not ROM` : `runs past the end of this ROM`
  return { reason: `${GATE_LABEL} (${GATE_LENGTH} bytes at ${hex(operand)}): ${why}` }
}

const TABLE_SPECS = [
  ['selector', 'DATA_00F080', 0x00f080, 36],
  ['columnCycle', 'DATA_00F100', 0x00f100, 32],
  ['spriteInBlock', 'SpriteInBlock', 0x0288a3, SPRITE_SPAN],
  ['statusOfSprInBlk', 'StatusOfSprInBlk', 0x0288c5, STATUS_SPAN],
  ['columnOverride', 'DATA_0288D6', 0x0288d6, 4],
  ['columnOverrideStatus', 'DATA_0288D9', 0x0288d9, 4],
  ['pSwitchAttribute', 'DATA_028A42', 0x028a42, 2],
  ['eggContents', 'DATA_0288A1', 0x0288a1, 2],
] as const

/** Read every table, or refuse naming the first one that runs past the end of the ROM. */
export function readBlockContentTables(rom: RomFile): BlockContentTables | TablesUnavailable {
  const got: Record<string, Uint8Array> = {}
  for (const [key, label, addr, len] of TABLE_SPECS) {
    const bytes = slice(rom, addr, len)
    if (!bytes) {
      const at = `$${addr.toString(16).toUpperCase().padStart(6, '0')}`
      return {
        kind: 'unavailable',
        unavailable: `${label} (${len} bytes at ${at}) runs past the end of this ROM`,
      }
    }
    got[key] = bytes
  }
  const gate = readGate(rom) // after the fixed tables, so a short ROM still names the first one cut off
  if (!('bytes' in gate)) return { kind: 'unavailable', unavailable: gate.reason }
  got.gate = gate.bytes
  const counter = readGreenStarCoins(rom)
  return {
    ...(got as unknown as Omit<BlockContentTables, 'greenStarCoins'>),
    greenStarCoins: counter.value,
    ...(counter.reason ? { greenStarCoinsReason: counter.reason } : {}),
  }
}

export type BlockContent =
  | {
      kind: 'sprite'
      sprite: number
      /** The SpriteInBlock index the spawn is entered with (`_5`, bank_02.asm:1098): the item's content id. */
      index: number
      status: number
      label: string
      /** OBJ attribute byte for the P-switch colour (DATA_028A42). */
      attribute?: number
      /** Position in the spawn code's own X-column cycle, e.g. "X column 2 of 4". */
      position?: string
      caveat?: string
    }
  | { kind: 'none'; label: string } // an empty branch of a conditional outcome
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
  if (id === 0) return null // bank_02.asm:1053-1054: content id 0 returns before any spawn
  let sprite = at(t.spriteInBlock, id + (c.loose ? 0x11 : 0), 'SpriteInBlock')
  let status = at(t.statusOfSprInBlk, id, 'StatusOfSprInBlk')
  let position: string | undefined
  let caveat: string | undefined
  let attribute: number | undefined
  let rewritten = false
  const layer2 = 'on layer 2 the item depends on scroll position'
  if (sprite === SPRITE_BALLOON) {
    // bank_02.asm:1199-1212: the spawned balloon is rewritten by X column.
    const i = col & 3
    sprite = at(t.columnOverride, i, 'DATA_0288D6')
    status = at(t.columnOverrideStatus, i, 'DATA_0288D9')
    rewritten = true
    position = `X column ${i + 1} of 4`
    const hex = status.toString(16).toUpperCase()
    caveat =
      i === 3 ? `reads past DATA_0288D6; spawn status $${hex} has no handler; ${layer2}` : layer2
  }
  // Status 0 is no sprite: HandleSprite erases it (bank_01.asm:182-183), and the spawn
  // writes the table status as is (bank_02.asm:1141-1142), after the rewrite's if any.
  if (status === 0) return null
  // A zero sprite byte with a live status is sprite $00, which the ROM spawns (bank_02.asm:1150-1151).
  let label = nameOf(sprite)
  // The $45 check (bank_02.asm:1162-1164) runs while SpriteNumber is still the table's
  // sprite, before the balloon rewrite (:1199-1212), so a rewrite to $45 never gets it.
  if (sprite === SPRITE_DIRECT_COINS && !rewritten) {
    // DirectCoinInit set: the spawn is erased and the coin path runs (bank_02.asm:1162-1168).
    label += ' (a coin instead, if a directional-coin run already started in this level)'
  }
  // After the rewrite the ROM branches past the P-switch and egg checks (bank_02.asm:1215-1223).
  if (sprite === SPRITE_PSWITCH && !rewritten) {
    // CODE_028A2A (bank_02.asm:1280-1295): colour by column parity.
    attribute = at(t.pSwitchAttribute, col & 1, 'DATA_028A42')
    const colour = PSWITCH_COLOURS[attribute ?? -1]
    if (colour) label += ` (${colour})`
    caveat = layer2
  }
  if (sprite === SPRITE_YOSHI_EGG && !rewritten) {
    // bank_02.asm:1232-1251, DATA_0288A1.
    const [alone, withYoshi] = [
      at(t.eggContents, 0, 'DATA_0288A1'),
      at(t.eggContents, 1, 'DATA_0288A1'),
    ].map(nameOf)
    label += ` (${alone}, or ${withYoshi} if a baby Yoshi exists or Yoshi is loose)`
  }
  return { kind: 'sprite', sprite, index: id, status, label, attribute, position, caveat }
}

/** Drop empty contents; the last alternative is the unconditional one. */
function chain(pairs: [string | null, BlockContent | null][]): ContentAlternative[] {
  const alts = pairs.flatMap(([when, content]) => (content ? [{ when, content }] : []))
  if (alts.length) alts[alts.length - 1] = { when: null, content: alts[alts.length - 1].content }
  return alts
}

const EMPTY: BlockContent = { kind: 'none', label: 'nothing' }

/** CODE_00F1BA (bank_00.asm:12877-12891): one selector value to alternatives. */
function decode(value: number, c: Ctx): ContentAlternative[] {
  const id = value >> 1
  const item = contentFor(id, c)
  if ((value & 1) === 0) return item ? chain([[null, item]]) : []
  if (id === CONTENT_STAR) {
    // Star only while InvinsibilityTimer is nonzero, else coin (bank_00.asm:12887-12891).
    // ASM reading, not yet confirmed in an emulator.
    return chain([
      ['Mario is invincible', item ?? EMPTY],
      [null, contentFor(CONTENT_COIN, c)],
    ])
  }
  // Mushroom unless Powerup is nonzero (bank_00.asm:12882-12885). An empty entry (content
  // id 0 or spawn status 0) stays an empty branch under its condition.
  const mushroom = contentFor(1, c)
  if (!item && !mushroom) return []
  return chain([
    ['Mario is small', mushroom ?? EMPTY],
    [null, item ?? EMPTY],
  ])
}

function describe(alts: readonly ContentAlternative[]): string {
  if (alts.length === 0) return 'Nothing'
  const text = alts
    .map((a, i) => {
      const last = i === alts.length - 1 && i > 0
      return (last ? 'otherwise ' : '') + a.content.label + (a.when ? ` if ${a.when}` : '')
    })
    .join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Normal answer, then the Yoshi-loose one in a parenthetical when the second copy differs. */
function describeAll(
  normal: readonly ContentAlternative[],
  loose: readonly ContentAlternative[] | null,
  position: string | undefined,
): string {
  const head = describe(normal) + (position ? ` (${position})` : '')
  if (!loose) return head
  const inner = describe(loose)
  return `${head} (${inner === 'Nothing' ? 'nothing' : inner} if Yoshi is loose)`
}

function altsFor(
  raw: number,
  c: Ctx,
): { alts: ContentAlternative[]; position?: string; caveat?: string } {
  const { t, col } = c
  if (raw === 0xff) {
    // Green star block: coin until GreenStarBlockCoins reaches zero, then 1-up
    // (bank_00.asm:12863-12866; the counter starts at the immediate at :1980; a start of 0 gives the 1-up at once).
    const n = t.greenStarCoins
    const when =
      n === null
        ? "this block's coin countdown is above zero"
        : `fewer than ${n} coins are collected`
    const oneUp = contentFor(CONTENT_ONE_UP, c)
    return {
      alts:
        n === 0
          ? oneUp
            ? chain([[null, oneUp]])
            : []
          : chain([
              [when, contentFor(CONTENT_COIN, c)],
              [null, oneUp ?? EMPTY],
            ]),
      caveat:
        n === null ? (t.greenStarCoinsReason ?? 'the green star counter was not read') : undefined,
    }
  }
  if (raw >= 0x80) {
    // Bit 7: DATA_00F100[(raw & 1) * 16 + (col & 15)] (bank_00.asm:12868-12876).
    const base = (raw & 1) * 16
    at(t.columnCycle, base + 15, 'DATA_00F100')
    const p = cyclePeriod(t.columnCycle.subarray(base, base + 16))
    return {
      alts: decode(at(t.columnCycle, base + (col & 15), 'DATA_00F100'), c),
      position: p > 1 && p < 16 ? `X column ${((col & 15) % p) + 1} of ${p}` : undefined,
    }
  }
  return { alts: decode(raw, c) }
}

/** Resolve the contents of the block with acts-like `actsLike` at map column `col`. */
export function resolveBlockContents(
  actsLike: number,
  col: number,
  t: BlockContentTables | TablesUnavailable,
): BlockContents | TablesUnavailable | null {
  if (isUnavailable(t)) return t
  const upward = actsLike >= FIRST_UPWARD_TILE && actsLike <= LAST_UPWARD_TILE
  if (!upward && (actsLike < FIRST_ITEM_BLOCK || actsLike > LAST_ITEM_BLOCK)) return null
  try {
    return resolveWith(actsLike, col, t, upward)
  } catch (e) {
    if (e instanceof ShortTable) return { kind: 'unavailable', unavailable: e.message }
    throw e
  }
}

/**
 * The trigger text for a gate mask (low nibble), null when nothing opens it. DATA_00F0EC[Y]
 * is $08, $01, $02, $04 for Y = 0-3 (bank_00.asm:12773): head bump, the two sides, above.
 * Bit 3 set needs no text. Which physical side Y = 1 and 2 are (DATA_00E90A[PlayerBlockXSide],
 * bank_00.asm:11703-11704, :12061-12067) is not established, so one bit reads "one side".
 */
function gateText(mask: number): string | null {
  if (mask & 0x08) return ''
  const side = (mask & 0x03) === 0x03 ? 'the side' : mask & 0x03 ? 'one side' : ''
  const parts = [side, mask & 0x04 ? 'above' : ''].filter(Boolean)
  return parts.length ? ` (only when hit from ${parts.join(' or ')})` : null
}

function resolveWith(
  actsLike: number,
  col: number,
  t: BlockContentTables,
  upward: boolean,
): BlockContents {
  const index = upward ? actsLike - 4 : actsLike - FIRST_ITEM_BLOCK
  const raw = at(t.selector, index, 'DATA_00F080')
  // The gate (bank_00.asm:12850-12853): which hit directions open this index. Head bump
  // is Y=0 (mask $08), sides Y=1,2 ($03), above Y=3 ($04); the upward tiles are a head bump.
  const mask = at(t.gate, index, 'DATA_00F0A4') & 0x0f // bits 4-7 never match: Y is 0-3
  const trigger = upward ? ' (only when hit from below)' : gateText(mask)
  const opens = upward ? (mask & 0x08) !== 0 : trigger !== null
  const normal = altsFor(raw, { t, col, loose: false })
  if (!opens) Object.assign(normal, { alts: [], position: undefined, caveat: undefined })
  let alts = normal.alts
  // Vanilla's second copy is identical, so this adds nothing there (bank_02.asm:1143-1151).
  const looseAlts = opens ? altsFor(raw, { t, col, loose: true }).alts : []
  const differs = JSON.stringify(looseAlts) !== JSON.stringify(alts)
  const loose = differs ? looseAlts : null
  if (loose) {
    const tag = (w: string | null): string => ['Yoshi is loose', w].filter(Boolean).join(' and ')
    alts = [...looseAlts.map(a => ({ ...a, when: tag(a.when) })), ...alts]
  }

  const contents = alts.map(a => a.content)
  const sprites = contents.flatMap(x => (x.kind === 'sprite' ? [x] : []))
  const normalSprites = normal.alts.flatMap(a => (a.content.kind === 'sprite' ? [a.content] : []))
  const position = normal.position ?? sprites.find(x => x.position)?.position
  const condition =
    describeAll(normal.alts, loose, position) + (alts.length && trigger ? trigger : '')
  const caveats = [
    ...new Set([
      ...sprites.flatMap(x => (x.caveat ? [x.caveat] : [])),
      ...(normal.caveat ? [normal.caveat] : []),
    ]),
  ]
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
    spriteIds: [...new Set([...normalSprites, ...sprites].map(x => x.sprite))],
    progressive,
    multiCoin: contents.some(x => x.kind === 'multiCoin'),
    condition,
    ...(caveats.length ? { caveat: caveats.join('; ') } : {}),
  }
}
