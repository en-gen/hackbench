/**
 * `reveal-sweep` (#1132) and the audit rows behind it, on the synthetic cart (CI has no ROM). `revealRowsOf` is the
 * part of `revealRows` that turns two runs of each placed sprite into a row; the checks here fail if a row's `rest`
 * is constant, `hidden` is always false, or the plain run is the served one.
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { SPRITE_SEED, withSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import { interpRunner } from '../../../theia/extension/src/node/map-sprites'
import { revealRowsOf } from '../../../tools/scripts/spriteReportRun'
import { buildSyntheticRom } from '../support/syntheticSpriteRom'
import { loadTimeout, slow } from '../support/loadTimeout'

vi.setConfig({ testTimeout: loadTimeout(30_000), hookTimeout: loadTimeout(30_000) })

const rom = buildSyntheticRom()
const model = { isVertical: false, screenCount: 0x20 }
const entry = (spriteId: number, index: number): LevelSprite =>
  ({ screen: 0x10, x: 0x100, y: 0x12, spriteId, extraBit: false, raw: [0, 0, 0], index, streamOffset: 0 }) as LevelSprite // prettier-ignore

/** The audit rows of a stream with Mario at `marioX` (his $94), the way `revealRows` builds its two runners. */
function rows(ids: number[], marioX = 0x80) {
  const loaded = new Uint8Array(0x20000)
  loaded.set([marioX & 0xff, marioX >> 8, 0x20, 1], 0x94)
  const base = withSeed({}, { ...SPRITE_SEED, loaded })
  const stream = ids.map(entry)
  const run = (reveal: boolean) =>
    interpRunner(rom, 0x105, model, undefined, () => base, undefined, undefined, undefined, stream, reveal) // prettier-ignore
  return revealRowsOf('105', stream, run(false), run(true))
}

describe('revealRowsOf', () => {
  it('says what the plain run did and what the served run made of it, per sprite', () => {
    const r = rows([0, 140, 152, 5, 4])
    expect(r.map(x => [x.id, x.rest, x.hidden, x.condition, x.marker?.split(':')[0]])).toEqual([
      [0, 'drew', false, undefined, undefined],
      [140, 'blank', true, 'mario-at-sprite', undefined],
      // Mario on the mole's spot: it draws at rest, and a probe in its band finds it blank.
      [152, 'blank', true, 'mario-at-sprite', undefined],
      [5, 'blank', true, undefined, 'unrevealed'],
      [4, 'refused', false, undefined, 'refused'],
    ])
  })

  it('a sprite blank at rest whose search rerun is refused is hidden, with the refusal as its marker', () => {
    // Id 147 is blank with Mario away; on touch it becomes $FF, which has no handler.
    const [r] = rows([147])
    expect(r).toMatchObject({ rest: 'blank', hidden: true })
    expect(r!.marker).toMatch(/^refused: .*became/)
    expect(r!.condition).toBeUndefined()
  })

  it('a mole that draws the same picture wherever Mario stands is hidden, not revealed: none-found (#1365)', () => {
    const [m] = rows([152], 0x1000)
    expect(m).toMatchObject({ rest: 'drew', hidden: true, condition: 'none-found' })
    expect(m!.sameAsRest).toEqual(['mario-at-sprite', 'mario-left', 'mario-right', 'more-frames', 'p-switch', 'on-off']) // prettier-ignore
  })

  it('the row lists the conditions skipped for repeating the at-rest picture, in order (ids 156, 178, and the 179 control)', () => {
    const [a, b, c] = rows([156, 178, 179], 0x1040)
    expect(a).toMatchObject({ condition: 'none-found', sameAsRest: ['more-frames', 'p-switch', 'on-off'] }) // prettier-ignore
    expect(b).toMatchObject({ condition: 'none-found', sameAsRest: ['more-frames', 'p-switch', 'on-off'] }) // prettier-ignore
    // 179 looks different with Mario on it: revealed, nothing skipped, so no sameAsRest on the row.
    expect(c).toMatchObject({ condition: 'mario-at-sprite' })
    expect(c).not.toHaveProperty('sameAsRest')
  })

  it('keeps the real-start picture of a sprite no condition reveals, as none-found', () => {
    expect(rows([156], 0x1040)[0]).toMatchObject({
      rest: 'drew',
      hidden: true,
      condition: 'none-found',
    })
  })

  it('carries the placement into the row', () => {
    expect(rows([0])[0]).toMatchObject({ map: '105', index: 0, column: 0x100, row: 0x12 })
  })
})

describe('reveal-sweep', () => {
  const script = resolve(__dirname, '../../../tools/scripts/reveal-sweep.ts')
  const sweep = (...args: string[]) => {
    try {
      execFileSync('npx', ['tsx', script, ...args], {
        stdio: 'pipe',
        shell: true,
        encoding: 'utf8',
      })
      return { code: 0, err: '' }
    } catch (e) {
      const x = e as { status: number; stderr: string }
      return { code: x.status, err: x.stderr }
    }
  }
  it('refuses a report path inside the repository, and writes nothing', slow(90_000), () => {
    const inside = resolve(__dirname, '../../../reveal-sweep-refusal-probe.txt')
    const r = sweep('--rom', 'nonexistent.smc', '--out', inside)
    expect(r.code).toBe(2)
    expect(r.err).toContain('inside the hackbench checkout')
    expect(existsSync(inside)).toBe(false)
    rmSync(inside, { force: true })
  })
  it(
    'control: a path outside the repository gets past the guard (and fails on the missing ROM)',
    slow(90_000),
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'rsweep-'))
      const r = sweep('--rom', join(dir, 'nonexistent.smc'), '--out', join(dir, 'r.txt'))
      expect(r.err).not.toContain('inside the hackbench checkout')
      expect(r.code).not.toBe(0)
      rmSync(dir, { recursive: true, force: true })
    },
  )
})
