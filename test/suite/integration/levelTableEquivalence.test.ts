/**
 * Proves LevelTableGate resolves the addresses bank_05.asm names, on real
 * ROMs: VerticalTable's content is compared against an INDEPENDENT second
 * read of the same known address, never against committed table content
 * (docs/testing.md forbids that), and the sprite site is compared against
 * the vanilla address and bank as committed constants -- addresses are a
 * structural fact about the ROM, not content.
 */
import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  readSpritePointerSite,
  readVerticalTable,
  VERTICAL_TABLE_LENGTH,
} from '../../../src/rom/LevelTableGate'
import { VANILLA, MAGIC, hasRom, romPath } from '../support/corpus'

// bank_05.asm:552 (VerticalTable) and :8708 (Ptrs05EC00, bank $07 fixed).
const VERTICAL_TABLE_ADDR = 0x058417
const SPRITE_TABLE_ADDR = 0x05ec00
const SPRITE_BANK = 0x07

describe.skipIf(!hasRom(VANILLA) || !hasRom(MAGIC))(
  'LevelTableGate resolves the vanilla addresses',
  () => {
    for (const name of [VANILLA, MAGIC]) {
      it(`${name}: VerticalTable and the sprite site resolve to their vanilla addresses`, () => {
        const smw = SmwRom.open(romPath(name))
        const vt = readVerticalTable(smw.rom)
        const spr = readSpritePointerSite(smw.rom)

        expect(vt.ok).toBe(true)
        if (vt.ok) {
          // An independent second read of the same address: if the gate had
          // resolved the wrong one, this would disagree with it.
          const direct = smw.rom.readAt(VERTICAL_TABLE_ADDR, VERTICAL_TABLE_LENGTH)
          expect(vt.table).toEqual(Array.from(direct!))
        }

        expect(spr).toEqual({
          ok: true,
          tableAddr: SPRITE_TABLE_ADDR,
          bank: { kind: 'fixed', bank: SPRITE_BANK },
        })
      })
    }
  },
)
