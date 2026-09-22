/**
 * Exporting a WorkingRom's edits as a real .ips, applyable by any patcher.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { exportPatch, EXPORT_DIR } from '../../../src/project/ExportPatch'
import { WorkingRom } from '../../../src/project/WorkingRom'
import { decodeIps, encodeIps } from '../../../src/rom/Ips'
import { applyPatches } from '../../../src/rom/PatchLayer'
import { loromToOffset } from '../../../src/rom/addressing'

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

describe('exportPatch', () => {
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

    const result = exportPatch(tmp, 'MyHack', working)
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

  it('a preview layer never reaches the export', () => {
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

    const result = exportPatch(tmp, 'MyHack', working)
    const patches = decodeIps(new Uint8Array(fs.readFileSync(result.path)))
    expect(patches).toEqual([])
    expect(result.opCount).toBe(0)
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

    const result = exportPatch(tmp, 'Headered', working)
    expect(result.hasCopierHeader).toBe(true)
  })

  it('sanity: encodeIps/decodeIps still round-trip (regression guard for the diff path)', () => {
    const patches = [{ offset: 10, value: 0xab }]
    expect(decodeIps(encodeIps(patches))).toEqual(patches)
  })
})
