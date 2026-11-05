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
 * The pick, `LDY SpriteMemorySetting` to the `BNE` after the status test (bank_02.asm:5376-5405, $02A8E4-$02A921), 62
 * bytes in ONE SHA-256. Nothing is masked or normalized, so all 62 count toward D126's 24 unknown bytes (vanilla US cart,
 * one machine); the table operands sit inside the span, so a relocated table fails the digest and the sprite keeps slot 0.
 */
export const LOADER_PICK: CodeFingerprint = { at: 0x02a8e4, length: 62, sha256: 'e62f6d8872398313a7b5fc0af4a2250b8f455ba74e07dde38c7df85b8868bb38' } // prettier-ignore

/** Where each table operand and immediate sits in the span (instruction offsets of the listing at bank_02.asm:5376-5405). */
const AT = { max: 4, start: 7, res1: 14, max1: 19, start1: 22, res2: 29, special: 34, mask: 40, max2: 44, stop: 47 } as const // prettier-ignore

/** The slots a Machine can run (the twelve sprite slots). */
const SLOTS = 12

/** D103: a `status` for a read that can be refused. */
export type SlotWalk =
  | { status: 'ok'; long: number; short: number | null }
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
  const word = (i: number) => 0x020000 | span[i]! | (span[i + 1]! << 8)
  const size = word(AT.max1) - word(AT.max)
  if (size <= 0 || word(AT.max2) - word(AT.max1) !== size) return null
  return {
    max: word(AT.max), start: word(AT.start), res1: word(AT.res1), max1: word(AT.max1),
    start1: word(AT.start1), res2: word(AT.res2), max2: word(AT.max2),
    special: span[AT.special]!, mask: span[AT.mask]!, stop: span[AT.stop]!, size,
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
 * coordinate on the scroll axis (X in a horizontal map, Y in a vertical one: the loader's `$00`, bank_02.asm:5217-5240).
 * `long`: every slot free, so the top of the range. `short`: every slot an ORDINARY sprite can take is busy except the
 * last one the search reaches. With no ordinary sprite in the range (the reserved slots) the two are the same slot.
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
  const named = new Set([bytesAt(rom, t.res1 + setting, 1)?.[0], bytesAt(rom, t.res2 + setting, 1)?.[0]])
  const plain = Array.from({ length: 256 }, (_, i) => i).find(i => !named.has(i))
  const ordinary = plain === undefined ? null : rangeOf(rom, t, setting, plain, 0)
  if (!mine || !ordinary) return { status: 'unreadable', reason: 'the loader tables could not be read' }
  const mineSlots = slotsOf(mine)
  const long = mineSlots[0]!
  if (long >= SLOTS) return { status: 'unreadable', reason: 'the loader gives a slot outside the sprite table' }
  const reachable = new Set(slotsOf(ordinary))
  const last = mineSlots[mineSlots.length - 1]!
  const short = mineSlots.find(x => !(reachable.has(x) && x !== last))
  return { status: 'ok', long, short: short !== undefined && short < SLOTS ? short : null }
}
