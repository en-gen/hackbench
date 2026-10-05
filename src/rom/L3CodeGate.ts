/**
 * The layer 3 code the renderer's numbers come from, fingerprinted. Layer 3's
 * Y values, its tilemap pointer read and its tide path live in vanilla code
 * (CODE_009FB8..CODE_00A044, bank_00.asm:4139-4217; CODE_05C40C..CODE_05C493,
 * bank_05.asm:5504-5570), and hacks patch them: on the corpus Grand Poo World 2
 * changes a Y immediate and jumps out at CODE_00A01F, Invictus and the other
 * hacks differ too. A site whose bytes are not the stock ones means the values
 * `l3LoadTimeY` hardcodes may be wrong, so layer 3 is skipped, never guessed.
 * Hashes are SHA-256 of the stock bytes (over the 32-byte pattern threshold);
 * the carts that keep the stock code match, the hacks that change it do not.
 * `JSL CODE_05BC72` (offset 44) may name bank $85, the FastROM mirror, which ten
 * hacks use and which changes nothing: that one byte is read as $05 when it is $85.
 */
import { createHash } from 'crypto'
import { bgr555ToRgba, type RgbaColor } from './GraphicsDecoder'
import { readL3SettingsByte } from './L3Loader'
import { readLayer3Setting } from './ObjectExpander'
import type { RomFile } from './RomFile'

export interface CodeSite {
  addr: number
  length: number
  sha256: string
  /** One byte hashed as `to` when it reads `from`: the JSL's bank, $05 or its FastROM mirror $85. */
  alias?: { at: number; from: number; to: number }
}
export type L3CodeGate = { ok: true } | { ok: false; reason: string }

export const L3_CODE_SITES: readonly CodeSite[] = [
  { addr: 0x009fb8, length: 0x8d, sha256: '992b8ec64e16548160d75f0ef49209f6b71e1d7c31f308b0f6bca49183f06a28', alias: { at: 47, from: 0x85, to: 0x05 } }, // prettier-ignore
  { addr: 0x05c40c, length: 0x88, sha256: '313bdc9336d774d595f35e9a0f42246d2c934a93095cc082c9108dabb5309938' }, // prettier-ignore
]

export const HOOKED_L3_CODE = 'Layer 3 not drawn yet: hooked layer 3 code'

export function readL3CodeGate(
  rom: RomFile,
  sites: readonly CodeSite[] = L3_CODE_SITES,
): L3CodeGate {
  for (const s of sites) {
    const raw = rom.readAt(s.addr, s.length)
    const bytes = raw && Buffer.from(raw)
    if (bytes && s.alias && bytes[s.alias.at] === s.alias.from) bytes[s.alias.at] = s.alias.to
    const hash = bytes && createHash('sha256').update(bytes).digest('hex')
    if (hash !== s.sha256) return { ok: false, reason: HOOKED_L3_CODE }
  }
  return { ok: true }
}

/** BigCrusherColors (bank_00.asm:6223): 4 BGR555 words CODE_00A007 copies to MainPalette+$18. */
const BIG_CRUSHER_COLORS = 0x00b67f

/**
 * The colors a settings byte $80 level gets at CGRAM 12-15 (BG3 palette 3),
 * copied after LoadPalette (CODE_00A007, bank_00.asm:4184-4189; LoadPalette at
 * bank_00.asm:4868-4870), or null for any other level or a failed gate.
 */
export function readCrusherColors(
  rom: RomFile,
  index: number,
  tileset: number,
  gate: L3CodeGate = readL3CodeGate(rom),
): RgbaColor[] | null {
  if (!gate.ok) return null
  const setting = readLayer3Setting(rom, index)
  if (setting === 0 || readL3SettingsByte(rom, tileset, setting) !== 0x80) return null
  const words = rom.readAt(BIG_CRUSHER_COLORS, 8)
  if (!words) return null
  return [0, 1, 2, 3].map(i => bgr555ToRgba(words[i * 2]! | (words[i * 2 + 1]! << 8)))
}

/** `colors` with CGRAM 12-15 replaced by the crusher's four. */
export function withCrusher(
  colors: readonly RgbaColor[],
  crusher: readonly RgbaColor[],
): RgbaColor[] {
  return colors.map((c, i) => (i >= 12 && i < 16 ? crusher[i - 12]! : c))
}
