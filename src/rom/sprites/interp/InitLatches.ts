/**
 * InitLatches.ts -- WRAM cells a sprite's own INIT sets, which the level loader's image therefore already holds
 * when the map view re-runs that INIT (#998). The loader image is the state AFTER the placed sprite's INIT ran once;
 * to run the INIT again from the state BEFORE it, the cell is put back to its value from before. Data with
 * citations, keyed by sprite number. A row applies only when the cart's INIT pointer for that id is the vanilla one
 * AND the INIT's guard and latch-set bytes are fingerprint-identical (#1082), so a hack that repoints or edits the
 * handler keeps the loader image as it is (D51).
 */
import { fingerprint } from '../../Fingerprint'
import type { RomFile } from '../../RomFile'
import { bytesAt } from './Guards'
import type { SpriteSeed } from './SpriteSeed'

/** SHA-256 of `length` bytes read at `at`. */
export interface CodeFingerprint {
  at: number
  length: number
  sha256: string
}

export interface InitLatch {
  /** Low 16 bits of the vanilla INIT handler (bank $01), the key on the resolved pointer. */
  initPointer: number
  /** WRAM offset of the latch and the value it holds before the INIT runs. */
  cell: number
  before: number
  /** SHA-256 of `length` bytes read at `initPointer + at`: the latch's guard and its set. */
  code: readonly CodeFingerprint[]
  /**
   * The INIT places its own sprites at fixed positions of the level and ignores where the list put the sprite, so the
   * map view must not re-base the picture onto the placed spot (D134/D139-D) or move it with a drag.
   */
  absolute: boolean
  /** SMWDisX citation for the cell and the INIT that sets it. */
  why: string
}

export const INIT_LATCHES: Readonly<Record<number, InitLatch>> = {
  // InitBonusGame (bank_01.asm:12675) erases the sprite when DisableBonusSprite ($1B94, rammap.asm:1994) is nonzero
  // (12676-12679) and otherwise writes nine sprites to slots 9..1 at positions from DATA_01DD90/99 (12681-12707),
  // then INCs the latch (12719). The only write to the latch in the disassembly.
  0x82: {
    initPointer: 0xddac,
    cell: 0x1b94,
    before: 0,
    code: [
      {
        at: 0,
        length: 9,
        sha256: '9eb1b3ac84e6fca0a7ed7f0b4ff07296ddc58b26b5188fc6259f8bce5cdec15e',
      }, // guard: 12676-12679
      {
        at: 0x5e,
        length: 3,
        sha256: '3c5c0641795a6b9b071e3caf741c0ca09599bccaa370d8155ead7c7754e3d6e2',
      }, // latch set: 12719
    ],
    absolute: true,
    why: 'bank_01.asm:12676-12679, 12681-12707, 12719',
  },
}

/** The row for sprite `id` when this cart's INIT is the one it was read from; undefined otherwise. */
export function latchFor(
  rom: RomFile,
  id: number,
  initPointer: number,
  rows: Readonly<Record<number, InitLatch>> = INIT_LATCHES,
): InitLatch | undefined {
  const row = rows[id]
  if (!row || row.initPointer !== initPointer) return undefined
  const at = 0x010000 | row.initPointer
  const same = row.code.every(c => {
    const got = bytesAt(rom, at + c.at, c.length)
    return got !== null && fingerprint(Uint8Array.from(got)) === c.sha256
  })
  return same ? row : undefined
}

/**
 * The seed for one sprite's run: its loaded image with the sprite's latch put back. A copy; the shared loader image
 * is never written. The same seed back when there is no row, no loaded image, or the latch already holds its
 * before value.
 */
export function withoutInitLatches(seed: SpriteSeed, row: InitLatch | undefined): SpriteSeed {
  if (!row || !seed.loaded || seed.loaded[row.cell] === row.before) return seed
  const loaded = Uint8Array.from(seed.loaded)
  loaded[row.cell] = row.before
  return { ...seed, loaded }
}

/**
 * LoadNormalSprite up to the table read (bank_02.asm:5370-5377): `LDY SpriteMemorySetting`, then `LDX table,Y` whose
 * 2-byte operand follows. SHA-256 of those 11 bytes (#1082).
 */
const LOAD_NORMAL: CodeFingerprint = { at: 0x02a8dd, length: 11, sha256: 'de8308c357547354403b9adaa3c54f8a045c865c7392d33697d0eeb72ca5ce1e' } // prettier-ignore

/**
 * The slot the level loader puts a placed sprite in: `SpriteSlotMax[SpriteMemorySetting]`, the top of the downward
 * free-slot search (bank_02.asm:5377, 5400-5405; a normal sprite, none of the ReservedSprite ids is $82). The table's
 * address is read from the loader's own `LDX table,Y` operand, so a repointed table is followed; null when the loader is
 * not the recognised one or the table is unreadable. With earlier stream sprites in the top slots the search lands
 * lower; only the slot-0 outcome is read from the image, any other is assumed to be the top.
 * `loadNormal` is injectable so a synthetic cart can supply its own fingerprint.
 */
export function placedSlot(
  rom: RomFile,
  loaded: Uint8Array | undefined,
  loadNormal: CodeFingerprint = LOAD_NORMAL,
): number | null {
  // The INIT's spawn loop fills slots 9..1 and never slot 0 (bank_01.asm:12681-12707), so a live $82 in slot 0 is a
  // sprite the downward search placed there after earlier sprites took 9..1.
  if (loaded && loaded[0x14c8] === 8 && loaded[0x9e] === 0x82) return 0
  const head = bytesAt(rom, loadNormal.at, loadNormal.length)
  if (!loaded || !head || fingerprint(Uint8Array.from(head)) !== loadNormal.sha256) return null
  const operand = bytesAt(rom, loadNormal.at + loadNormal.length, 2)
  if (!operand) return null
  const slot = bytesAt(rom, 0x020000 | (operand[0]! | (operand[1]! << 8)), 0x13)?.[loaded[0x1692]!]
  return slot === undefined || slot > 11 ? null : slot
}
