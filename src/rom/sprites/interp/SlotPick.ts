/**
 * SlotPick.ts -- the slot the level loader gives a sprite, read from the loader's own tables (#1230, D152 / Decision 103 E).
 * The rope's length is the ROM's branch on the slot it runs in (bank_01.asm:12583-12589); this module only answers WHICH
 * slot, by walking the loader's free-slot search (bank_02.asm:5376-5405) over the tables that search reads. The tile
 * count is never computed here: the caller runs the draw in each slot and the ROM decides.
 */
import { fingerprint } from '../../Fingerprint'
import type { RomFile } from '../../RomFile'
import { bytesAt } from './Guards'
import type { CodeFingerprint } from './InitLatches'

/**
 * The loader from its two offset tables to the end of the pick, $02A7F6-$02A921 (bank_02.asm:5217-5405): 300 contiguous
 * bytes in ONE SHA-256, so the `$00` the parity reads (the store at 5245), the column compare, the branch chain into the
 * pick and the pick itself (`LDY SpriteMemorySetting` at 5376 to the status test's `BNE` at 5405) are all held. Nothing is
 * masked or normalized. Counted against the working tree at this commit (1533 tracked text files, any 5-byte window that
 * appears as hex): at most 12 bytes are stated elsewhere, so at least 288 are unknown, past D126's 24 (vanilla US cart,
 * one machine). The table operands sit inside the span, so a relocated table fails the digest and the sprite keeps slot 0.
 */
export const LOADER_PICK: CodeFingerprint = { at: 0x02a7f6, length: 300, sha256: '88da23f6edb937ba9a94a2fc7e800c82370dd7c8385a5a2dfe6931d98e936e8c' } // prettier-ignore

/** Where the pick starts inside the span ($02A8E4 less $02A7F6). */
const PICK = 238

/** Where each table operand and immediate sits in the pick (instruction offsets of the listing at bank_02.asm:5376-5405). */
const AT = { max: 4, start: 7, res1: 14, max1: 19, start1: 22, res2: 29, special: 34, mask: 40, max2: 44, stop: 47 } as const // prettier-ignore

/** The slots a Machine can run (the twelve sprite slots). */
const SLOTS = 12

/** D103: a `status` for a read that can be refused. */
export type SlotWalk =
  | { status: 'ok'; long: number; short: number }
  | { status: 'unrecognized' | 'setting' | 'unreadable'; reason: string }

interface Tables {
  max: number
  start: number
  res1: number
  max1: number
  start1: number
  res2: number
  max2: number
  special: number
  mask: number
  stop: number
  /** Entries per slot table, from the distance between the Max and Max1 tables. */
  size: number
}

/** The tables the loader reads, from the operands inside the fingerprinted span; null when the loader is not that one. */
function readTables(rom: RomFile, spec: CodeFingerprint): Tables | null {
  const span = bytesAt(rom, spec.at, spec.length)
  if (!span || fingerprint(Uint8Array.from(span)) !== spec.sha256) return null
  const byte = (i: number) => span[PICK + i]!
  const word = (i: number) => 0x020000 | byte(i) | (byte(i + 1) << 8)
  const size = word(AT.max1) - word(AT.max)
  if (size <= 0 || word(AT.max2) - word(AT.max1) !== size) return null
  return {
    max: word(AT.max), start: word(AT.start), res1: word(AT.res1), max1: word(AT.max1),
    start1: word(AT.start1), res2: word(AT.res2), max2: word(AT.max2),
    special: byte(AT.special), mask: byte(AT.mask), stop: byte(AT.stop), size,
  } // prettier-ignore
}

interface Range {
  from: number
  stop: number
}

/** The search range for sprite `id` on setting `s`: the top slot and the stop value the search ends on (exclusive). */
function rangeOf(rom: RomFile, t: Tables, s: number, id: number, along: number): Range | null {
  const at = (a: number) => bytesAt(rom, a + s, 1)?.[0]
  let [from, stop] = [at(t.max), at(t.start)]
  if (at(t.res1) === id) [from, stop] = [at(t.max1), at(t.start1)]
  // The special id takes the reserved range only when the spawn coordinate has the mask bit set (bank_02.asm:5389-5393).
  if (at(t.res2) === id && (id !== t.special || (along & t.mask) !== 0)) [from, stop] = [at(t.max2), t.stop] // prettier-ignore
  return from === undefined || stop === undefined ? null : { from, stop }
}

/** Every slot the search tries, top first, ending before `stop` (bank_02.asm:5400-5405: the stop slot itself is not tested). */
function slotsOf(r: Range): number[] {
  const out: number[] = []
  for (let x = r.from, n = 0; n < 256; n++) {
    out.push(x)
    x = (x - 1) & 0xff
    if (x === r.stop) break
  }
  return out
}

/**
 * The slot `id` lands in on this map, in both cases the length can depend on. `setting` is $1692, `along` the spawn
 * coordinate on the scroll axis (X in a horizontal map, Y in a vertical one: the loader's `$00`, the stores at bank_02.asm:5236 and 5245, compared at 5278-5281).
 * `long`: every slot free, so the top of the range. `short`: every slot an ORDINARY sprite can take is busy except the
 * last one the search reaches, so a short slot always exists. With no ordinary sprite in the range (the reserved slots)
 * the two are the same slot.
 * `spec` is a test hook for a synthetic cart's own fingerprint.
 */
export function slotWalk(
  rom: RomFile,
  setting: number,
  id: number,
  along: number,
  spec: CodeFingerprint = LOADER_PICK,
): SlotWalk {
  const t = readTables(rom, spec)
  if (!t) return { status: 'unrecognized', reason: 'the sprite loader on this ROM is not the original one' } // prettier-ignore
  if (setting < 0 || setting >= t.size) return { status: 'setting', reason: `the sprite memory setting ${setting} is outside the loader's ${t.size} tables` } // prettier-ignore
  const mine = rangeOf(rom, t, setting, id, along)
  // An id neither reserved list names on this setting: what an ordinary sprite does.
  const named = new Set([
    bytesAt(rom, t.res1 + setting, 1)?.[0],
    bytesAt(rom, t.res2 + setting, 1)?.[0],
  ])
  const plain = Array.from({ length: 256 }, (_, i) => i).find(i => !named.has(i))
  const ordinary = plain === undefined ? null : rangeOf(rom, t, setting, plain, 0)
  if (!mine || !ordinary)
    return { status: 'unreadable', reason: 'the loader tables could not be read' }
  const mineSlots = slotsOf(mine)
  const long = mineSlots[0]!
  // Every slot the search can reach must be a real sprite slot.
  if (mineSlots.some(x => x >= SLOTS))
    return { status: 'unreadable', reason: 'the loader gives a slot outside the sprite table' }
  const reachable = new Set(slotsOf(ordinary))
  const last = mineSlots[mineSlots.length - 1]!
  // Never null: the last slot of the range is not in `busy`.
  const short = mineSlots.find(x => !(reachable.has(x) && x !== last))!
  if (short > long)
    return {
      status: 'unreadable',
      reason: 'the loader tables give a short slot above the long one',
    }
  return { status: 'ok', long, short }
}
