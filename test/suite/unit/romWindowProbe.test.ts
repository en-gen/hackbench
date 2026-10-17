// The ROM-window probe (tools/scripts/rom-window-probe.mjs). Every ROM here is
// PRNG bytes built in the test, so this runs in CI with no corpus.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM without types
import {
  bytesHits,
  locateVanillaRom,
  textHits,
  windowSet,
} from '../../../tools/scripts/lib/rom-windows.mjs'
import { resolveRomDir, VANILLA } from '../support/corpus'

const REPO = join(__dirname, '../../..')
const CLI = join(REPO, 'tools/scripts/rom-window-probe.mjs')

function prng(n: number, seed = 0x1234abcd): Uint8Array {
  const out = new Uint8Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = s >>> 24
  }
  return out
}
const hex = (b: ArrayLike<number>) => Array.from(b, x => x.toString(16).padStart(2, '0')).join(' ')
const ROM = prng(4096)
const SET = windowSet(ROM)
const dir = mkdtempSync(join(tmpdir(), 'rom-window-probe-'))
const put = (name: string, data: Uint8Array | string) => {
  const p = join(dir, name)
  writeFileSync(p, data)
  return p
}
const romFile = put('fake.sfc', ROM)
const probe = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  })

describe('window set and filter', () => {
  it('(a) a planted 8-byte copy is a hit, as text and as assembled bytes', () => {
    const run = ROM.subarray(100, 108)
    expect(textHits(`db ${hex(run)}`, SET)).toEqual([{ at: 1, windows: 1 }])
    const blob = new Uint8Array([1, 2, 3, ...run, 9])
    expect(bytesHits(blob, SET, 8)).toEqual([{ at: 3, windows: 1 }])
  })
  it('(b) a 7-byte copy stays green', () => {
    const run = ROM.subarray(100, 107)
    expect(textHits(`db ${hex(run)}`, SET)).toEqual([])
    expect(bytesHits(new Uint8Array([...run, 0xee]), SET, 8)).toEqual([])
  })
  it('(c) a low-variety window is filtered', () => {
    const rom = prng(64)
    rom.set([0, 0, 0, 0, 0, 0, 0, 1], 20)
    const set = windowSet(rom)
    expect(textHits('db 00 00 00 00 00 00 00 01', set)).toEqual([])
    expect(bytesHits(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), set, 8)).toEqual([])
  })
  it('(d) a 512-byte copier header is stripped', () => {
    const withHeader = new Uint8Array(512 + ROM.length)
    withHeader.set(ROM, 512)
    expect(windowSet(withHeader)).toEqual(SET)
  })
  it('tokenizes 0x literals and decimal lists with line numbers', () => {
    const run = ROM.subarray(300, 308)
    const dec = `x\n[${Array.from(run).join(', ')}]`
    expect(textHits(dec, SET)).toEqual([{ at: 2, windows: 1 }])
    expect(
      textHits(Array.from(run, b => '0x' + b.toString(16).padStart(2, '0')).join(', '), SET),
    ).toHaveLength(1)
  })
})

describe('ROM lookup', () => {
  it('matches corpus.ts for the same env', () => {
    const exists = (p: string) => p.includes(join('tools-x', 'hackbench-tools', 'roms'))
    for (const env of [
      { HACKBENCH_ROMS: join(dir, 'r') },
      { HACKBENCH_TOOLS: join(dir, 't') },
      {},
    ]) {
      const repo = join(dir, 'tools-x', 'hackbench')
      expect(locateVanillaRom(env, repo, exists)).toBe(
        join(resolveRomDir(env, repo, exists), VANILLA),
      )
    }
  })
})

describe('CLI', () => {
  const hit = put('hit.txt', `// a\ndb ${hex(ROM.subarray(500, 508))}\n`)
  const clean = put('clean.txt', `db ${hex(prng(8, 7))}\n`)
  const blob = put('hit.bin', new Uint8Array([5, 5, ...ROM.subarray(10, 18)]))
  it('exits 1 with HIT lines and a TOTAL', () => {
    const r = probe(['--rom', romFile, hit])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(`HIT ${hit}:2 windows=1`)
    expect(r.stdout).toContain('TOTAL files=1 filesWithHits=1 hitWindows=1')
    expect(r.stdout).not.toContain(hex(ROM.subarray(500, 508)))
  })
  it('exits 0 when clean', () => {
    const r = probe(['--rom', romFile, clean])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('TOTAL files=1 filesWithHits=0 hitWindows=0')
  })
  it('--bin reports offsets', () => {
    const r = probe(['--rom', romFile, '--bin', blob])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('offset=0x2 windows=1')
  })
  it('finds the ROM through the env lookup', () => {
    put('Super Mario World (USA).vanilla.sfc', ROM)
    expect(probe([hit], { HACKBENCH_ROMS: dir }).status).toBe(1)
  })
  it('SKIPs with exit 0 when no ROM exists', () => {
    const r = probe([hit], { HACKBENCH_ROMS: join(dir, 'nowhere') })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SKIP: vanilla ROM not found (looked:')
  })
  it('--git-range scans added lines only', () => {
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        encoding: 'utf8',
      })
    git('init', '-q')
    put('f.txt', `db ${hex(ROM.subarray(700, 708))}\n`)
    git('add', 'f.txt')
    git('commit', '-qm', 'base')
    put('f.txt', `db ${hex(ROM.subarray(700, 708))}\nok\ndb ${hex(ROM.subarray(900, 908))}\n`)
    git('commit', '-qam', 'more')
    const r = probe(['--rom', romFile, '--repo', dir, '--git-range', 'HEAD~1..HEAD'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('HIT f.txt:3 windows=1')
    expect(r.stdout).not.toContain('f.txt:1')
  })
})
