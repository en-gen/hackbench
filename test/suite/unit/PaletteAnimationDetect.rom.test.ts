/**
 * Palette-animation detection swept across the whole ROM corpus.
 *
 * What the sweep shows, stated plainly so nobody reads more into a green run
 * than it carries:
 *
 *   - All six carts are byte-identical through the kernel and its three
 *     callers, so the derivation has to produce the same values on all six.
 *   - They are NOT identical on the approaches. Three hook the NMI vector
 *     with a trampoline, and one rewrites the overworld routine's head, so
 *     the corpus exercises both the follow-the-trampoline path and a real
 *     refusal. `OBSERVED` records each cart's measured outcome and why.
 *   - The remaining refusal shapes are exercised by patching each real cart
 *     in memory, including the two that leave the routine intact and cut the
 *     path to it.
 *
 * The derived values are checked against two authorities, never against
 * themselves: the disassembly, through `VANILLA_EXPECTED`, and a second
 * transcription of the kernel's indexing written here from the same ASM and
 * reading the operand bytes directly.
 *
 * Real ROMs are gitignored, so this suite is skipped rather than silently
 * green on a clone without them.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import {
  detectPaletteAnimation,
  findFlashKernels,
  PROBE_LEVEL_BLOCK_ENTRY,
  PROBE_LEVEL_TARGET,
  PROBE_NMI_VECTOR,
  PROBE_OW_CALL_SITE,
  PROBE_OW_FIRST_TARGET,
  PROBE_OW_SECOND_BASE,
  VANILLA_EXPECTED,
  type PaletteAnimContext,
} from '../../../src/rom/PaletteAnimationDetect'
import { loadPaletteAnimData } from '../../../src/rom/PaletteAnimationLoader'
import { loromToOffset } from '../../../src/rom/addressing'

const ROM_DIR = path.join(__dirname, '../../roms')
const romFiles = fs.existsSync(ROM_DIR)
  ? fs
      .readdirSync(ROM_DIR)
      .filter(f => /\.sfc$/i.test(f))
      .sort()
  : []

const has = (file: string): boolean => romFiles.includes(file)

const VANILLA = 'Super Mario World (USA).vanilla.sfc'
const HEADERED = 'Super Mario World (USA).magic.sfc'
const withVanilla = describe.skipIf(!has(VANILLA))
const withHeadered = describe.skipIf(!has(HEADERED) || !has(VANILLA))

const load = (file: string): RomFile => RomFile.load(path.join(ROM_DIR, file))

/** The same cart with bytes overwritten, as a patch would leave it. */
function patched(file: string, pokes: Record<number, number>): RomFile {
  const original = load(file)
  const bytes = Buffer.from(original.buffer)
  for (const [snes, byte] of Object.entries(pokes)) {
    bytes[loromToOffset(Number(snes), original.romSize, original.hasHeader)!] = byte
  }
  return new RomFile(file, bytes)
}

/** The kernel and its three callers, which every corpus cart shares. */
const ROUTINE_WINDOWS: [number, number][] = [
  [PROBE_LEVEL_BLOCK_ENTRY, 0x1e], // block entry through the kernel's RTS
  [0x00a50c, 0x15], // overworld callers through the JMP
]

function routineBytes(rom: RomFile): number[] {
  return ROUTINE_WINDOWS.flatMap(([addr, len]) => [...rom.readAt(addr, len)!])
}

/** `[cgramIdx, frameTableAddr]` per animated slot, or no reading at all. */
type Observed = Array<[number, number]> | 'unavailable'

/**
 * What each cart was MEASURED to animate, named cart by cart. Not a vanilla
 * number the edited carts are excused from: `Grand Poo World 2 1.1.sfc` is
 * recorded as unreadable on the overworld because it is, and the assertion
 * for it is that the detector says so with a reason rather than falling back.
 *
 * Addresses only. Frame colors are the cart's bytes and stay out of the repo.
 */
const OBSERVED: Record<string, { level: Observed; overworld: Observed; why: string }> = {
  'Super Mario World (USA).vanilla.sfc': {
    level: [[0x64, 0x00b60c]],
    overworld: [
      [0x6d, 0x00b60c],
      [0x7d, 0x00b61c],
    ],
    why: 'stock vector and routine',
  },
  'Super Mario World (USA).magic.sfc': {
    level: [[0x64, 0x00b60c]],
    overworld: [
      [0x6d, 0x00b60c],
      [0x7d, 0x00b61c],
    ],
    why: 'stock, copier header',
  },
  'Seven_Vanilla_Levels.sfc': {
    level: [[0x64, 0x00b60c]],
    overworld: [
      [0x6d, 0x00b60c],
      [0x7d, 0x00b61c],
    ],
    why: '$00FFEA hooked, trampolines JML straight back to the stock handler',
  },
  'GrandPooWorld_V1.2.sfc': {
    level: [[0x64, 0x00b60c]],
    overworld: [
      [0x6d, 0x00b60c],
      [0x7d, 0x00b61c],
    ],
    why: 'stock vector and routine',
  },
  'Grand Poo World 2 1.1.sfc': {
    level: [[0x64, 0x00b60c]],
    overworld: [
      [0x6d, 0x00b60c],
      [0x7d, 0x00b61c],
    ],
    why: 'trampolined NMI; overworld upload moved to $1BBE20 and its writes folded inline at $1BC0FA',
  },
  'Invictus 1.0.sfc': {
    level: [[0x64, 0x00b60c]],
    overworld: [
      [0x6d, 0x00b60c],
      [0x7d, 0x00b61c],
    ],
    why: '$00FFEA hooked, trampolines JML straight back to the stock handler',
  },
}

/** Assert one context against what this cart was measured to do. */
function expectObserved(context: PaletteAnimContext, observed: Observed, why: string): void {
  if (observed === 'unavailable') {
    expect(context.available, why).toBe(false)
    expect(context.targets).toEqual([])
    // Unreadable has to come with a reason, or it is indistinguishable from
    // "this cart animates nothing".
    expect(context.notes.join(' ').length, 'an unreadable context must say why').toBeGreaterThan(0)
    return
  }
  expect(context.available, why).toBe(true)
  expect(context.targets.map(t => [t.cgramIdx, t.tableAddr])).toEqual(observed)
}

/**
 * A second transcription of the kernel's indexing from bank_00.asm:4666-4677,
 * reading the operands at their own addresses. NOT an independent derivation:
 * it is the same ASM read twice, so it catches a wrong operand address, a
 * miscounted LSR run or a mis-ordered sequence, and would not catch a
 * misreading of the ASM itself.
 *
 * Deliberately written as a tick-by-tick walk rather than the module's
 * closed form, so the two do not share an expression that could be wrong in
 * the same way.
 */
function recomputeFromOperands(rom: RomFile): {
  offsets: number[]
  tableAddr: number
  colorsAt: (base: number) => number[]
} {
  const mask = rom.readByte(0x00a424)! // AND #imm operand
  let shift = 0
  while (rom.readByte(0x00a425 + shift) === 0x4a) shift++ // LSR A run
  const tableAddr = rom.readWord(0x00a42a)! // LDA abs,Y operand

  // Step the counter one tick at a time and record the index the kernel
  // would compute, keeping a value each time it changes, until it repeats.
  const offsets: number[] = []
  const at = (tick: number): number => (tick & mask) >>> shift
  for (let tick = 0; tick < 256; tick++) {
    if (tick > 0 && at(tick) === at(tick - 1)) continue
    if (tick > 0 && offsets.length > 0 && at(tick) === offsets[0] && repeatsFrom(at, tick, offsets))
      break
    offsets.push(at(tick))
  }
  return {
    offsets,
    tableAddr,
    colorsAt: base => offsets.map(o => rom.readWord(tableAddr + base + o)!),
  }
}

/** True once the walk has come back round to the start of its own sequence. */
function repeatsFrom(at: (t: number) => number, tick: number, seen: number[]): boolean {
  const stride = tick / seen.length
  if (!Number.isInteger(stride)) return false
  return seen.every((v, i) => at(tick + i * stride) === v)
}

/** True when `$00A4E3` still opens with the stock `REP #$10`. */
function usesStockOverworldRoute(rom: RomFile): boolean {
  return rom.readByte(0x00a4e3) === 0xc2 && rom.readByte(0x00a4e4) === 0x10
}

/** Properties any real animation has, none of which a constant would satisfy. */
function expectAnimates(context: PaletteAnimContext): void {
  expect(context.targets.length).toBeGreaterThan(0)
  for (const target of context.targets) {
    expect(target.colors).toHaveLength(target.phaseCount)
    expect(target.phaseCount).toBeGreaterThan(1)
    expect(target.frameStride).toBeGreaterThan(0)
    // A swatch the editor paints as cycling has to actually change.
    expect(new Set(target.colors).size).toBeGreaterThan(1)
  }
  expect(new Set(context.targets.map(t => t.cgramIdx)).size).toBe(context.targets.length)
}

describe('palette animation detection across the corpus', () => {
  it.skipIf(romFiles.length === 0)('is the corpus this suite was measured on', () => {
    const unmeasured = romFiles.filter(f => !(f in OBSERVED))
    expect(unmeasured, 'measure these carts and add an OBSERVED entry').toEqual([])
  })

  // Registered from OBSERVED rather than from what is on disk, so a missing
  // corpus skips a known number of cases instead of collecting none.
  for (const file of Object.keys(OBSERVED)) {
    describe.skipIf(!has(file) || !has(VANILLA))(file, () => {
      it('carries the stock kernel and callers byte for byte', () => {
        expect(routineBytes(load(file))).toEqual(routineBytes(load(VANILLA)))
      })

      it('animates the slots this cart was measured to animate', () => {
        const observed = OBSERVED[file]
        expect(observed, `${file} is unmeasured; add an OBSERVED entry`).toBeDefined()
        const d = detectPaletteAnimation(load(file))
        expectObserved(d.level, observed!.level, observed!.why)
        expectObserved(d.overworld, observed!.overworld, observed!.why)
      })

      it('agrees with an independent reading of the same operands', () => {
        const rom = load(file)
        const stockRoute = usesStockOverworldRoute(rom)
        const oracle = recomputeFromOperands(rom)
        const d = detectPaletteAnimation(rom)

        // The fixed operand addresses above are the bank-$00 kernel, which is
        // what the level path runs on every cart and what the overworld path
        // runs only on the stock route. Reading them for a relocated cart
        // would be reading bytes that never execute.
        const targets = stockRoute
          ? [...d.level.targets, ...d.overworld.targets]
          : [...d.level.targets]
        expect(targets.length).toBeGreaterThan(0)
        for (const target of targets) {
          expect(target.colors).toEqual(oracle.colorsAt(target.tableAddr - oracle.tableAddr))
          expect(target.phaseCount).toBe(oracle.offsets.length)
        }
        expect(d.level.targets[0]!.cgramIdx).toBe(rom.readByte(0x00a41b))

        if (!d.overworld.available) return
        if (!stockRoute) {
          // A relocated routine folds the index in immediately before the
          // write, so it is one byte back from the kernel the module names.
          for (const target of d.overworld.targets) {
            expect(target.cgramIdx).toBe(rom.readByte(target.kernelAddr - 1))
          }
          return
        }
        expect(d.overworld.targets[0]!.cgramIdx).toBe(rom.readByte(0x00a514))
        expect(d.overworld.targets[1]!.cgramIdx).toBe(rom.readByte(0x00a51d))
        expect(d.overworld.targets[1]!.tableAddr - d.overworld.targets[0]!.tableAddr).toBe(
          rom.readByte(0x00a519),
        )
      })

      it('animates something in every context it claims to read', () => {
        const rom = load(file)
        const d = detectPaletteAnimation(rom)
        for (const context of [d.level, d.overworld]) {
          if (!context.available) {
            expect(context.notes.join(' ').length).toBeGreaterThan(0)
            continue
          }
          expectAnimates(context)
          // Every reported kernel address is a real CGADD write, whether it
          // is a full kernel or a tail that reuses the previous one's index.
          for (const target of context.targets) {
            expect([...rom.readAt(target.kernelAddr, 3)!]).toEqual([0x8d, 0x21, 0x21])
          }
        }
      })

      // The failure this module exists to prevent, on a real cart: patch the
      // way a hack would and confirm the detector goes quiet rather than
      // reporting the stock index.
      it('reports unavailable, not $64, when the level probe is patched over', () => {
        const rom = patched(file, { [PROBE_LEVEL_TARGET]: 0x22 })
        const d = detectPaletteAnimation(rom)
        expect(d.level.available).toBe(false)
        expect(d.level.targets).toEqual([])
        expect(loadPaletteAnimData(rom, 'level')).toBeNull()
      })

      // Only meaningful where the stock in-bank callers are what runs. On a
      // cart that moved the routine out of bank $00 those bytes are dead, and
      // patching them correctly changes nothing.
      it('reports unavailable when an overworld probe is patched over', () => {
        if (!usesStockOverworldRoute(load(file))) {
          expect(
            detectPaletteAnimation(patched(file, { [PROBE_OW_FIRST_TARGET]: 0x22 })).overworld
              .available,
          ).toBe(true)
          return
        }
        for (const probe of [PROBE_OW_FIRST_TARGET, PROBE_OW_SECOND_BASE]) {
          const rom = patched(file, { [probe]: 0x22 })
          expect(detectPaletteAnimation(rom).overworld.available).toBe(false)
          expect(loadPaletteAnimData(rom, 'overworld')).toBeNull()
        }
      })

      // The shape the callee-side probes cannot see: routine intact, path to
      // it cut. Both carts below animate nothing and decode perfectly.
      it('reports unavailable when the NMI vector is redirected', () => {
        const rom = patched(file, { [PROBE_NMI_VECTOR]: 0x00, [PROBE_NMI_VECTOR + 1]: 0x90 })
        const d = detectPaletteAnimation(rom)
        expect(d.level.available).toBe(false)
        expect(d.overworld.available).toBe(false)
        expect(loadPaletteAnimData(rom, 'level')).toBeNull()
        expect(loadPaletteAnimData(rom, 'overworld')).toBeNull()
      })

      it('reports unavailable when the level block entry is short-circuited', () => {
        // RTS / NOP over the SEP #$20: the target two bytes later is
        // untouched and never executes.
        const rom = patched(file, {
          [PROBE_LEVEL_BLOCK_ENTRY]: 0x60,
          [PROBE_LEVEL_BLOCK_ENTRY + 1]: 0xea,
        })
        expect(rom.readByte(PROBE_LEVEL_TARGET)).toBe(0xa9)
        const d = detectPaletteAnimation(rom)
        expect(d.level.available).toBe(false)
        expect(d.level.targets).toEqual([])
        expect(d.overworld.available).toBe(OBSERVED[file]!.overworld !== 'unavailable')
      })

      it('reports unavailable when the overworld arm calls elsewhere', () => {
        const rom = patched(file, {
          [PROBE_OW_CALL_SITE + 1]: 0x00,
          [PROBE_OW_CALL_SITE + 2]: 0x90,
        })
        const d = detectPaletteAnimation(rom)
        expect(d.overworld.available).toBe(false)
        expect(d.level.available).toBe(true)
      })
    })
  }
})

withVanilla('vanilla, derived rather than asserted', () => {
  const rom = (): RomFile => load(VANILLA)

  it('level animates one index, the one its LDA #imm carries', () => {
    const level = detectPaletteAnimation(rom()).level
    expect(level.available).toBe(true)
    expect(level.targets.map(t => t.cgramIdx)).toEqual([VANILLA_EXPECTED.levelCgramIdx])
  })

  it('overworld animates two indices, from the same kernel', () => {
    const ow = detectPaletteAnimation(rom()).overworld
    expect(ow.available).toBe(true)
    expect(ow.targets.map(t => t.cgramIdx)).toEqual([...VANILLA_EXPECTED.overworldCgramIdx])
    expect(new Set(ow.targets.map(t => t.kernelAddr)).size).toBe(1)
  })

  it('the frame tables are where the LDA abs,Y operands point', () => {
    const d = detectPaletteAnimation(rom())
    expect(d.level.targets[0]!.tableAddr).toBe(VANILLA_EXPECTED.frameTableAddr)
    expect(d.overworld.targets[0]!.tableAddr).toBe(VANILLA_EXPECTED.frameTableAddr)
    // The second overworld target's base is the caller's own `LDA #$10`.
    expect(d.overworld.targets[1]!.tableAddr).toBe(VANILLA_EXPECTED.frameTableAddr + 0x10)
  })

  it('the phase count and stride come from the mask and the LSR run', () => {
    const d = detectPaletteAnimation(rom())
    for (const target of [...d.level.targets, ...d.overworld.targets]) {
      expect(target.phaseCount).toBe(VANILLA_EXPECTED.phaseCount)
      expect(target.frameStride).toBe(VANILLA_EXPECTED.frameStride)
    }
  })

  it('the level and first overworld target share one 16-byte frame run', () => {
    const d = detectPaletteAnimation(rom())
    expect(d.overworld.targets[0]!.colors).toEqual(d.level.targets[0]!.colors)
    expect(d.overworld.targets[1]!.colors).not.toEqual(d.level.targets[0]!.colors)
  })

  it('the flash kernel pattern is unique in this cart', () => {
    expect(findFlashKernels(rom())).toHaveLength(1)
  })
})

withHeadered('a copier header does not move the answer', () => {
  it('matches the unheadered cart target for target', () => {
    const plain = detectPaletteAnimation(load(VANILLA))
    const headered = detectPaletteAnimation(load(HEADERED))
    expect(headered.level).toEqual(plain.level)
    expect(headered.overworld).toEqual(plain.overworld)
    expect(findFlashKernels(load(HEADERED))).toEqual(findFlashKernels(load(VANILLA)))
  })
})
