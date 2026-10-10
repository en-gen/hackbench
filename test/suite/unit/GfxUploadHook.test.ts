/**
 * The hook at UploadGFXFile's JSL PrepareGraphicsFile (#411): recognized by a
 * masked fingerprint, and Y read from its bytes. Synthetic hooks are
 * assembled here from the opcodes, so CI (no ROM) exercises every verdict;
 * the corpus cases are gated with describe.skipIf.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { filterSomeRamNote, filterSomeRamPath } from '../../../src/rom/GfxLoader'
import {
  UPLOAD_HOOK_SHAPES,
  readHookY,
  recognizesHook,
  shapeHash,
  type HookShape,
} from '../../../src/rom/GfxUploadHook'
import {
  FILTER_BODY_SHA,
  PREPARE_GFX,
  UPLOAD_GFX_ENTRY,
  jsl,
  plantFilterSomeRam,
  plantGfxReadPath,
} from '../support/syntheticGfxCart'
import { hasRom, freshRom } from '../support/corpus'

const HOOK = 0x00e000
const SUB = 0x00e100
const PHY = 0x5a
const PLY = 0x7a
const PHX = 0xda
const PLX = 0xfa
const RTL = 0x6b
const RTS = 0x60
const ldy = (v: number): number[] => [0xa0, v]
const jsr = (t: number): number[] => [0x20, t & 0xff, (t >> 8) & 0xff]

/** A cart whose UploadGFXFile calls `hook` at HOOK, with `sub` at SUB. */
function cartWith(hook: number[], sub: number[] = []): RomFile {
  const rom = new RomFile('hook.sfc', Buffer.alloc(0x10000))
  plantGfxReadPath(rom)
  plantFilterSomeRam(rom)
  rom.writeAt(UPLOAD_GFX_ENTRY, jsl(HOOK))
  rom.writeAt(HOOK, hook)
  if (sub.length) rom.writeAt(SUB, sub)
  return rom
}
const shapeOf = (bytes: number[], wild: number[] = []): HookShape => ({
  length: bytes.length,
  wild,
  sha256: shapeHash(Uint8Array.from(bytes), wild)!,
})
const y = (hook: number[], sub: number[] = []) => readHookY(cartWith(hook, sub), HOOK, PREPARE_GFX)
const path = (hook: number[], sub: number[] = [], shapes?: HookShape[]) =>
  filterSomeRamPath(cartWith(hook, sub), 0x1e, 0, FILTER_BODY_SHA, shapes ?? [shapeOf(hook)])
const reason = (r: ReturnType<typeof path>): string => (r.ok ? 'not refused' : r.reason)

describe('readHookY on synthetic hooks', () => {
  const stock = jsl(PREPARE_GFX)
  it('keeps Y when it is never written', () => {
    expect(y([...stock, RTL])).toEqual({ kind: 'kept' })
  })
  it('keeps Y when every write sits inside a PHY/PLY pair', () => {
    expect(y([PHY, ...ldy(0), PLY, RTL])).toEqual({ kind: 'kept' })
    expect(y([PHY, PHX, ...ldy(0), PLX, PLY, RTL])).toEqual({ kind: 'kept' })
  })
  it('clobbers Y when it is written bare, naming where', () => {
    expect(y([0xea, ...ldy(0xff), RTL])).toEqual({ kind: 'clobbered', at: HOOK + 1 })
  })
  it('clobbers Y when the PLY pulls something else', () => {
    expect(y([PHX, PLY, RTL]).kind).toBe('clobbered')
    expect(y([PLY, RTL]).kind).toBe('clobbered')
  })
  it('clobbers Y on one arm of a branch even if the other keeps it', () => {
    // BEQ +2 / LDY #$00 / RTL ; RTL  (the branch is never evaluated)
    expect(y([0xf0, 0x03, ...ldy(0), RTL, RTL]).kind).toBe('clobbered')
  })
  it('treats TAY, TXY, INY, DEY as writes', () => {
    for (const op of [0xa8, 0x9b, 0xc8, 0x88]) expect(y([op, RTL]).kind).toBe('clobbered')
  })
  it('clears a call to a routine it also clears, and not to one that clobbers', () => {
    expect(y([...jsr(SUB), RTL], [PHY, ...ldy(1), PLY, RTS])).toEqual({ kind: 'kept' })
    expect(y([...jsr(SUB), RTL], [...ldy(1), RTS]).kind).toBe('clobbered')
    expect(y([...jsl(SUB), RTL], [PHY, 0xa8, PLY, RTL])).toEqual({ kind: 'kept' })
  })
  it('refuses a call it cannot read, and one that changes register widths', () => {
    expect(y([0xfc, 0x00, 0x90, RTL]).kind).toBe('unknown')
    expect(y([...jsr(SUB), RTL], [0xc2, 0x10, RTS]).kind).toBe('unknown')
  })
  it('restores the register widths a PLP brings back', () => {
    // PHP / REP #$10 / PLP / LDY #$00 (8-bit again, so a 2-byte instruction) / RTL
    expect(y([0x08, 0xc2, 0x10, 0x28, ...ldy(0), RTL])).toEqual({ kind: 'clobbered', at: HOOK + 4 })
  })
  it('refuses a return with something still pushed, and a loop it cannot bound', () => {
    expect(y([PHX, RTL]).kind).toBe('unknown')
    expect(y([PHX, 0x80, 0xfd]).kind).toBe('unknown')
  })
  it('refuses a routine that never returns', () => {
    expect(y([0x80, 0xfe]).kind).toBe('unknown')
  })
})

describe('the recognition gate', () => {
  const keeps = [...jsl(PREPARE_GFX), RTL]
  it('resolves a recognized hook that keeps Y like the stock routine', () => {
    expect(path(keeps)).toEqual({ ok: true, filtered: true })
    expect(filterSomeRamPath(cartWith(keeps), 0x00, 0, FILTER_BODY_SHA, [shapeOf(keeps)])).toEqual({
      ok: true,
      filtered: false,
    })
  })
  it('refuses a recognized hook that clobbers Y, and says Y', () => {
    const r = reason(path([...ldy(0xff), RTL]))
    expect(r).toMatch(/writes Y outside a PHY\/PLY pair at \$00E000/)
  })
  it('refuses a hook that is not recognized, even one that keeps Y', () => {
    expect(reason(path(keeps, [], []))).toMatch(
      /does not call the stock PrepareGraphicsFile.*not a recognized hook/,
    )
  })
  it('refuses a recognized hook whose Y is not read, with the reason', () => {
    expect(reason(path([0xfc, 0x00, 0x90, RTL]))).toMatch(/not read: an instruction/)
  })
  it('recognizes through wild bytes only, and not a changed fixed byte', () => {
    const body = [0xea, ...jsr(SUB), RTL]
    const shape = shapeOf(body, [2, 3])
    const rom = cartWith(body, [RTS])
    expect(recognizesHook(rom, HOOK, [shape])).toBe(true)
    rom.writeAt(HOOK + 2, [0x7f]) // a wild byte
    expect(recognizesHook(rom, HOOK, [shape])).toBe(true)
    rom.writeAt(HOOK + 1, [0x22]) // a fixed byte
    expect(recognizesHook(rom, HOOK, [shape])).toBe(false)
    expect(recognizesHook(rom, HOOK, [])).toBe(false)
  })
  it('keeps the stock path unchanged: no hook, no refusal', () => {
    const rom = new RomFile('stock.sfc', Buffer.alloc(0x10000))
    plantGfxReadPath(rom)
    plantFilterSomeRam(rom)
    expect(filterSomeRamPath(rom, 0x1e, 0, FILTER_BODY_SHA, [])).toEqual({
      ok: true,
      filtered: true,
    })
  })
})

// The 4 ROMs whose JSL goes to the hook; vanilla and magic call the stock routine.
const HOOKED = [
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
]
describe.each(HOOKED)('%s', name => {
  describe.skipIf(!hasRom(name))('hooked ROM', () => {
    it('is recognized and its Y write is read, so the gate refuses naming Y', () => {
      const rom = freshRom(name)
      expect(recognizesHook(rom, 0x0ff160, UPLOAD_HOOK_SHAPES)).toBe(true)
      const r = filterSomeRamPath(rom, 0x1e, 0x11)
      expect(r.ok ? '' : r.reason).toMatch(/writes Y outside a PHY\/PLY pair at \$0FF1B3/)
      expect(filterSomeRamNote(rom, 0x11)).toMatch(/unverified/)
    })
  })
})
