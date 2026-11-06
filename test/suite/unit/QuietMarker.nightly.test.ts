/**
 * The vanilla sweep for #1011: which placed items moved from the framed id box to the quiet marker, by id, over all 512
 * maps of the vanilla ROM (about 90 s, one machine, 2026-11-05). The routed rows (shooter, generator, scroll command:
 * classes the game's loader reads, not a verdict on a run) and the empty-run rows #1132 leaves alone are pinned, so a
 * drawn sprite going quiet by regression fails. A routed id is quiet or drawn, never a failure box, except a non-scroll
 * one with the extra bits set, which stays boxed on purpose (it may be custom). $4D, $4E, $A8 and $C7 are #1132's: its reveal search
 * draws them, so none is a quiet row any more (measured on the merged code, none in the table). Set QUIET_SWEEP_OUT to write the whole table to a file.
 */
import { readFileSync, writeFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { loadClasses } from '../../../src/rom/sprites/interp/LoadClass'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { VANILLA, hasRom, romPath } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('quiet marker sweep, vanilla', () => {
  it(
    'pins the quiet rows #1132 leaves alone by id and kind, and no routed id is a failure box',
    { timeout: 600_000 },
    () => {
      const bytes = new Uint8Array(readFileSync(romPath(VANILLA)))
      const classes = loadClasses(RomFile.fromBytes('x.sfc', Buffer.from(bytes)))
      if (classes.status !== 'ok') throw new Error(classes.reason)
      const cache = new L1ModelCache()
      const all = new Map<string, number>()
      const routedBoxes: string[] = []
      for (let map = 0; map < 0x200; map++) {
        const r = mapSprites(cache, bytes, romPath(VANILLA), map)
        if (r.status !== 'ok') continue
        for (const s of r.sprites) {
          const cls = classes.of(s.id)
          if (cls !== 'normal' && s.status !== 'quiet' && s.status !== 'drawn' && !(s.reason === 'extraBits' && cls !== 'scroll')) routedBoxes.push(`${map.toString(16)}#${s.index} ${s.id.toString(16)} ${s.reason}`) // prettier-ignore
          if (s.status !== 'quiet') continue
          const k = `${s.id.toString(16)} ${s.kind ?? 'other'}`
          all.set(k, (all.get(k) ?? 0) + 1)
        }
      }
      const table = [...all].sort().map(([k, n]) => `${k} x${n}`)
      if (process.env.QUIET_SWEEP_OUT) writeFileSync(process.env.QUIET_SWEEP_OUT, table.join('\n'))
      expect(routedBoxes).toEqual([])
      expect(table).toEqual(PINNED)
    },
  )
})

const PINNED = [
  '19 other x1', '1f other x1', '54 other x6', '6d other x4', '89 other x3', '8c other x1', '8e other x6',
  'c9 shooter x20',
  'cc generator x1', 'cd generator x3', 'cf generator x2', 'd0 generator x1', 'd1 generator x1',
  'd2 generator x5', 'd3 generator x2', 'd4 generator x4', 'd5 generator x1', 'd6 generator x2',
  'd7 generator x1', 'd8 generator x1', 'd9 generator x17',
  'e8 scroll x3', 'e9 scroll x4', 'ea scroll x6', 'ef scroll x2', 'f2 scroll x1', 'f3 scroll x4',
  'f4 scroll x1', 'f5 scroll x3',
] // prettier-ignore
