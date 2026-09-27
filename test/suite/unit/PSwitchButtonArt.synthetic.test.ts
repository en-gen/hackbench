/**
 * Synthetic (no ROM) coverage for PSwitchButtonArt.ts: every value read and
 * every gated byte, from stubs built in test/suite/support/syntheticPSwitch.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  bigObjTiles,
  objAttrToCgramRow,
  PSWITCH_PARTS,
  pSwitchTileAttrs,
  readPSwitchButtonArt,
  spriteCharNum,
  type PSwitchButtonArtResult,
} from '../../../src/rom/PSwitchButtonArt'
import { VRAM_CHAR_BASE } from '../../../src/rom/GfxLoader'
import { WILD } from '../../../src/rom/BytePattern'
import { PSWITCH_SITES, pswitchRom, type PSwitchRomOpts } from '../support/syntheticPSwitch'

const read = (o: PSwitchRomOpts = {}): PSwitchButtonArtResult => readPSwitchButtonArt(pswitchRom(o))
const art = (o: PSwitchRomOpts = {}) => {
  const r = read(o)
  if (!r.ok) throw new Error(r.reason)
  return r.art
}

describe('readPSwitchButtonArt', () => {
  it('reads every value off a vanilla-shaped stub', () => {
    expect(art()).toEqual({
      unpressedTile: 0x42,
      pressedTile: 0xfe,
      xOffset: 8,
      yOffset: 8,
      tile1Mask: 0xfe,
      spriteProperties: 0,
      blueAttr: 0x06,
      silverAttr: 0x02,
    })
  })

  it('reads moved operands as data, never the vanilla values', () => {
    const a = art({ unpressedTile: 0x99, pressedTile: 0x77, xOffset: 6, yOffset: 5 })
    expect([a.unpressedTile, a.pressedTile, a.xOffset, a.yOffset]).toEqual([0x99, 0x77, 6, 5])
    expect(art({ blueAttr: 0x0a, silverAttr: 0x0c, tile1Mask: 0xf0 })).toMatchObject({
      blueAttr: 0x0a,
      silverAttr: 0x0c,
      tile1Mask: 0xf0,
    })
  })

  it.each([
    ['Y', 'yOffset'],
    ['X', 'xOffset'],
  ] as const)('keeps both pressed tiles inside the 16px frame on %s', (axis, key) => {
    for (const v of [0, 8]) expect(art({ [key]: v })[key]).toBe(v)
    for (const v of [-1, 9]) {
      const r = read({ [key]: v })
      expect(!r.ok && r.reason).toContain(`${axis} displacement (${v})`)
    }
  })

  it.each([
    ['blue', { blueAttr: 0x46 }],
    ['silver', { silverAttr: 0x82 }],
  ] as const)(
    'refuses a %s PSwitchPal with flip bits set, which would flip the unpressed tile',
    (_, o) => {
      const r = read(o)
      expect(!r.ok && r.reason).toMatch(/PSwitchPal .* flip/)
    },
  )

  it('ORs the low nibble every level mode agrees on into SpriteProperties', () => {
    expect(art({ levelTable: Array<number>(32).fill(0x31) }).spriteProperties).toBe(0x01)
  })

  it('refuses a LevXYPPCCCTtbl whose entries disagree on bits 0-3', () => {
    const table = Array<number>(32).fill(0x20)
    table[17] = 0x21
    const r = read({ levelTable: table })
    expect(!r.ok && r.reason).toMatch(/LevXYPPCCCTtbl .* disagree/)
  })

  it('reads the table over as many level modes as the AND mask allows', () => {
    // Mask $0F: 16 modes reachable, so a disagreeing byte past them is never read.
    const rom = pswitchRom({ levelTable: Array<number>(16).fill(0x20) })
    rom.writeAt(PSWITCH_SITES.levelTable + 16, [0x2f])
    expect(readPSwitchButtonArt(rom).ok).toBe(true)
  })

  it('refuses a LevXYPPCCCTtbl that is not ROM', () => {
    const rom = pswitchRom()
    rom.writeAt(PSWITCH_SITES.levelMode + 7, [0x00, 0x10, 0x7e])
    const r = readPSwitchButtonArt(rom)
    expect(!r.ok && r.reason).toMatch(/not ROM/)
  })

  it('resolves StunPow and its unpressed site placed BEFORE their readers', () => {
    const stunPow = PSWITCH_SITES.dispatch - 0x40
    expect(art({ stunPow, unpressedSite: stunPow - 0x20 }).unpressedTile).toBe(0x42)
  })

  // Every non-WILD byte of every pattern, flipped, must refuse: a byte that can change
  // without a refusal is a gate that cannot fail. The bases are where the stub plants each group.
  const bases: Record<keyof typeof PSWITCH_PARTS, number> = {
    dispatch: PSWITCH_SITES.dispatch,
    stunPow: PSWITCH_SITES.stunPow,
    unpressedSite: PSWITCH_SITES.unpressedSite,
    smushedGfxRt: PSWITCH_SITES.smushedGfxRt,
    callSpriteInit: PSWITCH_SITES.callSpriteInit,
    initPSwitch: PSWITCH_SITES.initPSwitch,
    levelMode: PSWITCH_SITES.levelMode,
  }
  const gated = Object.entries(PSWITCH_PARTS).flatMap(([group, parts]) =>
    parts.flatMap(([offset, pattern, name]) =>
      pattern.flatMap((b, i) =>
        b === WILD
          ? []
          : [[`${group}: ${name} +${i}`, bases[group as keyof typeof bases] + offset + i] as const],
      ),
    ),
  )

  it('gates exactly these bytes, by group, offset and value', () => {
    // A byte moved from gated to WILD (or the reverse) keeps a count; it cannot keep this list.
    const pins = Object.fromEntries(
      Object.entries(PSWITCH_PARTS).map(([group, parts]) => [
        group,
        parts
          .flatMap(([offset, pattern]) =>
            pattern.flatMap((b, i) =>
              b === WILD ? [] : [`${(offset + i).toString(16)}=${b.toString(16).padStart(2, '0')}`],
            ),
          )
          .join(' '),
      ]),
    )
    expect(pins).toEqual({
      dispatch: '0=c9 1=3e 2=f0',
      stunPow: '0=bc 3=f0 c=20 12=b9 15=29 17=99',
      unpressedSite: '0=a9 1=01 2=9d 5=20 8=a9',
      smushedGfxRt: 'e=69 16=69 22=a9 24=e0 25=3e 26=f0 49=09 4a=40',
      callSpriteInit: '0=a9 1=08 2=9d 5=b5 7=22',
      initPSwitch: '0=b5 2=4a 3=4a 4=4a 5=4a 6=29 7=01 c=b9',
      levelMode: '0=29 2=8d 5=aa 6=bf a=85 b=64',
    })
    expect(gated).toHaveLength(41)
  })

  it.each(gated)('refuses when %s is flipped', (_, addr) => {
    const rom = pswitchRom()
    rom.writeAt(addr, [rom.readAt(addr, 1)![0]! ^ 0xff])
    const r = readPSwitchButtonArt(rom)
    expect(!r.ok && r.reason.length).toBeGreaterThan(0)
  })
})

describe('pSwitchTileAttrs', () => {
  it('ORs SpriteProperties in, masks pressed tile 1 by the AND operand, x-flips tile 2', () => {
    const a = art({ blueAttr: 0x07, levelTable: Array<number>(32).fill(0x28) })
    expect(pSwitchTileAttrs(a, a.blueAttr)).toEqual({
      unpressed: 0x0f,
      pressed1: 0x0e,
      pressed2: 0x4f,
    })
  })

  it('leaves vanilla on SP1/SP2 with rows 11 and 9', () => {
    const a = art()
    for (const [pal, row] of [
      [a.blueAttr, 11],
      [a.silverAttr, 9],
    ] as const) {
      const t = pSwitchTileAttrs(a, pal)
      expect([t.unpressed & 1, t.pressed1 & 1, t.pressed2 & 1]).toEqual([0, 0, 0])
      expect(objAttrToCgramRow(t.unpressed)).toBe(row)
    }
  })
})

describe('spriteCharNum', () => {
  it('splits at $80 and takes the name table from attribute bit 0', () => {
    expect(spriteCharNum(0x42, 0x06)).toBe(VRAM_CHAR_BASE.sp1 + 0x42)
    expect(spriteCharNum(0xfe, 0x06)).toBe(VRAM_CHAR_BASE.sp2 + 0x7e)
    expect(spriteCharNum(0x10, 0x07)).toBe(VRAM_CHAR_BASE.sp3 + 0x10)
    expect(spriteCharNum(0x90, 0x07)).toBe(VRAM_CHAR_BASE.sp4 + 0x10)
  })
})

describe('bigObjTiles', () => {
  it('wraps the column in the low nibble and the row in the name table, as the PPU does', () => {
    expect(bigObjTiles(0x42)).toEqual([0x42, 0x43, 0x52, 0x53])
    expect(bigObjTiles(0x4f)).toEqual([0x4f, 0x40, 0x5f, 0x50])
    expect(bigObjTiles(0xf2)).toEqual([0xf2, 0xf3, 0x02, 0x03])
  })
})

describe('objAttrToCgramRow', () => {
  it('is 8 plus bits 1-3', () => {
    expect([0x00, 0x02, 0x06, 0x0e, 0x0f].map(objAttrToCgramRow)).toEqual([8, 9, 11, 15, 15])
  })
})
