/** The hack sweep's verdicts and summary, with no ROM: the sweep itself is hand-run. */
import { createHash } from 'crypto'
import { describe, it, expect } from 'vitest'
import {
  HackRecord,
  blockerKey,
  decideInterop,
  gfxRefusals,
  runReader,
  stripByteRuns,
  summarize,
} from '../../../tools/scripts/hackSweepReport'

describe('runReader', () => {
  it('passes an ok and a refusal through, and turns a throw into a crash with its frame', () => {
    expect(runReader(() => ({ verdict: 'ok', summary: '3 maps' }))).toEqual({
      verdict: 'ok',
      summary: '3 maps',
    })
    expect(runReader(() => ({ verdict: 'unavailable', reasons: ['a', 'b'] }))).toEqual({
      verdict: 'unavailable',
      reasons: ['a', 'b'],
    })
    const crash = runReader(() => {
      throw new RangeError('offset out of bounds')
    })
    expect(crash).toMatchObject({ verdict: 'crash', error: 'RangeError: offset out of bounds' })
    expect(crash.verdict === 'crash' && crash.frame).toMatch(/^at .*HackSweep\.synthetic\.test\.ts/)
  })
})

describe('stripByteRuns', () => {
  it('elides runs past an opcode and operand, keeping the address and gate name', () => {
    const reason = '$05D8A2 (CODE_05D8A2) holds c9 25 90 03 38, not the stock c9 ?? 90 03 38.'
    expect(stripByteRuns(reason)).toBe(
      '$05D8A2 (CODE_05D8A2) holds <bytes>, not the stock <bytes>.',
    )
    expect(stripByteRuns('holds 22 ff eb 92')).toBe('holds 22 ff eb 92')
    expect(runReader(() => ({ verdict: 'unavailable', reasons: [reason] }))).toMatchObject({
      reasons: ['$05D8A2 (CODE_05D8A2) holds <bytes>, not the stock <bytes>.'],
    })
  })
})

describe('gfxRefusals', () => {
  const files = [{ index: 0, unavailable: 'loader patched' }, { index: 1 }]
  it('records listed and deliberately thrown refusals', () => {
    const decode = (): never => {
      throw new Error('Palette column 1 is unavailable: patched')
    }
    expect(gfxRefusals(files, decode)).toEqual([
      'loader patched',
      'Palette column 1 is unavailable: patched',
    ])
  })
  it('lets any other throw through, so the sweep reports a crash', () => {
    const typeErr = (): never => {
      throw new TypeError('GFX file $01 is unavailable: x')
    }
    const other = (): never => {
      throw new Error('Address out of range')
    }
    expect(() => gfxRefusals(files, typeErr)).toThrow(TypeError)
    expect(() => gfxRefusals(files, other)).toThrow('Address out of range')
  })
})

describe('decideInterop', () => {
  const bytes = Uint8Array.of(1, 2, 3)
  const sha = createHash('sha256').update(bytes).digest('hex')
  it('matches only when our output hashes to the index', () => {
    expect(decideInterop(`\\${sha.toUpperCase()}`, { ok: true, bytes })).toMatchObject({
      verdict: 'match',
    })
    expect(decideInterop(sha, { ok: true, bytes: Uint8Array.of(1, 2, 4) })).toMatchObject({
      verdict: 'mismatch',
    })
  })
  it('reports a refused patch and an unparseable index hash', () => {
    expect(decideInterop(sha, { ok: false, reason: 'crc' })).toEqual({
      verdict: 'refused',
      reason: 'crc',
    })
    expect(decideInterop(sha.slice(1), { ok: true, bytes })).toMatchObject({
      verdict: 'index-hash-invalid',
    })
  })
})

describe('blockerKey', () => {
  it('folds a FastROM mirror and drops what a hack put at the gate', () => {
    expect(blockerKey('call targets $85DCD0')).toBe(blockerKey('call targets $05DCD0'))
    expect(blockerKey('$0096F4 (JSL, x.asm:1) holds 22 ff eb 92, not the stock 22 96 d7 05.')).toBe(
      '$0096F4 (JSL, x.asm:1) is not stock.',
    )
  })
})

describe('summarize', () => {
  const rec = (smwcId: number, maps: HackRecord['readers'][string]): HackRecord => ({
    smwcId,
    name: `hack ${smwcId}`,
    romSha256: null,
    romSize: smwcId === 5 ? 0x300200 : null,
    readers: { maps },
    interop:
      smwcId === 2
        ? { verdict: 'mismatch', resultSha256: 'b' }
        : { verdict: 'match', resultSha256: 'a' },
  })
  const u = (...reasons: string[]) => ({ verdict: 'unavailable' as const, reasons })
  const md = summarize([
    rec(1, { verdict: 'ok', summary: '9 maps, 0 roots, 9 unassigned' }),
    rec(2, u('shared', 'rare')),
    rec(3, u('shared')),
    rec(4, u('shared', 'rare')),
    rec(5, { verdict: 'crash', error: 'TypeError: x', frame: 'at f' }),
  ])

  it('counts each verdict per view with the share that works', () => {
    expect(md).toContain('| maps | 1 | 3 | 1 | 20.0% |')
  })

  it('ranks each gate by the hacks it alone blocks and by all it blocks', () => {
    expect(md).toContain('| 1 | 3 | shared |')
    expect(md).toContain('| 0 | 2 | rare |')
    expect(md.indexOf('| shared |')).toBeLessThan(md.indexOf('| rare |'))
  })

  it('lists flat trees, crashes, headered-size ROMs and interop failures', () => {
    expect(md).toContain('1 hacks load with 0 roots')
    expect(md).toContain('- 5 hack 5 / maps: TypeError: x (at f)')
    expect(md).toContain('- 5 hack 5: 3146240 bytes')
    expect(md).toContain('- match: 4')
    expect(md).toContain('- mismatch: 2 hack 2: b')
  })
})
