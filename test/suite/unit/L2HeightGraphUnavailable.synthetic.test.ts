/**
 * #1039: when the exit graph is unavailable the background height reads the primary entrance, a guess
 * (#910 did the same for Layer 3). It must say so, in the one sentence both layers share. Synthetic
 * bytes only; the corpus block proves vanilla (whose graph builds) gains no note.
 */
import { describe, it, expect } from 'vitest'
import { SmwRom, type MapEntrances } from '../../../src/rom/SmwRom'
import type { RomFile } from '../../../src/rom/RomFile'
import type { L1Inputs } from '../../../src/rom/model/L1Model'
import { buildL2Inputs } from '../../../src/rom/model/L2Model'
import {
  buildL3Verdict,
  EXIT_GRAPH_UNAVAILABLE,
  GRAPH_UNAVAILABLE,
} from '../../../src/rom/model/L3Model'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import {
  buildMapInputs,
  readMapEntrances,
  screenResult,
} from '../../../theia/extension/src/node/map-screen'
import { hGrid, inputs } from '../support/mapInputs'
import { VANILLA, freshRom, hasRom } from '../support/corpus'
import { modeTablesRom, STANDARD, withLayer3 } from '../support/l3Rom'
import { plantUploaderTable } from '../support/l2UploaderRom'
import { writeStockSkipChain } from '../support/skipChain'

const MAP = 5
const GATE = 'the level-start code is not stock.'
const flags = { green: false, yellow: false, blue: false, red: false }

function build(vertical: boolean): RomFile {
  const rom = modeTablesRom([STANDARD, ...Array(31).fill(STANDARD)])
  rom.writeAt(0x05d708, [0x10, 0x60, 0xc0, 0x30])
  rom.writeAt(0x05d70c, [0x08, 0x28, 0x48, 0x68])
  rom.writeAt(0x05f400 + MAP, [0x1e])
  rom.writeAt(0x05f600 + MAP, [vertical ? 0x22 : 0x02])
  rom.writeAt(0x05e600 + MAP * 3, [0x00, 0xe9, 0x05])
  rom.writeAt(0x05803b, [0xc9])
  plantUploaderTable(rom)
  writeStockSkipChain(rom)
  return rom
}

const l1Of = (vertical: boolean) =>
  ({
    screenCount: 1,
    isVertical: vertical,
    header: { levelMode: 1, objectTileset: 0 },
    map16: { tiles: [] },
  }) as unknown as L1Inputs

function l2Of(
  vertical: boolean,
  gate: string | null,
  entrances?: MapEntrances | typeof GRAPH_UNAVAILABLE,
) {
  const smw = {
    rom: build(vertical),
    getVerticalTable: () => ({ ok: true, table: new Array(32).fill(vertical ? 2 : 0) }),
  }
  const r = buildL2Inputs(smw as unknown as SmwRom, MAP, l1Of(vertical), entrances, () => gate)
  if (!r.ok) throw new Error(r.reason)
  return r.l2
}

describe.each([false, true])(
  'the background height when the exit graph is unavailable, vertical=%s (#1039)',
  vertical => {
    it.each([null, GATE])(
      'says the height is unverified and why, gate=%s, and still draws it',
      gate => {
        const l2 = l2Of(vertical, gate, GRAPH_UNAVAILABLE)
        expect(l2.note).toBe(
          `Background height unverified: ${[gate, EXIT_GRAPH_UNAVAILABLE].filter(Boolean).join(' ')}`,
        )
        expect(l2.reasons).toEqual([gate, EXIT_GRAPH_UNAVAILABLE].filter(Boolean))
      },
    )

    it('reads the same height as the call that does not say, and stays silent when it does not say', () => {
      const silent = l2Of(vertical, null)
      expect(silent.note).toBeUndefined()
      expect(l2Of(vertical, null, GRAPH_UNAVAILABLE).dy).toBe(silent.dy)
    })

    it('stays silent when the graph is available, even for a map it never reached', () => {
      const empty = { overworld: false, primary: false, secondary: [] } as MapEntrances
      expect(l2Of(vertical, null, empty).note).toBeUndefined()
    })
  },
)

describe('the Theia build (#1039)', () => {
  const build1 = (graph: ReturnType<typeof readMapEntrances> | Map<number, MapEntrances>) => {
    const raw = build(false)
    raw.writeAt(0x00ffd5, [0x20])
    const rom = new SmwRom(raw)
    const l1 = () => ({ ok: true, inputs: l1Of(false) }) as never
    return buildMapInputs(
      rom,
      MAP,
      flags,
      () => ({ ok: true, mode: 1 }),
      l1,
      () => graph,
    )
  }
  const noteOf = (b: ReturnType<typeof build1>) =>
    b.ok && b.inputs.l2?.ok ? b.inputs.l2.l2.note : 'refused'

  it('a graph that fails to build reaches the background height as a note', () => {
    expect(noteOf(build1(undefined))).toContain(EXIT_GRAPH_UNAVAILABLE)
  })

  it('a graph that builds but never reaches the map gives no note', () => {
    expect(noteOf(build1(new Map()))).not.toContain(EXIT_GRAPH_UNAVAILABLE) // the synthetic cart's own code gate still speaks
  })
})

describe('the notes the user sees, through the real merge (#1039, #926)', () => {
  const header = parseLevelHeader(Uint8Array.from([0, 1, 0, 0, 0]))
  const sheets = () => [[]] as never
  // Real L2 and L3 builders on one cart, the graph unavailable; the model goes through screenResult.
  const layerNotes = (gateOn: boolean) => {
    const raw = withLayer3(build(false), { level: MAP, tileset: 0, setting: 2, settingsByte: 0x02, word: 2 }) // prettier-ignore
    const smw = { rom: raw, getVerticalTable: () => ({ ok: true, table: new Array(32).fill(0) }) }
    const l1 = { ...inputs(hGrid(1), false, 1, 0), header }
    const l2 = buildL2Inputs(smw as unknown as SmwRom, MAP, l1, GRAPH_UNAVAILABLE, gateOn ? undefined : () => null) // prettier-ignore
    // `[]` spans leave the L3 side with no gate reason of its own; gate-on leaves both on the real gate, which words the same reason for each.
    const l3 = buildL3Verdict(raw, MAP, l1, { ok: true, mode: 1 }, sheets, { ok: true }, undefined, GRAPH_UNAVAILABLE, gateOn ? undefined : []) // prettier-ignore
    const w = screenResult({ ...l1, l2, l3 }, 0)
    if (w.status !== 'ok') throw new Error(w.status)
    return w.layerNotes
  }

  it.each([false, true])(
    'gate on=%s: one line naming both layers, the sentence once, none apart',
    gateOn => {
      const notes = layerNotes(gateOn)
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatch(/^Background height and Layer 3 position unverified: /)
      expect(notes[0]!.split(EXIT_GRAPH_UNAVAILABLE)).toHaveLength(2)
      expect(/ \$[0-9A-F]{6} /.test(notes[0]!)).toBe(gateOn)
    },
  )
})

describe.skipIf(!hasRom(VANILLA))(
  'vanilla: the graph builds, so no map gains the note (corpus)',
  () => {
    it('every map reads its background height without the graph note', () => {
      const rom = new SmwRom(freshRom(VANILLA))
      const graph = readMapEntrances(rom)
      expect(graph).toBeDefined()
      let drawn = 0
      for (let i = 0; i < 0x200; i++) {
        const built = buildMapInputs(rom, i, flags, undefined, undefined, () => graph)
        if (!built.ok || !built.inputs.l2?.ok) continue
        drawn++
        expect(built.inputs.l2.l2.note ?? '', `map ${i}`).not.toContain(EXIT_GRAPH_UNAVAILABLE)
      }
      expect(drawn).toBeGreaterThan(0)
    }, 120_000)
  },
)
