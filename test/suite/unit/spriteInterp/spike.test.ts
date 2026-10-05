/**
 * SPIKE measurement: runs every vanilla sprite id on the concrete 65816 core and
 * compares the 16 descriptor sprites to the table engine. Results go to
 * $SPIKE_OUT (a scratch JSON) and are summarised in docs/ideas/sprite-gfx-interpreter.md.
 * Skipped without the corpus; the synthetic CPU test lives in Cpu65816.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'fs'
import { CORPUS, VANILLA, freshRom, hasRom } from '../../support/corpus'
import { runSprite, toParts, partKey, type Part } from '../../../../src/rom/spriteInterp/spriteRun'
import { readSpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import { SPRITE_DRAW_DESCRIPTORS } from '../../../../src/rom/model/sprites/generic/SpriteDrawDescriptor'
import {
  drawSpriteParts,
  readHandlerPointers,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawEngine'

const OUT = process.env.SPIKE_OUT
const hex = (n: number, w = 2) => n.toString(16).padStart(w, '0')

/** Opcode bytes interpret.ts's switch accepts, read from its own source. */
function allowedByExistingInterpreter(): Set<number> {
  const src = readFileSync('src/rom/objectHandlers/interpret.ts', 'utf8')
  const body = src.slice(src.indexOf('switch (op) {'), src.indexOf('default: refuse(`opcode'))
  return new Set([...body.matchAll(/case 0x([0-9a-f]{2})/g)].map(m => parseInt(m[1], 16)))
}

const partsKey = (ps: Part[]) => ps.map(partKey).sort().join()

/** First difference class between engine parts and interpreted parts. */
function classify(eng: Part[], got: Part[]): string {
  if (got.length === 0) return 'interp-no-oam'
  if (eng.length !== got.length) return `count ${eng.length} vs ${got.length}`
  const e = [...eng].map(partKey).sort()
  const g = [...got].map(partKey).sort()
  if (e.join() === g.join()) return 'match'
  const sel = (f: (p: Part) => string) => (ps: Part[]) => ps.map(f).sort().join()
  if (sel(p => `${p.dx},${p.dy}`)(eng) !== sel(p => `${p.dx},${p.dy}`)(got)) return 'position'
  if (sel(p => `${p.charNum}`)(eng) !== sel(p => `${p.charNum}`)(got)) return 'tile'
  if (sel(p => `${p.palette}`)(eng) !== sel(p => `${p.palette}`)(got)) return 'palette'
  return 'flip'
}

/** WRAM offset -> label, from the disassembly's rammap.asm when it is on disk. */
function ramNames(): (a: number) => string {
  const names: [number, string][] = []
  try {
    let at = -1
    for (const line of readFileSync('C:/Projects/SMWDisX/rammap.asm', 'utf8').split(/\r?\n/)) {
      const h = /^; === \$7E([0-9A-F]{4}) ===/.exec(line)
      if (h) at = parseInt(h[1], 16)
      const n = /^(\w+): skip (\d+)/.exec(line)
      if (n && at >= 0) names.push([at, n[1]])
    }
  } catch {
    /* names are a convenience */
  }
  return a => {
    const hit = [...names].reverse().find(([s]) => s <= a)
    return hit ? hit[1] + (a - hit[0] ? '+' + (a - hit[0]) : '') : ''
  }
}
const topInputs = (m: Map<number, number>) => {
  const name = ramNames()
  return [...m]
    .sort((p, q) => q[1] - p[1] || p[0] - q[0])
    .map(([a, n]) => ['$' + hex(a, 4), name(a), n])
}

describe.skipIf(!hasRom(VANILLA))('sprite interpreter spike (vanilla)', () => {
  it('runs $00-$C8 and compares the 16 descriptors', () => {
    const rom = freshRom()
    const allowed = allowedByExistingInterpreter()
    const tables = readSpriteTileTables(rom)!
    const rows: Record<string, unknown>[] = []
    const missing = new Map<number, number[]>() // opcode -> sprite ids that execute it
    const jsl = new Map<number, number[]>()
    const allOps = new Set<number>()
    const inputsMain = new Map<number, number>()
    const inputsInit = new Map<number, number>()
    for (let id = 0; id <= 0xc8; id++) {
      const r = runSprite(rom, id)
      const refusal = r.init.refusal ?? r.main.refusal
      const ops = new Set([...r.init.ops.keys(), ...r.main.ops.keys()])
      if (!refusal) ops.forEach(o => allOps.add(o))
      for (const op of ops)
        if (!allowed.has(op)) (missing.get(op) ?? missing.set(op, []).get(op)!).push(id)
      for (const t of new Set([...r.init.longCalls, ...r.main.longCalls]))
        (jsl.get(t) ?? jsl.set(t, []).get(t)!).push(id)
      const bump = (m: Map<number, number>, set: Set<number>) =>
        set.forEach(a => m.set(a < 0x100 || a > 0x1fff ? a : a, (m.get(a) ?? 0) + 1))
      if (!refusal) {
        bump(inputsMain, r.inputs.main)
        bump(inputsInit, r.inputs.init)
      }
      rows.push({
        id,
        blockers: [...ops].filter(o => !allowed.has(o)).map(o => hex(o)),
        distinctOps: ops.size,
        id2: 0,
        main: readHandlerPointers(rom, id)!.main,
        refusal: refusal?.reason ?? null,
        oam: r.oam.length,
        dynPal: r.dynamic.palette,
        writers: [...r.dynamic.writers, ...r.hwAt].map(a => hex(a, 6)),
        dynGfx: r.dynamic.gfx,
        steps: r.init.steps + r.main.steps,
        hw: r.init.hwWrites + r.main.hwWrites,
      })
    }
    const cmp = SPRITE_DRAW_DESCRIPTORS.map(d => {
      const out: Record<string, unknown> = { id: d.spriteId }
      const eng = drawSpriteParts({
        rom,
        tables,
        descriptor: d,
        spriteX: 0x80,
        ctx: { marioX: 0x80, romFrame: 0 },
      })
      const run = runSprite(rom, d.spriteId)
      out.refusal = (run.init.refusal ?? run.main.refusal)?.reason ?? null
      if (!eng.ok) return { ...out, cls: 'engine-failure' }
      const got = toParts(run)
      out.cls = classify(eng.parts, got)
      // Settled: 16 passes in, past INIT-seeded start-up timers (red/blue Koopa turn timer).
      out.clsSettled = classify(eng.parts, toParts(runSprite(rom, d.spriteId, { mainPasses: 16 })))
      out.eng = eng.parts.map(partKey).join(' ')
      out.got = got.map(partKey).join(' ')
      // Secondary: the same comparison across the frame counter.
      let same = 0
      const poses = new Set<string>()
      for (let f = 0; f < 64; f++) {
        const e2 = drawSpriteParts({
          rom,
          tables,
          descriptor: d,
          spriteX: 0x80,
          ctx: { marioX: 0x80, romFrame: f },
        })
        const g2 = toParts(runSprite(rom, d.spriteId, { frame: f }))
        poses.add(partsKey(g2))
        if (e2.ok && classify(e2.parts, g2) === 'match') same++
      }
      out.sweepMatch64 = same
      // A tile/flip mismatch at one frame is a PHASE difference if the engine's frame-0 pose
      // appears anywhere in the interpreter's 64-frame sweep.
      out.engPoseSeenInSweep = poses.has(partsKey(eng.parts))
      return out
    })
    // The same sweep on every cart in the corpus: does the vanilla entry still run a hack's own code?
    const vanillaMain = rom.readAt(0x0185c3, 9)!
    const corpus = CORPUS.filter(hasRom).map(name => {
      const r2 = freshRom(name)
      let done = 0,
        drew = 0,
        moved = 0
      for (let id = 0; id <= 0xc8; id++) {
        const run = runSprite(r2, id)
        if (!(run.init.refusal ?? run.main.refusal)) done++
        if (run.oam.length > 0) drew++
        const a = readHandlerPointers(r2, id)!,
          b = readHandlerPointers(rom, id)!
        if (a.main !== b.main || a.init !== b.init) moved++
      }
      return {
        name,
        done,
        drew,
        moved,
        entryPatched: !Buffer.from(r2.readAt(0x0185c3, 9)!).equals(Buffer.from(vanillaMain)),
      }
    })
    // Q2: what does INIT contribute? Same run with the INIT pass skipped.
    const noInit: [number, string][] = []
    rows.forEach(r => {
      if (r.refusal !== null || (r.oam as number) === 0) return
      const a = toParts(runSprite(rom, r.id as number))
      const b = toParts(runSprite(rom, r.id as number, { skipInit: true }))
      const c = classify(a, b)
      if (c !== 'match') noInit.push([r.id as number, c])
    })
    // INIT position deltas: same INIT at 5 seeds (columns, high bytes, Mario side, lowest bit patterns).
    const seeds = [
      { spriteX: 0x80, spriteY: 0x80 },
      { spriteX: 0x1b5, spriteY: 0x14c },
      { spriteX: 0x2f3, spriteY: 0x03 },
      { spriteX: 0x3d0, spriteY: 0x1a7, marioX: 0x10 },
      { spriteX: 0x1ff, spriteY: 0x0ff, marioX: 0x5ff },
    ]
    const initDeltas = rows
      .filter(r => r.refusal === null)
      .map(r => {
        const ds = seeds.map(sd => {
          const run = runSprite(rom, r.id as number, { ...sd, mainPasses: 0 })
          return [run.initPos.x - sd.spriteX, run.initPos.y - sd.spriteY]
        })
        return { id: r.id as number, ds }
      })
      .filter(e => e.ds.some(d => d[0] !== 0 || d[1] !== 0))
    const summary = {
      initDeltas,
      noInit,
      corpus,
      allOpsCount: allOps.size,
      allowedCount: allowed.size,
      inputsMain: topInputs(inputsMain),
      inputsInit: topInputs(inputsInit),
      completed: rows.filter(r => r.refusal === null).length,
      withOam: rows.filter(r => r.refusal === null && (r.oam as number) > 0).length,
      refusals: rows.filter(r => r.refusal !== null),
      hw: rows.filter(r => (r.hw as number) > 0).map(r => [r.id, r.hw]),
      missing: [...missing]
        .map(([op, ids]) => [hex(op), ids.length])
        .sort((a, b) => (b[1] as number) - (a[1] as number)),
      jsl: [...jsl]
        .map(([t, ids]) => [hex(t, 6), ids.length])
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .slice(0, 12),
      dyn: rows
        .filter(r => (r.dynPal as number) > 0 || (r.dynGfx as number) > 0)
        .map(r => [r.id, r.dynPal, r.dynGfx]),
      hiddenStart: rows
        .filter(r => r.refusal === null && r.oam === 0)
        .map(r => {
          const run = runSprite(rom, r.id as number, { mainPasses: 400, untilOam: true })
          return [r.id, run.oam.length > 0 ? run.passes : null]
        }),
      noOam: rows.filter(r => r.refusal === null && r.oam === 0).map(r => r.id),
      cmp,
      rows,
    }
    if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 1))
    expect(initDeltas).toHaveLength(27)
    expect(initDeltas.find(e => e.id === 0x4f)!.ds[0]).toEqual([8, -1]) // InitPiranha, bank_01.asm:880
    // Pinned so the doc's numbers cannot drift from the code: vanilla, slot 0, $1692 = 0.
    expect(rows.filter(r => r.refusal === null)).toHaveLength(197)
    expect(rows.filter(r => r.refusal === null && (r.oam as number) > 0)).toHaveLength(174)
    expect(cmp.filter(c => c.cls === 'match')).toHaveLength(9)
    expect(cmp.filter(c => c.clsSettled === 'match')).toHaveLength(14)
  })
})
