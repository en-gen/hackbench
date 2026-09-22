/**
 * WorkingRom: the base cartridge with an append-only stack of edit layers
 * applied in order. See docs/glossary.md, "Working copy".
 */
import { describe, it, expect } from 'vitest'
import { WorkingRom, Layer } from '../../../src/project/WorkingRom'
import { loromToOffset } from '../../../src/rom/addressing'

/** Cheap whole-buffer equality: `toEqual` on a large typed array is a
 *  slow, generic per-element deep-equal that can blow the test timeout
 *  under full-suite CPU contention even though it is instant standalone. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return (
    Buffer.compare(
      Buffer.from(a.buffer, a.byteOffset, a.length),
      Buffer.from(b.buffer, b.byteOffset, b.length),
    ) === 0
  )
}

const ROM_SIZE = 0x4000

function fakeRom(size = ROM_SIZE): Uint8Array {
  const rom = new Uint8Array(size)
  for (let i = 0; i < size; i++) rom[i] = (i * 31) & 0xff
  return rom
}

/** Mario's red, per the acceptance test: $00B2CE, vanilla word $391F. */
const MARIO_RED_ADDR = 0x00b2ce
const MARIO_RED_OLD = '$391F'

function withWordAt(rom: Uint8Array, snesAddr: number, word: number): Uint8Array {
  const offset = loromToOffset(snesAddr, rom.length, false) as number
  const out = new Uint8Array(rom)
  out[offset] = word & 0xff
  out[offset + 1] = (word >> 8) & 0xff
  return out
}

function editLayer(id: string, address: string, old: string, next: string): Layer {
  return { id, label: id, scope: 'edit', ops: [{ address, old, new: next }] }
}

describe('WorkingRom', () => {
  it('bytes() with no layers is byte-identical to the base', () => {
    const base = fakeRom()
    const working = new WorkingRom(base, false)
    expect(sameBytes(working.bytes(), base)).toBe(true)
    expect(working.bytes()).not.toBe(base) // never hand back the mutable base itself
  })

  it('an appended layer writes its word little-endian, masked to 15 bits', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    working.append(editLayer('L1', '$00B2CE', MARIO_RED_OLD, '$83E0')) // top bit set on purpose

    const offset = loromToOffset(MARIO_RED_ADDR, base.length, false) as number
    const bytes = working.bytes()
    // 0x83E0 & 0x7FFF = 0x03E0 -> lo $E0, hi $03
    expect(bytes[offset]).toBe(0xe0)
    expect(bytes[offset + 1]).toBe(0x03)
  })

  it('layers apply sequentially: a later layer sees the earlier layer\'s result as "old"', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    working.append(editLayer('L1', '$00B2CE', '$391F', '$03E0'))
    working.append(editLayer('L2', '$00B2CE', '$03E0', '$7C00')) // must match L1's OUTPUT, not the base
    const offset = loromToOffset(MARIO_RED_ADDR, base.length, false) as number
    const bytes = working.bytes()
    expect(bytes[offset] | (bytes[offset + 1] << 8)).toBe(0x7c00)
  })

  it('refuses a layer whose "old" no longer matches the current working copy', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    working.append(editLayer('L1', '$00B2CE', '$391F', '$03E0'))
    expect(() => working.append(editLayer('L2', '$00B2CE', '$391F', '$7C00'))).toThrow(/stale/i)
    // The rejected layer never joined the stack.
    expect(working.stack.length).toBe(1)
  })

  it('rejects a "new" value outside 0..0xFFFF rather than truncating it', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    expect(() => working.append(editLayer('L1', '$00B2CE', '$391F', '$1FFFF'))).toThrow()
  })

  /**
   * Every real cartridge's palette words have bit 15 clear (checked across
   * five carts), so this path is only reachable through a hand-edited ops
   * file - but nothing else here proves the `old` comparison actually masks
   * with 0x7FFF rather than comparing raw words, which would make a
   * perfectly valid `old` refuse as stale whenever bit 15 happened to be set
   * in the raw stored bytes.
   */
  it('the "old" comparison masks bit 15: a stored word with it set still matches an "old" given without it', () => {
    // Raw stored bytes $1F,$B9 -> word $B91F, bit 15 SET. Masked, $391F.
    const base = fakeRom()
    const offset = loromToOffset(MARIO_RED_ADDR, base.length, false) as number
    base[offset] = 0x1f
    base[offset + 1] = 0xb9
    const working = new WorkingRom(base, false)
    expect(() => working.append(editLayer('L1', '$00B2CE', '$391F', '$03E0'))).not.toThrow()
    const bytes = working.bytes()
    expect(bytes[offset] | (bytes[offset + 1] << 8)).toBe(0x03e0)
  })

  it('pop removes the top layer and reverts bytes() to the prior state', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    working.append(editLayer('L1', '$00B2CE', '$391F', '$03E0'))
    const popped = working.pop()
    expect(popped?.id).toBe('L1')
    expect(sameBytes(working.bytes(), base)).toBe(true)
  })

  it('bytes() is cached until the next append/pop', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    const a = working.bytes()
    const b = working.bytes()
    expect(a).toBe(b) // same reference: not recomputed
    working.append(editLayer('L1', '$00B2CE', '$391F', '$03E0'))
    expect(working.bytes()).not.toBe(a)
  })

  /**
   * Characterizes a real, intentional trade-off rather than guarding
   * against it: `bytes()` hands out the live cached array, not a copy, so
   * this mutation is visible on the next call too. Recomputing (or
   * defensively cloning) a multi-megabyte cartridge on every `bytes()` call
   * is the cost this is avoiding - see `bytes()`'s own docstring. Every
   * real caller already copies before use (`Buffer.from(working.bytes())`),
   * which is the contract this test exists to keep honest, not a bug to fix
   * by making `bytes()` itself defensive.
   */
  it('bytes() returns the live cache by reference, not a copy - mutating it is visible on the next call', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    const offset = loromToOffset(MARIO_RED_ADDR, base.length, false) as number

    working.bytes()[offset] = 0xaa
    expect(working.bytes()[offset]).toBe(0xaa)
  })

  it('onDidChange fires on append and on pop, carrying the layer that changed', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    const seen: Array<{ kind: string; layerId: string }> = []
    const unsubscribe = working.onDidChange(c => seen.push({ kind: c.kind, layerId: c.layer.id }))
    working.append(editLayer('L1', '$00B2CE', '$391F', '$03E0'))
    working.pop()
    expect(seen).toEqual([
      { kind: 'append', layerId: 'L1' },
      { kind: 'pop', layerId: 'L1' },
    ])
    unsubscribe()
    working.append(editLayer('L2', '$00B2CE', '$391F', '$03E0'))
    expect(seen).toHaveLength(2) // unsubscribed: no further notification
  })

  it('a handler sees the POST-change bytes and fires exactly once per change', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    const offset = loromToOffset(MARIO_RED_ADDR, base.length, false) as number

    let calls = 0
    let seenWord = -1
    working.onDidChange(() => {
      calls++
      const bytes = working.bytes() // re-entrant call: must not trigger a second notification
      seenWord = bytes[offset] | (bytes[offset + 1] << 8)
    })

    working.append(editLayer('L1', '$00B2CE', '$391F', '$03E0'))
    expect(calls).toBe(1) // calling bytes() from inside the handler did not re-fire it
    expect(seenWord).toBe(0x03e0) // and it saw the NEW value, not the pre-change one

    working.pop()
    expect(calls).toBe(2)
  })

  it('exportableBytes() skips preview layers; bytes() includes them', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    working.append({
      id: 'preview',
      label: 'preview',
      scope: 'preview',
      ops: [{ address: '$00B2CE', old: '$391F', new: '$7C00' }],
    })
    const offset = loromToOffset(MARIO_RED_ADDR, base.length, false) as number

    const live = working.bytes()
    expect(live[offset] | (live[offset + 1] << 8)).toBe(0x7c00)

    const exportable = working.exportableBytes()
    expect(exportable[offset] | (exportable[offset + 1] << 8)).toBe(0x391f) // base, preview excluded
  })

  it('baseBytes() never changes across edits', () => {
    const base = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const working = new WorkingRom(base, false)
    working.append(editLayer('L1', '$00B2CE', '$391F', '$03E0'))
    expect(sameBytes(working.baseBytes(), base)).toBe(true)
  })

  it('a copier-header cartridge writes at the header-shifted offset', () => {
    const HEADER = 512
    const cart = withWordAt(fakeRom(), MARIO_RED_ADDR, 0x391f)
    const headered = new Uint8Array(cart.length + HEADER)
    headered.set(cart, HEADER)
    const working = new WorkingRom(headered, true)
    working.append(editLayer('L1', '$00B2CE', '$391F', '$03E0'))

    const offset = loromToOffset(MARIO_RED_ADDR, cart.length, true) as number
    const bytes = working.bytes()
    expect(bytes[offset] | (bytes[offset + 1] << 8)).toBe(0x03e0)
    // And the unshifted cart-relative offset is untouched proof the shift is real.
    const unshifted = loromToOffset(MARIO_RED_ADDR, cart.length, false) as number
    expect(offset).toBe(unshifted + HEADER)
  })
})
