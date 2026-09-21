/**
 * Which shared draw routine a sprite's handler reaches, read from the cart.
 *
 * SMW draws most sprites through three shared routines: `SubSprGfx0` (four
 * independent 8x8 chars), `SubSprGfx1` (two stacked 16x16 big-tiles) and
 * `SubSprGfx2` (one 16x16 big-tile). Which one a sprite uses decides its
 * layout, and `SpriteTileLoader` used to carry that classification as a
 * frozen table extracted by hand.
 *
 * This resolves it live instead: resolve the handler (through the bank-3
 * dispatch chain where the MAIN pointer is a stub), walk it, and see which
 * of the six shared entry points it reaches. Where it reaches two, look for
 * the branch that chooses between them and read the ROM byte that branch
 * tests.
 *
 * What it does NOT do is guess. A handler whose draw call sits behind a
 * computed jump reports `unreached`, and the caller keeps whatever it had.
 *
 * Evidence scope: 57 of the 84 ids below $54 resolve on five of the six
 * carts in `test/roms/` and 56 on Grand Poo World 2 1.1; every resolution
 * agrees with the frozen table it replaces, on all six. Static reads only;
 * no emulator was run. Measurements and method in
 * `docs/sprite-gfx-routine-reading.md`.
 */

import type { RomFile } from '../RomFile'
import { resolveDispatch } from './DispatchChain'
import { SPRITE_PTR_TABLE_COUNT } from './SpritePointerTables'
import { walkHandler, type AccumulatorSource, type WalkStop } from './HandlerWalk'

export type GfxRoutine = 'sub0' | 'sub1' | 'sub2'

/**
 * The six shared entry points, plus the three bank-switching trampolines
 * every caller outside bank $01 goes through. Grepping for `JSR SubSprGfx`
 * undercounts by roughly a third because of those trampolines.
 *
 * Addresses, not derivations: a hack that relocates one of these routines
 * makes the walk report `unreached`, which is the safe direction. All nine
 * labels checked in `SMWDisX/bank_01.asm` at the cited line.
 */
const SHARED_ROUTINES: ReadonlyArray<readonly [number, GfxRoutine, string]> = [
  [0x019cf3, 'sub0', 'SubSprGfx0Entry0 bank_01.asm:3853'],
  [0x019cf5, 'sub0', 'SubSprGfx0Entry1 bank_01.asm:3855'],
  [0x019d67, 'sub1', 'SubSprGfx1 bank_01.asm:3920'],
  [0x019f09, 'sub2', 'SubSprGfx2Entry0 bank_01.asm:4144'],
  [0x019f0d, 'sub2', 'SubSprGfx2Entry1 bank_01.asm:4148'],
  [0x018042, 'sub0', 'GenericSprGfxRt0 bank_01.asm:61'],
  [0x019d5f, 'sub1', 'GenericSprGfxRt1 bank_01.asm:3912'],
  [0x0190b2, 'sub2', 'GenericSprGfxRt2 bank_01.asm:2393'],
]

const WATCH: ReadonlyMap<number, string> = new Map(
  SHARED_ROUTINES.map(([addr, routine]) => [addr, routine]),
)

/** Where the code that draws a sprite was found, and how. */
export interface HandlerSite {
  readonly at: number
  /** `direct` - the MAIN pointer is the handler. `dispatched` - a chain link
   *  claimed this id. `stubBody` - the pointer is a stub whose target is not
   *  a chain, so one body serves every id behind it. `fallthrough` - no link
   *  claimed the id and this is the chain's tail block. */
  readonly via: 'direct' | 'dispatched' | 'stubBody' | 'fallthrough'
}

/** The branch that picks between two routines, and the byte it tests. */
export interface RoutineSelect {
  readonly at: number
  readonly table: number
  readonly mask: number
  readonly whenSet: GfxRoutine
  readonly whenClear: GfxRoutine
}

export type GfxRoutineReading =
  /** Exactly one shared routine is reachable. */
  | {
      readonly kind: 'read'
      readonly routine: GfxRoutine
      readonly site: HandlerSite
      readonly callAt: number
      /** For `sub0` only: the `GeneralSprGfxProp` row the handler passes
       *  in the accumulator. `SubSprGfx0Entry1` (bank_01.asm:3855) reads
       *  A as `_5` and indexes row `_5 * 4`. Present when the call is
       *  immediately preceded by `LDA #imm`, absent otherwise. */
      readonly propGroup?: number
    }
  /** Two are, and a readable branch on a per-sprite ROM byte chooses. */
  | {
      readonly kind: 'selected'
      readonly routine: GfxRoutine
      readonly site: HandlerSite
      readonly select: RoutineSelect
    }
  /** Two or more are reachable with no branch this reader can attribute.
   *  Sprites that draw several parts through different routines land here. */
  | {
      readonly kind: 'ambiguous'
      readonly routines: readonly GfxRoutine[]
      readonly site: HandlerSite
    }
  /** None is reachable within the walk's budget. */
  | { readonly kind: 'unreached'; readonly stops: readonly WalkStop[]; readonly site: HandlerSite }
  /** The MAIN pointer could not be read at all. */
  | { readonly kind: 'noHandler' }

/** Where to start walking for `spriteId`, following the chain if there is one. */
export function resolveHandlerSite(rom: RomFile, spriteId: number): HandlerSite | null {
  const d = resolveDispatch(rom, spriteId)
  switch (d.kind) {
    case 'direct':
      return { at: d.handler, via: 'direct' }
    case 'dispatched':
      return { at: d.handler, via: 'dispatched' }
    case 'fallthrough':
      return { at: d.at, via: 'fallthrough' }
    // The chain grammar refused, but the stub's own target is still real
    // code shared by every id behind that stub. Walking it is honest as
    // long as nothing claims the result is id-specific.
    case 'chainRefused':
      return { at: d.thunk.target, via: 'stubBody' }
    case 'unreadable':
      return null
  }
}

function isSpriteNumberBitTest(
  a: AccumulatorSource,
): a is Extract<AccumulatorSource, { kind: 'tableBitTest' }> {
  return a.kind === 'tableBitTest' && a.bySpriteNumber
}

/** What draws `spriteId` on the open cart. */
export function readGfxRoutine(rom: RomFile, spriteId: number): GfxRoutineReading {
  const site = resolveHandlerSite(rom, spriteId)
  if (!site) return { kind: 'noHandler' }

  const walk = walkHandler(rom, site.at, { watch: WATCH })
  const routines = [...walk.reached.keys()] as GfxRoutine[]

  if (routines.length === 1) {
    const call = walk.reached.get(routines[0])!
    // From the decoder, which already knows whether A holds an immediate,
    // rather than from the two bytes in front of the call. Byte-matching
    // `A9 xx` there reads the tail of any three-byte instruction whose
    // middle operand byte is $A9 - `LDA $07A9` plants one - and invents a
    // row number that then beats the correct frozen one.
    const acc = call.accumulator
    const propGroup = routines[0] === 'sub0' && acc.kind === 'immediate' ? acc.value : undefined
    return { kind: 'read', routine: routines[0], site, callAt: call.at, propGroup }
  }
  if (routines.length === 0) {
    return { kind: 'unreached', stops: [...walk.stops], site }
  }

  for (const branch of walk.branches) {
    if (!isSpriteNumberBitTest(branch.accumulator)) continue
    // Cutting each side at the other's entry keeps a path that rejoins from
    // reporting both routines and defeating the split.
    const notTaken = walkHandler(rom, branch.notTakenAt, {
      watch: WATCH,
      blocked: new Set([branch.takenAt]),
    })
    const taken = walkHandler(rom, branch.takenAt, {
      watch: WATCH,
      blocked: new Set([branch.notTakenAt]),
    })
    const a = [...notTaken.reached.keys()] as GfxRoutine[]
    const b = [...taken.reached.keys()] as GfxRoutine[]
    if (a.length !== 1 || b.length !== 1 || a[0] === b[0]) continue

    const { table, mask } = branch.accumulator
    const byte = rom.readByte(table + spriteId)
    if (byte === null) continue
    // `BNE`/`BEQ` polarity: 0xD0 takes the branch when the mask cleared
    // nothing, 0xF0 when it cleared everything.
    const op = rom.readByte(branch.at)
    if (op !== 0xd0 && op !== 0xf0) continue
    const setGoes = op === 0xd0 ? b[0] : a[0]
    const clearGoes = op === 0xd0 ? a[0] : b[0]
    return {
      kind: 'selected',
      routine: (byte & mask) !== 0 ? setGoes : clearGoes,
      site,
      select: { at: branch.at, table, mask, whenSet: setGoes, whenClear: clearGoes },
    }
  }

  return { kind: 'ambiguous', routines, site }
}

/**
 * Read every id in the MAIN pointer table once.
 *
 * Cached per cart. The walk costs about 22 ms for 84 ids and a map build
 * re-reads the tables on every toolbar change, which made this the largest
 * single term in the build. `RomFile.version` is the invalidation: it moves
 * on every `writeAt`, so a test that plants a byte gets a fresh read.
 */
const routineCache = new WeakMap<
  RomFile,
  { version: number; count: number; routines: Map<number, GfxRoutineReading> }
>()

export function readGfxRoutines(
  rom: RomFile,
  count = SPRITE_PTR_TABLE_COUNT,
): Map<number, GfxRoutineReading> {
  const hit = routineCache.get(rom)
  if (hit && hit.version === rom.version && hit.count === count) return hit.routines
  const out = new Map<number, GfxRoutineReading>()
  for (let id = 0; id < count; id++) out.set(id, readGfxRoutine(rom, id))
  routineCache.set(rom, { version: rom.version, count, routines: out })
  return out
}

/** The `GeneralSprGfxProp` row a `sub0` reading names, or null. */
export function decidedPropGroup(r: GfxRoutineReading | undefined): number | null {
  return r && r.kind === 'read' && r.propGroup !== undefined ? r.propGroup : null
}

/** The routine a reading settles on, or null when it settles on nothing. */
export function decidedRoutine(r: GfxRoutineReading | undefined): GfxRoutine | null {
  if (!r) return null
  return r.kind === 'read' || r.kind === 'selected' ? r.routine : null
}

/** One line for a tooltip or a warning. */
export function gfxRoutineMessage(r: GfxRoutineReading): string {
  const hex = (n: number) => `$${n.toString(16).toUpperCase().padStart(6, '0')}`
  switch (r.kind) {
    case 'read':
      return `${r.routine} via the call at ${hex(r.callAt)} in the ${r.site.via} handler ${hex(r.site.at)}`
    case 'selected':
      return (
        `${r.routine}, chosen by the branch at ${hex(r.select.at)} on ` +
        `${hex(r.select.table)} & $${r.select.mask.toString(16).toUpperCase()} ` +
        `(set: ${r.select.whenSet}, clear: ${r.select.whenClear})`
      )
    case 'ambiguous':
      return `handler ${hex(r.site.at)} reaches ${r.routines.join(' and ')} with no readable choice between them`
    case 'unreached':
      return (
        `handler ${hex(r.site.at)} reaches no shared draw routine ` +
        `(${r.stops.length ? r.stops.join(', ') : 'no call found'})`
      )
    case 'noHandler':
      return 'handler pointer unreadable'
  }
}
