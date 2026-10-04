import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import { describe, expect, it } from 'vitest'

// Runs the mockup's inline parser (computeLevelBoundaries and its readers) in a
// vm over synthetic ROM bytes. Synthetic only: nothing here needs a ROM.
interface Block {
  kind: string
  fileStart: number
  indices: number[]
}
interface Result {
  blocks: Block[]
  capHit: boolean
  reads: number
}

const MOCKUP = path.resolve(__dirname, '../../../docs/mockups/rom-map.html')

function loadParser(src = fs.readFileSync(MOCKUP, 'utf8')): (rom: Uint8Array) => Result {
  const a0 = src.indexOf('  function readRomByte(snes)')
  const b0 = src.indexOf('  function findBlockAt(')
  if (a0 < 0 || b0 < a0) throw new Error('rom-map.html parser region not found')
  const anchor = 'function readRomByteFile(fileOffset) {'
  if (!src.includes(anchor))
    throw new Error('readRomByteFile signature changed; read counter not installed')
  const body = src.slice(a0, b0).replace(anchor, anchor + ' __reads++;')
  const code = `
    const BANK_BYTES = 0x8000;
    function snesToFile(snes) { return (((snes >>> 16) & 0x7F) * BANK_BYTES) + (snes & 0x7FFF); }
    let loadedRom = null, romHeaderOffset = 0, __reads = 0;
    ${body}
    globalThis.run = rom => { loadedRom = rom; __reads = 0; const r = computeLevelBoundaries(); return { blocks: r.blocks, capHit: r.capHit, reads: __reads }; };`
  const ctx: { run?: (rom: Uint8Array) => Result } = {}
  vm.runInNewContext(code, Object.assign(ctx, { globalThis: ctx }))
  return ctx.run as (rom: Uint8Array) => Result
}

const L1_TABLE = 0x2e000
const L2_TABLE = 0x2e600
const SPR_TABLE = 0x2ec00

/** 512 KiB of $01 fill (an unterminated stream); L2 pointers disabled; sprites all one stream. */
function makeRom(l1Snes: (i: number) => number): Uint8Array {
  const d = new Uint8Array(0x80000).fill(0x01)
  for (let i = 0; i < 512; i++) {
    const p = l1Snes(i)
    d[L1_TABLE + i * 3] = p & 0xff
    d[L1_TABLE + i * 3 + 1] = (p >> 8) & 0xff
    d[L1_TABLE + i * 3 + 2] = p >> 16
    d[L2_TABLE + i * 3 + 2] = 0xff
    d[SPR_TABLE + i * 2] = 0x00
    d[SPR_TABLE + i * 2 + 1] = 0x80
  }
  return d
}

describe('rom-map computeLevelBoundaries', () => {
  it('refuses a source whose read-counter anchor is missing', () => {
    const src = [
      '  function readRomByte(snes) {}',
      '  function readRomByteFile(off) {}',
      '  function findBlockAt() {}',
    ].join(' ')
    expect(() => loadParser(src)).toThrow('readRomByteFile signature changed')
  })

  const run = loadParser()

  it('walks a stream shared by all 512 L1 pointers once and keeps every index', () => {
    const r = run(makeRom(() => 0x028000))
    const l1 = r.blocks.filter(b => b.kind === 'L1')
    expect(l1).toHaveLength(1)
    expect(l1[0].indices).toHaveLength(512)
    expect(r.capHit).toBe(false)
    // One L1 walk plus one sprite walk; 512 rewalks would be ~100x this.
    expect(r.reads).toBeGreaterThan(0)
    expect(r.reads).toBeLessThan(4 * 0x80000)
  })

  it('stops walking after the work cap when every L1 pointer is distinct', () => {
    const r = run(makeRom(i => 0x028000 + i * 3))
    expect(r.capHit).toBe(true)
    expect(r.blocks.filter(b => b.kind === 'L1').length).toBeLessThan(100)
    expect(r.reads).toBeGreaterThan(0)
    expect(r.reads).toBeLessThan(12 * 0x80000)
  })

  it('past the work cap still files a repeat pointer under its block, and flags the cap', () => {
    const rom = makeRom(i => (i === 0 || i === 511 ? 0x0f8000 : 0x028000 + i * 3))
    rom[0x78005] = 0xff // terminate the shared stream after its 5-byte header
    const r = run(rom)
    const shared = r.blocks.find(b => b.kind === 'L1' && b.fileStart === 0x78000)
    expect(r.reads).toBeGreaterThan(0)
    expect(shared?.indices).toEqual([0, 511])
    expect(r.capHit).toBe(true)
    expect(r.blocks.filter(b => b.kind === 'L1').length).toBeLessThan(100)
  })
})
