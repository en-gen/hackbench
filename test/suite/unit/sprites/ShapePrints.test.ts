/**
 * ROM-byte clean-up: the fixed bytes of ExecutePtr, CallSpriteInit, the block spawn's status write and the
 * grinder's entry are recognized by SHA-256 with their free operands masked, not by a committed byte list.
 * Each is swept: a flip at every hashed offset is refused with the reader's own reason, a flip at every masked
 * offset is not. The synthetic half needs no ROM; the vanilla half proves the committed vanilla digests and masks.
 */
import { describe, expect, it } from 'vitest'
import type { RomFile } from '../../../../src/rom/RomFile'
import {
  ENTRY_PINNED,
  grinderDrawsBeforeSnap,
  VANILLA_DISPATCH,
} from '../../../../src/rom/sprites/interp/LineGuided'
import { printMatches } from '../../../../src/rom/sprites/interp/Guards'
import {
  resolveBlockSpawn,
  resolveLoop,
  resolvePointer,
  resolveTables,
  VANILLA_SHAPES,
} from '../../../../src/rom/sprites/interp/SpriteDispatch'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { GRINDER_DISPATCH, GRINDER_HANDLER } from '../../support/syntheticGrinder'
import {
  buildSyntheticRom,
  SYNTHETIC_DISPATCHER as SYN,
  SYNTHETIC_SHAPES,
} from '../../support/syntheticSpriteRom'

const flip = (rom: RomFile, at: number) => void rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ 1])
const offsets = (n: number) => Array.from({ length: n }, (_, i) => i)

/** One shape: where it sits, its print, and how a reader's verdict is read after a flip. */
interface Case {
  name: string
  at: number
  print: { length: number; mask: readonly number[] }
  /** The reader's verdict on `rom`: null when it accepts, else its reason. */
  verdict: (rom: RomFile) => string | null
}
const dispatchVerdict = (rom: RomFile) => {
  const t = resolveTables(rom)
  return t.ok ? null : t.reason
}
const blockVerdict = (rom: RomFile) => {
  const r = resolveBlockSpawn(rom, SYN)
  return r.ok ? null : r.reason
}
const CASES: Case[] = [
  {
    name: 'ExecutePtr',
    at: 0x0086fa,
    print: SYNTHETIC_SHAPES.executePtr,
    verdict: dispatchVerdict,
  },
  {
    name: 'CallSpriteInit',
    at: 0x018170,
    print: SYNTHETIC_SHAPES.callSpriteInit,
    verdict: dispatchVerdict,
  },
  {
    name: 'block spawn status write',
    at: 0x028922,
    print: SYNTHETIC_SHAPES.blockStatus,
    verdict: blockVerdict,
  },
]
const REASON: Record<string, RegExp> = {
  ExecutePtr: /16-bit ExecutePtr/,
  CallSpriteInit: /CallSpriteInit is not/,
  'block spawn status write': /does not write the sprite status/,
}

describe('shapes recognized by fingerprint (synthetic cart)', () => {
  it('the synthetic cart is accepted, and is not the vanilla digest', () => {
    const rom = buildSyntheticRom()
    expect(dispatchVerdict(rom)).toBeNull()
    expect(blockVerdict(rom)).toBeNull()
    for (const c of CASES) {
      const got = [...rom.readAt(c.at, c.print.length)!]
      const vanilla = c.name === 'ExecutePtr' ? VANILLA_SHAPES.executePtr : c.name === 'CallSpriteInit' ? VANILLA_SHAPES.callSpriteInit : VANILLA_SHAPES.blockStatus // prettier-ignore
      expect(printMatches(got, vanilla), c.name).toBe(false)
    }
  })

  it.each(CASES)(
    '$name: a flip at every hashed offset is refused, at every masked offset is not',
    c => {
      const refused: number[] = []
      const accepted: number[] = []
      for (const i of offsets(c.print.length)) {
        const rom = buildSyntheticRom()
        flip(rom, c.at + i)
        const v = c.verdict(rom)
        if (c.print.mask.includes(i)) {
          if (v !== null) refused.push(i)
        } else {
          if (v === null || !REASON[c.name]!.test(v)) accepted.push(i)
        }
      }
      expect({ maskedButRefused: refused, hashedButNotRefusedWithItsReason: accepted }).toEqual({
        maskedButRefused: [],
        hashedButNotRefusedWithItsReason: [],
      })
    },
  )

  it('the grinder entry: every hashed offset refused, the three masked ones not', () => {
    const verdict = (i: number) => {
      const rom = buildSyntheticRom()
      flip(rom, GRINDER_HANDLER + i)
      return grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, GRINDER_DISPATCH)
    }
    for (const i of ENTRY_PINNED) expect(verdict(i), `pinned +${i}`).toBe(false)
    for (const i of [12, 14, 15]) expect(verdict(i), `masked +${i}`).toBe(true)
  })
})

describe.skipIf(!hasRom(VANILLA))('shapes recognized by fingerprint (vanilla ROM)', () => {
  const loopOf = (rom: RomFile) => resolveLoop(rom) as { handle: number }

  it('the vanilla digests accept the vanilla ROM', () => {
    const rom = freshRom()
    expect(dispatchVerdict(rom)).toBeNull()
    expect(resolveBlockSpawn(rom).ok).toBe(true)
    const t = resolveTables(rom, loopOf(rom).handle)
    if (!t.ok) throw new Error(t.reason)
    const p = resolvePointer(rom, t.tables.mainTable, 0x67)
    if (!p.ok) throw new Error('pointer')
    expect(grinderDrawsBeforeSnap(rom, p.handler.address, VANILLA_DISPATCH)).toBe(true)
  })

  it.each([
    ['ExecutePtr', 0x0086df, VANILLA_SHAPES.executePtr, /16-bit ExecutePtr/],
    ['CallSpriteInit', 0x018172, VANILLA_SHAPES.callSpriteInit, /CallSpriteInit is not/],
  ] as const)(
    '%s: vanilla flips at every hashed offset refuse, at every masked offset do not',
    (_n, at, print, reason) => {
      for (const i of offsets(print.length)) {
        const rom = freshRom()
        flip(rom, at + i)
        const t = resolveTables(rom, loopOf(rom).handle)
        if (print.mask.includes(i)) expect(t.ok, `masked +${i}`).toBe(true)
        else expect(!t.ok && reason.test(t.reason), `hashed +${i}`).toBe(true)
      }
    },
  )

  it('block spawn status write: same sweep on the vanilla ROM', () => {
    for (const i of offsets(VANILLA_SHAPES.blockStatus.length)) {
      const rom = freshRom()
      flip(rom, 0x028922 + i)
      const r = resolveBlockSpawn(rom)
      if (VANILLA_SHAPES.blockStatus.mask.includes(i)) expect(r.ok, `masked +${i}`).toBe(true)
      else expect(!r.ok && /does not write the sprite status/.test(r.reason), `hashed +${i}`).toBe(true) // prettier-ignore
    }
  })

  it('grinder entry: same sweep on the vanilla ROM', () => {
    const rom0 = freshRom()
    const t = resolveTables(rom0, loopOf(rom0).handle)
    if (!t.ok) throw new Error(t.reason)
    const p = resolvePointer(rom0, t.tables.mainTable, 0x67)
    if (!p.ok) throw new Error('pointer')
    const at = p.handler.address
    for (let i = 0; i < 17; i++) {
      const rom = freshRom()
      flip(rom, at + i)
      expect(grinderDrawsBeforeSnap(rom, at, VANILLA_DISPATCH), `+${i}`).toBe(
        [12, 14, 15].includes(i),
      )
    }
  })
})
