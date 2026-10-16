/**
 * Placed-sprite list ids that the level loader turns into stationary Koopa shells, read from the
 * loader's own bytes (a hack that moves the range or the number base changes the mapping).
 *
 * The entry compare is CMP #$E7 / BCC at $02A866 (5290-5291). The compares are CODE_02A88C/02A89C/02A8AC/02A8B0/02A8C0 (SMWDisX bank_02.asm:5312, 5325, 5337,
 * 5339, 5349); CODE_02A8D0 stores the status (5361, stored 5455); the status-vs-number step is at
 * 5456-5462. The status-1 INIT never runs; only InitSpriteTables does (5498).
 * 5464-5471 also remap 4 -> 7 and 5 -> 6 when OWLevelTileSettings+$49 is negative (the special
 * world flag in the save). That flag is read as clear (a fresh save), so no remap happens here.
 *
 * A byte that is not the expected opcode refuses with a reason; the vanilla constants are never
 * a fallback.
 */
import type { RomFile } from '../RomFile'
import { bytesAt, shapeMatches } from './interp/Guards'

/** What the loader gives a shell: its sprite number and status. */
export interface ShellLoad {
  number: number
  status: number
}

/** A null in `want` is an operand the loader's routine is read for; the rest (opcodes, branch displacements) must match. */
const SITES: { what: string; at: number; want: (number | null)[] }[] = [
  { what: 'the entry compare', at: 0x02a866, want: [0xc9, null, 0x90, 0x22] },
  { what: 'the $DE (Eeries) compare', at: 0x02a88c, want: [0xc9, null, 0xd0, 0x0c] },
  { what: 'the $E0 (chain platforms) compare', at: 0x02a89c, want: [0xc9, null, 0xd0, 0x0c] },
  { what: 'the generator floor compare', at: 0x02a8ac, want: [0xc9, null, 0x90, 0x24] },
  { what: 'the generator ceiling compare', at: 0x02a8b0, want: [0xc9, null, 0xb0, 0x0c] },
  { what: 'the shell ceiling compare', at: 0x02a8c0, want: [0xc9, null, 0x90, 0x0c] },
  { what: 'the shell status load', at: 0x02a8d0, want: [0xa9, null, 0x80, 0x0b] },
  { what: 'the status compare', at: 0x02a978, want: [0xc9, null, 0xb7, null, 0x90, 0x06] },
  { what: 'the number step', at: 0x02a97e, want: [0x38, 0xe9, null, 0x18, 0x69, null] },
]

/** ASSUMPTION, not fact: ids below $C9 run plain when a loader site fails. A hook at $02A866 ahead of the $C9 split could still make a lower id a shell. */
const FIRST_SPECIAL = 0xc9

/**
 * The shell mapping for list id `id`: `shell` is undefined when the loader does not make `id` a
 * shell, and `refusal` names the loader part that is not the expected code. The range comes from
 * the compare operands read, not from vanilla constants. When a site is not the expected code the
 * answer is unknowable, so ids from $C9 up (where the vanilla loader leaves LoadNormalSprite) refuse
 * and lower ids run as plain sprites.
 */
export function shellLoad(rom: RomFile, id: number): { shell?: ShellLoad; refusal?: string } {
  if (!Number.isInteger(id) || id < 0 || id > 0xff) return {}
  const f: number[][] = []
  for (const s of SITES) {
    const got = bytesAt(rom, s.at, s.want.length)
    if (!shapeMatches(got, s.want))
      return id < FIRST_SPECIAL ? {} : { refusal: `${s.what} in the level loader is not the expected code` } // prettier-ignore
    f.push(got!)
  }
  const [entry, eerie, platforms, floor, ceil, shellCeil, status, cmp, step] = f
  // An id at or past the entry compare is a scroll sprite, never these compares (5290-5291).
  if (id >= entry[1] || id === eerie[1] || id === platforms[1]) return {}
  if (id < floor[1] || id < ceil[1] || id >= shellCeil[1]) return {}
  // CMP #cmp / LDA [..],Y / BCC: a status below cmp keeps the id, else it is rebased.
  const number = status[1] < cmp[1] ? id : (id - step[2] + step[5]) & 0xff
  return { shell: { number, status: status[1] } }
}
