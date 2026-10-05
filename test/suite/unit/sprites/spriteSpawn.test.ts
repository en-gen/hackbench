/**
 * Grades the runner against Mesen's SPAWN-mode traces (`sprite-spawn`
 * fixtures): one sprite id in slot 0 at a fixed placement, 16 frames of OAM
 * with per-entry slot attribution. Gated on the fixtures and the vanilla ROM.
 * Oracle only; the fixture's seed is turned into a `SpriteSeed`, never read by
 * the runner.
 *
 * Per id and per pass the verdict compares ABSOLUTE OAM (same placement, same
 * camera, so no sprite-relative ambiguity): exact when every owned entry
 * matches in OAM slot, X, Y, tile, attribute and size; close when the tile and
 * palette multiset matches but a position or flip differs; wrong otherwise.
 * The anchor (position after INIT) is graded against the recorded slot-0 position
 * after the INIT call.
 *
 * SPRITE_SPAWN_OUT dumps every graded pass as JSON.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSprite, type SpritePart } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { freshRom, hasRom, TOOLS_ROOT, VANILLA } from '../../support/corpus'
import { levelOf } from '../../support/spriteGrade'

const SPAWN_DIR = process.env.HACKBENCH_SPRITE_SPAWN ?? join(TOOLS_ROOT, 'fixtures', 'sprite-spawn')

interface Seed {
  camX: number
  camY: number
  id: number
  x: number
  y: number
  marioX: number
  marioY: number
}
/** Hardware OAM entry decoded the way the capture decoder does. */
interface Piece {
  oam: number
  x: number
  y: number
  tile: number
  attr: number
  large: boolean
}

const pieceKey = (p: Piece): string => [p.oam, p.x, p.y, p.tile, p.attr, +p.large].join(',')
const looseKey = (p: Piece): string => [p.tile, p.attr & 0x0f, +p.large].join(',')
const sorted = (ps: Piece[], f: (p: Piece) => string): string => ps.map(f).sort().join(';')

/**
 * What one recorded call put in the OAM mirror: entries whose tile byte it
 * wrote, with the last value written to each field. Read from the call's own
 * write log, not from hardware OAM, which lags the mirror by a frame (the
 * game's NMI copies the mirror before the next frame's sprite code runs).
 */
function recorded(writes: number[]): Piece[] {
  const last = new Map<number, number>()
  for (const w of writes) last.set(w >>> 8, w & 0xff)
  const out: Piece[] = []
  for (let i = 0; i < 64; i++) {
    const at = (field: number): number | undefined => last.get(0x7e0300 + i * 4 + field)
    const tile = at(2)
    if (tile === undefined) continue
    const size = last.get(0x7e0460 + i) ?? 0
    const y = at(1) ?? 0xf0
    const large = !!(size & 2)
    if (y >= 224 && y + (large ? 16 : 8) <= 256) continue
    out.push({ oam: i, x: (at(0) ?? 0) | ((size & 1) << 8), y, tile, attr: at(3) ?? 0, large })
  }
  return out
}

function modelPieces(parts: SpritePart[]): Piece[] {
  return parts
    .filter(q => !(q.oy >= 224 && q.oy + q.size <= 256))
    .map(q => ({ oam: q.oam, x: q.ox, y: q.oy, tile: q.char & 0xff, attr: q.attr, large: q.size === 16 })) // prettier-ignore
}

describe.skipIf(!existsSync(SPAWN_DIR) || !hasRom(VANILLA))(
  'sprite runner vs Mesen spawn traces',
  () => {
    it('grades every spawned id, per pass', () => {
      const rom = freshRom()
      const sha = readdirSync(SPAWN_DIR)[0]
      const root = join(SPAWN_DIR, sha)
      // SPRITE_SPAWN_SEED=oracle copies the fixture's WRAM (upper bound); default runs the ROM's own loader.
      const oracle = process.env.SPRITE_SPAWN_SEED === 'oracle'
      const lv = loadLevelState(rom, 0xbd)
      const romLevel = lv.ok ? lv.wram : undefined
      const baseline = new Uint8Array(readFileSync(join(root, 'baseline_wram.bin')))
      const rows: {
        id: number
        verdicts: string[]
        anchor: string
        detail?: unknown
        sample?: unknown
      }[] = []
      const tally: Record<string, number> = {}
      const anchors: Record<string, number> = {}
      for (const dir of readdirSync(root).sort()) {
        const sp = join(root, dir, 'seed.json')
        if (!existsSync(sp)) continue
        const seed: Seed = JSON.parse(readFileSync(sp, 'utf8'))
        const calls: { writes: number[]; kind?: string; frame: number }[] = JSON.parse(readFileSync(join(root, dir, 'calls.json'), 'utf8')) // prettier-ignore
        const wram = readFileSync(join(root, dir, 'wram.bin'))
        const hi = readFileSync(join(root, dir, 'wram_hi.bin'))
        // First call that is not INIT: status-8 sprites log 'main', status-9 ones 'other'.
        const k0 = Math.max(
          0,
          calls.findIndex(c => c.kind !== 'init'),
        )
        const pre1 = wram.subarray(k0 * 0x2000, (k0 + 1) * 0x2000) // state entering the first MAIN call
        const pre0 = wram.subarray(0, 0x2000)
        const m = runSprite(
          rom,
          seed.id,
          withSeed({
            slot: 0,
            sprite: { x: seed.x, y: seed.y },
            camera: { x: seed.camX, y: seed.camY },
            mario: { x: seed.marioX, y: seed.marioY },
            trueFrame: pre0[0x13],
            effFrame: pre0[0x14],
            mainPasses: 16, // the fixture records 16 frames
            ...(oracle
              ? {
                  level: levelOf(baseline),
                  wramBase: baseline,
                  map16: {
                    low: readFileSync(join(root, dir, 'map16_7ec800.bin')),
                    high: readFileSync(join(root, dir, 'map16_7fc800.bin')),
                  },
                  blocks: [
                    { offset: 0xad00, bytes: hi.subarray(0, 768) },
                    { offset: 0x18000, bytes: hi.subarray(768, 768 + 8192) },
                  ],
                }
              : { loaded: romLevel }),
          }),
        )
        const verdicts: string[] = []
        let sample: unknown
        // Mesen agrees with a refusal when its INIT never returned (hung) or kept
        // re-running INIT (status stays 1), or its MAIN hung.
        const meta = JSON.parse(readFileSync(join(root, dir, 'meta.json'), 'utf8'))
        const mesenStuck = !!meta.hung || calls.every(c => c.kind === 'init')
        if (m.refusal)
          verdicts.push(...Array(16).fill(mesenStuck ? 'refused-agrees' : 'refused-differs'))
        else
          for (let p = 0; p < 16; p++) {
            // Every call of that frame, any slot: sprites that spawn others (Lakitu, the
            // bonus game) draw from more than slot 0, and so does our sprite loop.
            const inFrame = calls.filter(c => c.frame === calls[k0].frame + p)
            if (!inFrame.length) {
              verdicts.push('unrecorded')
              continue
            }
            const want = recorded(inFrame.flatMap(c => c.writes))
            const got = modelPieces(m.passes[p].parts)
            let v = 'wrong'
            if (sorted(got, pieceKey) === sorted(want, pieceKey))
              v = want.length ? 'exact' : 'exact-empty'
            else if (want.length && sorted(got, looseKey) === sorted(want, looseKey)) v = 'close'
            else if (!got.length && want.length) v = 'empty'
            if (!sample && v !== 'exact' && v !== 'exact-empty') sample = { pass: p, want, got }
            verdicts.push(v)
          }
        for (const v of verdicts) tally[v] = (tally[v] ?? 0) + 1
        const wantAnchor = pre1[0xe4] | (pre1[0x14e0] << 8)
        const wantAnchorY = pre1[0xd8] | (pre1[0x14d4] << 8)
        const a = m.refusal ? (mesenStuck ? 'anchor-refusal-agrees' : 'anchor-refused') : m.anchor && m.anchor.x === wantAnchor && m.anchor.y === wantAnchorY ? 'anchor-exact' : 'anchor-differs' // prettier-ignore
        anchors[a] = (anchors[a] ?? 0) + 1
        rows.push({ id: seed.id, verdicts, anchor: a, detail: a === 'anchor-differs' ? { got: m.anchor, want: [wantAnchor, wantAnchorY] } : m.refusal, sample }) // prettier-ignore
      }
      console.log(
        `spawn ${rows.length} ids x16 passes: ${JSON.stringify(tally)}; ${JSON.stringify(anchors)}`,
      )
      if (process.env.SPRITE_SPAWN_OUT) writeFileSync(process.env.SPRITE_SPAWN_OUT, JSON.stringify(rows, null, 1)) // prettier-ignore
      expect(rows.length).toBeGreaterThan(0)
    }, 300_000)
  },
)
