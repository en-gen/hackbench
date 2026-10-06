/**
 * The collision probe refuses a cart whose two collision entries are not the
 * shape it was written against, naming the entry (#647 review). Synthetic cart:
 * the level loader's shapes are intact, only the collision entries differ.
 */
import { describe, expect, it } from 'vitest'
import { Refusal } from '../../../../src/rom/cpu/call'
import { Probe } from '../../../../spikes/collision-probe/engine'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

// First opcodes of CODE_00EAA6 (STZ abs, STZ dp, ...) and CODE_00EADB (LDA dp, AND #$0F, STA dp), SMWDisX bank_00.asm:11921, 11952.
const RESET = [0x9c, 0x00, 0x00, 0x64, 0x00]
const COLLIDE = [0xa5, 0x00, 0x29, 0x0f, 0x85]

function cart(reset: number[], collide: number[]) {
  const rom = buildSyntheticRom()
  rom.writeAt(0x00eaa6, reset)
  rom.writeAt(0x00eadb, collide)
  return rom
}

describe('collision probe entry shapes', () => {
  it('a cart with both entries in shape is accepted', () => {
    expect(() => new Probe(cart(RESET, COLLIDE), 0x105)).not.toThrow()
  })
  it('a wrong opcode at the reset entry is refused, naming it', () => {
    const bad = [0xea, ...RESET.slice(1)]
    expect(() => new Probe(cart(bad, COLLIDE), 0x105)).toThrow(Refusal)
    expect(() => new Probe(cart(bad, COLLIDE), 0x105)).toThrow(/CODE_00EAA6.*\$00EAA6/)
  })
  it('a wrong opcode at the collide entry is refused, naming it', () => {
    const bad = [0xea, ...COLLIDE.slice(1)]
    expect(() => new Probe(cart(RESET, bad), 0x105)).toThrow(/CODE_00EADB.*\$00EADB/)
  })
})
