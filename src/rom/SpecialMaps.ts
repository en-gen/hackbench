/**
 * The maps the game enters without the overworld: the title screen and the
 * "new game" intro cutscene.
 *
 * Both are ordinary maps in ordinary pointer-table slots, but nothing reaches
 * them through the exit graph, so they would otherwise sit anonymously among
 * the orphans. They are the two most-edited maps in a hack after the levels
 * themselves, and a user should not have to know that the title screen is
 * $0C7 to find it.
 *
 * ── How the slots are found ──────────────────────────────────────────────
 *
 * Neither is in a table. Both are immediate operands baked into game-mode
 * code, loaded into OverworldOverride ($7E:0109, rammap.asm:1036), which holds
 * "translevel number to load in lieu of the overworld". The stored value is
 * offset by the main-map level count (`!MainMapLvls = 36`, constants.asm:155),
 * so the slot is the immediate minus $24:
 *
 *   GM03LoadTitleScreen  LDA #!MainMapLvls+!TitleScreenLevel : LDY #0
 *                        STA OverworldOverride        bank_00.asm:2626
 *   EnterFileSelect      LDA #!MainMapLvls+!IntroCutsceneLevel
 *                        STA OverworldOverride        bank_00.asm:3389
 *
 * Read from the cart rather than hardcoded from those constants, per the
 * project's rule that ASM is reference and never a source to hardcode from.
 * Opcodes are readable bytes, so reading the immediate is interpretation, not
 * assumption.
 *
 * Matched by BYTE PATTERN rather than at a fixed address, because a hack that
 * relocates the routine still contains the same instruction sequence
 * somewhere. That choice is load-bearing: reading the title screen at its
 * vanilla address $00:96CC on Invictus yields $C8, a confident wrong answer,
 * because a JML has replaced the routine there.
 *
 * ── Measured across this repo's six-ROM corpus ───────────────────────────
 *
 * The intro pattern matches exactly once on all six ROMs, at $00:9CB0, always
 * with immediate $E9 giving slot $0C5. The title pattern matches exactly once
 * on four, at $00:96CB with $EB giving $0C7, and is ABSENT on Grand Poo World
 * 2 and Invictus, whose loader is replaced. Absent means unavailable, not
 * vanilla: this reports nothing for the title screen on those carts rather
 * than asserting $0C7.
 *
 * A pattern matching more than once is also treated as unavailable. Two
 * candidate sites means we cannot say which one the game runs, and picking
 * the first would be a guess dressed as a reading.
 */
import { RomFile } from './RomFile'

/** What a special map is FOR, which is what the explorer labels it with. */
export type SpecialRole = 'title-screen' | 'new-game'

export interface SpecialMap {
  index: number
  role: SpecialRole
  /** Where the immediate was read, for a citation the user can check. */
  foundAt: string
}

export interface SpecialMaps {
  maps: SpecialMap[]
  /** Why a role is missing, when one is. Never silent. */
  notes: string[]
}

/**
 * `!MainMapLvls`, the offset between an OverworldOverride value and the slot
 * it names (constants.asm:155). Subtracted, not assumed: it is the only part
 * of this that is not read from the cart, and it is a property of the
 * pointer-table layout rather than of any routine.
 */
const MAIN_MAP_LEVELS = 0x24

/** -1 matches any byte: the immediate operand we are here to read. */
type BytePattern = readonly number[]

/** LDA #imm : LDY #$00 : STA $0109   (bank_00.asm:2626) */
const TITLE_SCREEN: BytePattern = [0xa9, -1, 0xa0, 0x00, 0x8d, 0x09, 0x01]

/** LDA #imm : STA $0109             (bank_00.asm:3389) */
const NEW_GAME: BytePattern = [0xa9, -1, 0x8d, 0x09, 0x01]

interface Match {
  offset: number
  immediate: number
}

function findAll(cart: Uint8Array, pattern: BytePattern, limit = 4): Match[] {
  const out: Match[] = []
  const last = cart.length - pattern.length
  for (let i = 0; i <= last; i++) {
    let ok = true
    for (let k = 0; k < pattern.length; k++) {
      if (pattern[k] !== -1 && cart[i + k] !== pattern[k]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    out.push({ offset: i, immediate: cart[i + 1]! })
    // Uniqueness is the whole test; counting past a couple is wasted work.
    if (out.length >= limit) break
  }
  return out
}

/** LoROM file offset back to the SNES address it was read from, for citation. */
function snesAddress(offset: number): string {
  const bank = offset >> 15
  const addr = (offset & 0x7fff) | 0x8000
  return `$${bank.toString(16).padStart(2, '0').toUpperCase()}:${addr.toString(16).toUpperCase()}`
}

export function findSpecialMaps(rom: RomFile): SpecialMaps {
  // The cart without any copier header, so offsets match SNES banks.
  const whole = rom.buffer
  const cart = rom.hasHeader ? whole.subarray(whole.length - rom.romSize) : whole

  const maps: SpecialMap[] = []
  const notes: string[] = []

  const roles: Array<{ role: SpecialRole; label: string; pattern: BytePattern }> = [
    { role: 'title-screen', label: 'Title screen', pattern: TITLE_SCREEN },
    { role: 'new-game', label: 'New game', pattern: NEW_GAME },
  ]

  for (const { role, label, pattern } of roles) {
    const hits = findAll(cart, pattern)

    if (hits.length === 0) {
      notes.push(
        `${label}: the routine that loads it is not present in this ROM, so its map ` +
          'cannot be identified. It is still listed among the unassigned maps.',
      )
      continue
    }
    if (hits.length > 1) {
      // Picking the first would be a guess dressed as a reading.
      notes.push(
        `${label}: ${hits.length} candidate load sites found, so which one the game ` +
          'runs cannot be determined. It is still listed among the unassigned maps.',
      )
      continue
    }

    const index = hits[0]!.immediate - MAIN_MAP_LEVELS
    if (index < 0 || index > 0x1ff) {
      notes.push(
        `${label}: the load site reads an out-of-range slot ` +
          `(${hits[0]!.immediate} - ${MAIN_MAP_LEVELS}), so it is not reported.`,
      )
      continue
    }

    maps.push({ index, role, foundAt: snesAddress(hits[0]!.offset) })
  }

  return { maps, notes }
}
