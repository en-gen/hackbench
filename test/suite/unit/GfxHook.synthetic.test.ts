/**
 * The ExGFX hook at the level GFX call: both builds recognized by the path a
 * stock file number takes, and refused on a defect anywhere along it.
 *
 * **Synthetic cartridges only.** The hook shape is written from the 65816
 * encoding in syntheticGfxCart.ts; no bytes come from a ROM.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  checkStockCompression,
  dispatcherFingerprint,
  readGfxPointerSites,
  readLevelGfxHook,
} from '../../../src/rom/GfxArena'
import { levelGfxAssignmentNote } from '../../../src/rom/GfxLoader'
import { decodeMap16Sheet } from '../../../theia/extension/src/node/map16-decode'
import { map16DecodeStub } from '../support/syntheticMap16'
import {
  HOOK_DISPATCHER,
  HOOK_LANDING,
  HOOK_LOADER,
  PREPARE_GFX,
  TABLE_BANK,
  TABLE_HI,
  TABLE_LO,
  buildCart,
  jsl,
  plantGfxHook,
} from '../support/syntheticGfxCart'

// Pinned by literal so a wrong LEVEL_GFX_CALLERS cannot hide behind the fixture.
const PRIMARY_CALLER = 0x00aa6b
const HOOK_AT = 0x019000
const TABLES = { lo: TABLE_LO, hi: TABLE_HI, bank: TABLE_BANK }
// The dispatcher's extent, masked operands and folded bank bytes, pinned by
// literal so widening a mask or shortening the hash cannot follow the sweep.
const DISPATCHER_BYTES = 0x6f
const MASKED = [0x18, 0x1e, 0x24, 0x37, 0x3d, 0x63]
const FOLDED = [0x51, 0x57]

function hooked(loader: 'direct' | 'stub', tables?: number[]): { rom: RomFile; fp: string } {
  const { rom } = buildCart()
  plantGfxHook(rom, HOOK_AT, PREPARE_GFX, loader, tables)
  rom.writeAt(PRIMARY_CALLER, jsl(HOOK_AT))
  const fp = dispatcherFingerprint(rom, HOOK_AT + HOOK_DISPATCHER)!
  return { rom, fp }
}

const read = (rom: RomFile, fp: string) => readLevelGfxHook(rom, HOOK_AT, PREPARE_GFX, TABLES, [fp])

/** Flip each byte in [from, from+length) except `skip`, and list those the walk survives. */
function survivors(
  loader: 'direct' | 'stub',
  from: number,
  length: number,
  skip: (i: number) => boolean = () => false,
  flip: (b: number) => number = b => (b + 1) & 0xff,
): number[] {
  const { rom, fp } = hooked(loader)
  const out: number[] = []
  for (let i = 0; i < length; i++) {
    if (skip(i)) continue
    const at = HOOK_AT + from + i
    const was = rom.readAt(at, 1)![0]!
    rom.writeAt(at, [flip(was)])
    if (read(rom, fp).ok) out.push(from + i)
    rom.writeAt(at, [was])
  }
  return out
}

describe('readLevelGfxHook', () => {
  it("accepts both builds when they read PrepareGraphicsFile's own tables", () => {
    for (const loader of ['direct', 'stub'] as const) {
      const { rom, fp } = hooked(loader)
      expect(read(rom, fp)).toEqual({ ok: true })
    }
  })

  it("refuses a dispatcher naming tables other than PrepareGraphicsFile's own", () => {
    // Stock code that JSLs PrepareGraphicsFile directly would then read other files.
    const { rom, fp } = hooked('stub', [0x01a000, 0x01a032, 0x01a064])
    expect(read(rom, fp)).toEqual({
      ok: false,
      reason:
        "its dispatcher reads GFX tables at $01A000, $01A032, $01A064, not PrepareGraphicsFile's own",
    })
    // Each table on its own, so a check of fewer than all three goes red.
    const stock = [TABLE_LO, TABLE_HI, TABLE_BANK]
    for (let i = 0; i < 3; i++) {
      const one = hooked(
        'stub',
        stock.map((t, k) => (k === i ? t + 1 : t)),
      )
      expect(read(one.rom, one.fp).ok).toBe(false)
    }
  })

  it('refuses an unrecognized dispatcher, and one whose JML misses the decompression call', () => {
    const { rom, fp } = hooked('stub')
    expect(readLevelGfxHook(rom, HOOK_AT, PREPARE_GFX, TABLES, []).ok).toBe(false)
    rom.writeAt(HOOK_AT + HOOK_DISPATCHER + 0x63, [0x20])
    expect(read(rom, fp)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/decompression/),
    })
  })

  it('refuses the older build when its JSL targets anything but PrepareGraphicsFile', () => {
    const { rom, fp } = hooked('direct')
    rom.writeAt(HOOK_AT + HOOK_LOADER + 21, jsl(PREPARE_GFX + 1))
    expect(read(rom, fp).ok).toBe(false)
  })

  it('refuses on a flipped byte anywhere on the entry, the default path or either loader', () => {
    // Entry offset 5 is the sprite GFX loop's own branch, and the older
    // loader's 12 and 17 skip files $7F and $80 up: none is on the walked
    // path. 27 and 28 are the NOPs its BRA jumps over.
    expect(survivors('stub', 0, 13, i => i === 5)).toEqual([])
    expect(survivors('stub', HOOK_LANDING, 4)).toEqual([])
    expect(survivors('stub', HOOK_LOADER, 19)).toEqual([])
    const directSkip = (i: number): boolean => [12, 17, 27, 28].includes(i)
    expect(survivors('direct', 0, 13, i => i === 5)).toEqual([])
    expect(survivors('direct', HOOK_LOADER, 33, directSkip)).toEqual([])
  })

  it('refuses on a flipped byte anywhere in the dispatcher except the masked operands', () => {
    const masked = (i: number): boolean => MASKED.some(o => i >= o && i < o + 3)
    expect(survivors('stub', HOOK_DISPATCHER, DISPATCHER_BYTES, masked)).toEqual([])
    const bit7 = (b: number): number => b ^ 0x80
    const kept = (i: number): boolean => masked(i) || FOLDED.includes(i)
    expect(survivors('stub', HOOK_DISPATCHER, DISPATCHER_BYTES, kept, bit7)).toEqual([])
  })

  it('folds bank bit 7 of the FastROM operands, and only those', () => {
    const { rom, fp } = hooked('stub')
    for (const off of FOLDED) {
      const at = HOOK_AT + HOOK_DISPATCHER + off
      rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ 0x80])
    }
    rom.writeAt(PRIMARY_CALLER, jsl(HOOK_AT | 0x800000))
    const stub = HOOK_AT + HOOK_LOADER + 15
    rom.writeAt(stub, jsl(HOOK_AT + HOOK_DISPATCHER + 0x800000).slice(1))
    expect(read(rom, fp).ok).toBe(true)
  })
})

describe('readGfxPointerSites through the hook', () => {
  it('resolves both builds to the stock tables, and marks them hooked', () => {
    for (const loader of ['direct', 'stub'] as const) {
      const { rom, fp } = hooked(loader)
      expect(readGfxPointerSites(rom, [fp])).toMatchObject({ ...TABLES, hooked: true })
    }
    expect(readGfxPointerSites(buildCart().rom)?.hooked).toBe(false)
  })

  it('refuses an unrecognized hook with its reason', () => {
    const r = checkStockCompression(hooked('stub').rom)
    expect(r.ok ? '' : r.reason).toMatch(
      /targets \$019000.*dispatcher at \$019080 is not a recognized build/,
    )
  })
})

describe('GFX assignment mark', () => {
  function hookedStub(): RomFile {
    const rom = map16DecodeStub()
    plantGfxHook(rom, HOOK_AT, PREPARE_GFX, 'direct')
    rom.writeAt(PRIMARY_CALLER, jsl(HOOK_AT))
    return rom
  }
  function sheetNote(rom: RomFile): string | undefined {
    const r = decodeMap16Sheet(new SmwRom(rom), 0, 'fg', { bg: 0, fg: 0 })
    if (r.status !== 'ok') throw new Error(r.reason)
    return r.sheet.gfxAssignmentNote
  }

  it('marks the Map16 sheet drawn on a hooked ROM, naming both loops, and not a stock one', () => {
    expect(sheetNote(hookedStub())).toMatch(/FG\/BG and sprite GFX files.*Lunar Magic's list/)
    expect(sheetNote(map16DecodeStub())).toBeUndefined()
  })

  it('drops the mark once the ROM is written back to call PrepareGraphicsFile directly', () => {
    const rom = hookedStub()
    expect(levelGfxAssignmentNote(rom)).toBeDefined()
    rom.writeAt(PRIMARY_CALLER, jsl(PREPARE_GFX))
    expect(levelGfxAssignmentNote(rom)).toBeUndefined()
  })

  it("marks a ROM whose GFX loader can't be read, not only a recognized hook", () => {
    const { rom } = buildCart()
    rom.writeAt(PRIMARY_CALLER, jsl(0x008000))
    expect(levelGfxAssignmentNote(rom)).toMatch(/can't read how this ROM loads its GFX/)
    expect(levelGfxAssignmentNote(buildCart().rom)).toBeUndefined()
  })
})
