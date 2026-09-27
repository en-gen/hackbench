/**
 * Every site `src/rom/PSwitchButtonArt.ts` reads, planted from 65816 encoding
 * at the vanilla anchors, with the resolved routines placed freely (the module
 * resolves them from branch, JSR and table operands, never literally).
 */
import { RomFile } from '../../../src/rom/RomFile'
import { w } from './syntheticMap16'

export const PSWITCH_SITES = {
  dispatch: 0x01a1b0,
  stunPow: 0x01a200,
  unpressedSite: 0x01a240,
  smushedGfxRt: 0x01b000,
  callSpriteInit: 0x018172,
  initPSwitch: 0x018600,
  pswitchPal: 0x018700,
  levelMode: 0x0584f9,
  levelTable: 0x0584b7,
}

export interface PSwitchRomOpts {
  unpressedTile?: number
  pressedTile?: number
  xOffset?: number
  yOffset?: number
  tile1Mask?: number
  blueAttr?: number
  silverAttr?: number
  /** LevXYPPCCCTtbl, one byte per level mode; 32 entries of vanilla's $20 by default. */
  levelTable?: number[]
  /** Where StunPow and the unpressed site sit, so a test can put them before their readers. */
  stunPow?: number
  unpressedSite?: number
}

const beq = (fromOpcodeAddr: number, target: number): number[] => {
  const disp = target - (fromOpcodeAddr + 2)
  if (disp < -128 || disp > 127) throw new Error('displacement out of range')
  return [0xf0, disp & 0xff]
}

/** A 512 KB LoROM stub holding a vanilla-shaped P-switch, with `o` planted over it. */
export function pswitchRom(o: PSwitchRomOpts = {}): RomFile {
  const S = { ...PSWITCH_SITES, stunPow: o.stunPow ?? PSWITCH_SITES.stunPow }
  const unpressedSite = o.unpressedSite ?? PSWITCH_SITES.unpressedSite
  const rom = new RomFile('stub.sfc', Buffer.alloc(0x80000))
  const table = o.levelTable ?? Array<number>(32).fill(0x20)

  // CMP #$3E / BEQ StunPow (bank_01.asm:4516-4517).
  rom.writeAt(S.dispatch, [0xc9, 0x3e, ...beq(S.dispatch + 2, S.stunPow)])
  // StunPow (bank_01.asm:4564-4575): LDY / BEQ / CPY / BNE / JMP / JSR / LDY / LDA / AND / STA.
  // prettier-ignore
  rom.writeAt(S.stunPow, [
    0xbc, ...w(0x163e), ...beq(S.stunPow + 3, unpressedSite), 0xc0, 0x01, 0xd0, 0x03,
    0x4c, ...w(0x9acb), 0x20, ...w(S.smushedGfxRt & 0xffff), 0xbc, ...w(0x15ea),
    0xb9, ...w(0x0303), 0x29, o.tile1Mask ?? 0xfe, 0x99, ...w(0x0303), 0x60,
  ])
  // CODE_01A218 (bank_01.asm:4578-4582).
  // prettier-ignore
  rom.writeAt(unpressedSite, [
    0xa9, 0x01, 0x9d, ...w(0x157c), 0x20, ...w(0x9f0d), 0xa9, o.unpressedTile ?? 0x42,
  ])
  // SmushedGfxRt's operands (bank_01.asm:13899, 13903, 13909-13911, 13927).
  rom.writeAt(S.smushedGfxRt + 14, [0x69, (o.xOffset ?? 8) & 0xff])
  rom.writeAt(S.smushedGfxRt + 22, [0x69, (o.yOffset ?? 8) & 0xff])
  rom.writeAt(S.smushedGfxRt + 34, [0xa9, o.pressedTile ?? 0xfe, 0xe0, 0x3e, 0xf0, 0x12])
  rom.writeAt(S.smushedGfxRt + 73, [0x09, 0x40])
  // CallSpriteInit (bank_01.asm:225-229) and its $3E entry (293).
  // prettier-ignore
  rom.writeAt(S.callSpriteInit, [0xa9, 0x08, 0x9d, ...w(0x14c8), 0xb5, 0x9e, 0x22, 0xdf, 0x86, 0x00])
  rom.writeAt(S.callSpriteInit + 11 + 0x3e * 2, w(S.initPSwitch & 0xffff))
  // InitPSwitch (bank_01.asm:665-674) and PSwitchPal (681-682).
  // prettier-ignore
  rom.writeAt(S.initPSwitch, [
    0xb5, 0xe4, 0x4a, 0x4a, 0x4a, 0x4a, 0x29, 0x01, 0x9d, ...w(0x151c), 0xa8,
    0xb9, ...w(S.pswitchPal & 0xffff),
  ])
  rom.writeAt(S.pswitchPal, [o.blueAttr ?? 0x06, o.silverAttr ?? 0x02])
  // AND #$1F / STA / TAX / LDA.L LevXYPPCCCTtbl,X / STA SpriteProperties (bank_05.asm:539-543).
  // prettier-ignore
  rom.writeAt(S.levelMode, [
    0x29, table.length - 1, 0x8d, ...w(0x1925), 0xaa,
    0xbf, ...w(S.levelTable & 0xffff), S.levelTable >> 16, 0x85, 0x64,
  ])
  rom.writeAt(S.levelTable, table)
  return rom
}
