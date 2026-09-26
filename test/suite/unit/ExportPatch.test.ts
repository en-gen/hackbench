/**
 * Exporting a WorkingRom's edits as a real patch file, BPS by default or IPS.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { exportPatch, EXPORT_DIR } from '../../../src/project/ExportPatch'
import { WorkingRom } from '../../../src/project/WorkingRom'
import { decodeIps, encodeIps } from '../../../src/rom/Ips'
import { applyBps } from '../../../src/rom/Bps'
import { applyPatches } from '../../../src/rom/PatchLayer'
import { COPIER_HEADER_SIZE, loromToOffset } from '../../../src/rom/addressing'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-export-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function fakeRom(size = 0x80000): Uint8Array {
  const rom = new Uint8Array(size)
  for (let i = 0; i < size; i++) rom[i] = (i * 31) & 0xff
  return rom
}

const MARIO_RED_ADDR = 0x00b2ce

describe('exportPatch as IPS (unchanged behavior)', () => {
  it('writes an .ips under <project>/export/ that reproduces the edit', () => {
    const base = fakeRom()
    const offset = loromToOffset(MARIO_RED_ADDR, base.length, false) as number
    base[offset] = 0x1f
    base[offset + 1] = 0x39 // $391F, little-endian

    const working = new WorkingRom(base, false)
    working.append({
      id: 'L1',
      label: 'set red',
      scope: 'edit',
      ops: [{ address: '$00B2CE', old: '$391F', new: '$03E0' }],
    })

    const result = exportPatch(tmp, 'MyHack', working, 'ips')
    expect(result.format).toBe('ips')
    expect(result.path).toBe(path.join(tmp, EXPORT_DIR, 'MyHack.ips'))
    expect(fs.existsSync(result.path)).toBe(true)
    expect(result.hasCopierHeader).toBe(false)
    expect(result.opCount).toBeGreaterThan(0)

    const ipsBytes = fs.readFileSync(result.path)
    const patches = decodeIps(new Uint8Array(ipsBytes))
    expect(patches).not.toBeNull()
    const patched = applyPatches(base, patches!)
    expect(patched[offset]).toBe(0xe0)
    expect(patched[offset + 1]).toBe(0x03)

    // Everything else is untouched: the diff is exactly the 2 changed bytes,
    // not a wholesale re-encode of the ROM.
    expect(patches!.length).toBe(2)
  })

  it("reports the base cartridge's copier header", () => {
    const HEADER = 512
    const cart = fakeRom()
    const offset = (loromToOffset(MARIO_RED_ADDR, cart.length, true) as number) - HEADER
    // place bytes such that the headered offset resolves correctly below
    const headered = new Uint8Array(cart.length + HEADER)
    headered.set(cart, HEADER)
    headered[offset + HEADER] = 0x1f
    headered[offset + HEADER + 1] = 0x39

    const working = new WorkingRom(headered, true)
    working.append({
      id: 'L1',
      label: 'set red',
      scope: 'edit',
      ops: [{ address: '$00B2CE', old: '$391F', new: '$03E0' }],
    })

    const result = exportPatch(tmp, 'Headered', working, 'ips')
    expect(result.hasCopierHeader).toBe(true)
  })

  it('sanity: encodeIps/decodeIps still round-trip (regression guard for the diff path)', () => {
    const patches = [{ offset: 10, value: 0xab }]
    expect(decodeIps(encodeIps(patches))).toEqual(patches)
  })
})

describe('exportPatch as BPS (the default)', () => {
  it('defaults to .bps and reproduces the edit when applied back to the base', () => {
    const base = fakeRom()
    const offset = loromToOffset(MARIO_RED_ADDR, base.length, false) as number
    base[offset] = 0x1f
    base[offset + 1] = 0x39

    const working = new WorkingRom(base, false)
    working.append({
      id: 'L1',
      label: 'set red',
      scope: 'edit',
      ops: [{ address: '$00B2CE', old: '$391F', new: '$03E0' }],
    })

    const result = exportPatch(tmp, 'MyHack', working)
    expect(result.format).toBe('bps')
    expect(result.path).toBe(path.join(tmp, EXPORT_DIR, 'MyHack.bps'))
    expect(result.opCount).toBe(2)

    const bpsBytes = new Uint8Array(fs.readFileSync(result.path))
    expect(Array.from(bpsBytes.slice(0, 4))).toEqual([0x42, 0x50, 0x53, 0x31]) // "BPS1"

    const applied = applyBps(base, bpsBytes)
    expect(applied.ok).toBe(true)
    expect(applied.ok && applied.bytes[offset]).toBe(0xe0)
    expect(applied.ok && applied.bytes[offset + 1]).toBe(0x03)
  })

  // SMW Central expects an unheadered ROM, so a headered project's BPS must
  // be byte-identical to the same edit exported from an unheadered one.
  it('a headered and an unheadered base of the same ROM export identical BPS', () => {
    const cart = fakeRom()
    const headered = new Uint8Array(cart.length + COPIER_HEADER_SIZE)
    headered.set(cart, COPIER_HEADER_SIZE)

    const edit = { address: '$00B2CE', old: '$391F', new: '$03E0' }
    const unheaderedOffset = loromToOffset(MARIO_RED_ADDR, cart.length, false) as number
    cart[unheaderedOffset] = 0x1f
    cart[unheaderedOffset + 1] = 0x39
    const headeredOffset = loromToOffset(MARIO_RED_ADDR, cart.length, true) as number
    headered[headeredOffset] = 0x1f
    headered[headeredOffset + 1] = 0x39

    const plain = new WorkingRom(cart, false)
    plain.append({ id: 'L1', label: 'set red', scope: 'edit', ops: [edit] })
    const withHeader = new WorkingRom(headered, true)
    withHeader.append({ id: 'L1', label: 'set red', scope: 'edit', ops: [edit] })

    const plainResult = exportPatch(tmp, 'Plain', plain)
    const headeredResult = exportPatch(tmp, 'WithHeader', withHeader)

    expect(fs.readFileSync(headeredResult.path)).toEqual(fs.readFileSync(plainResult.path))
  })
})

describe.each(['ips', 'bps'] as const)('a preview layer never reaches the export (%s)', format => {
  it('excludes preview-scope ops from the written patch', () => {
    const base = fakeRom()
    const offset = loromToOffset(MARIO_RED_ADDR, base.length, false) as number
    base[offset] = 0x1f
    base[offset + 1] = 0x39

    const working = new WorkingRom(base, false)
    working.append({
      id: 'preview',
      label: 'preview',
      scope: 'preview',
      ops: [{ address: '$00B2CE', old: '$391F', new: '$7C00' }],
    })

    const result = exportPatch(tmp, 'MyHack', working, format)
    expect(result.opCount).toBe(0)

    const bytes = new Uint8Array(fs.readFileSync(result.path))
    if (format === 'ips') {
      expect(decodeIps(bytes)).toEqual([])
    } else {
      const applied = applyBps(base, bytes)
      expect(applied.ok && Array.from(applied.bytes)).toEqual(Array.from(base))
    }
  })
})
