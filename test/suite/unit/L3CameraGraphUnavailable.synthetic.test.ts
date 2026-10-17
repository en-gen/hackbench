/**
 * #910: when the exit graph cannot be built, `chooseEntrance` has no `MapEntrances` and falls back to
 * the primary entrance. That is a guess about which entrance starts the map, so the layer 3 camera
 * must say it is unverified instead of reading the primary row silently. No ROM: the carts are built
 * here, and the corpus block at the end proves vanilla (whose graph builds) gains no note.
 */
import { describe, it, expect, vi } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import type * as L3ModelMod from '../../../src/rom/model/L3Model'
import {
  buildL3Verdict,
  EXIT_GRAPH_UNAVAILABLE,
  GRAPH_UNAVAILABLE,
} from '../../../src/rom/model/L3Model'
import { buildMapInputs, readMapEntrances } from '../../../theia/extension/src/node/map-screen'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import { VANILLA, freshRom, hasRom } from '../support/corpus'
import { modeTablesRom, STANDARD, withLayer3 } from '../support/l3Rom'

vi.mock('../../../src/rom/model/L3Model', async importOriginal => {
  const real = await importOriginal<typeof L3ModelMod>()
  return { ...real, buildL3Verdict: vi.fn(real.buildL3Verdict) }
})

const { buildL3Verdict: realBuild } = await vi.importActual<typeof L3ModelMod>('../../../src/rom/model/L3Model') // prettier-ignore
const MAP = 5
const header = parseLevelHeader(Uint8Array.from([0, 0, 0, 0, 0]))
const l1 = { header, isVertical: false, colors: [] } as never
const sheets = () => [[]] as never
const cart = () =>
  withLayer3(modeTablesRom([STANDARD, ...Array(31).fill(STANDARD)]), { level: MAP, tileset: 0, setting: 2, settingsByte: 0x02, word: 2 }) // prettier-ignore
const bg = { ok: true, mode: 1 } as const
const inputs = { header, isVertical: false, colors: [], screenCount: 1 }
const flags = { green: false, yellow: false, blue: false, red: false }

describe('the layer 3 camera when the exit graph is unavailable (synthetic)', () => {
  // `[]` spans: the entrance-position gate has nothing to compare, so the graph reason is the only one.
  const verdict = (entrances?: typeof GRAPH_UNAVAILABLE, noSpans = true) =>
    buildL3Verdict(cart(), MAP, l1, bg, sheets, { ok: true }, undefined, entrances, noSpans ? [] : undefined) // prettier-ignore

  it('says the camera is unverified, in plain words, and still draws it', () => {
    const v = verdict(GRAPH_UNAVAILABLE)
    expect(v.l3).not.toBeNull()
    expect(v.l3?.camYReasons).toEqual([EXIT_GRAPH_UNAVAILABLE])
    expect(EXIT_GRAPH_UNAVAILABLE).toMatch(/^HackBench could not work out which entrance/)
  })

  it('stays silent when the graph is available, or the call does not say', () => {
    expect(verdict(undefined).l3?.camYReasons).toBeUndefined()
  })

  it('lists the entrance-position reason and the graph reason separately when both apply', () => {
    // The default spans fingerprint vanilla code, which this synthetic cart does not hold.
    const reasons = verdict(GRAPH_UNAVAILABLE, false).l3?.camYReasons
    expect(reasons).toHaveLength(2)
    expect(reasons?.[0]).toMatch(/^\$[0-9A-F]{6} /)
    expect(reasons?.[1]).toBe(EXIT_GRAPH_UNAVAILABLE)
  })

  it('the Theia build: a graph that fails to build reaches the verdict as a note', () => {
    const raw = cart()
    raw.writeAt(0x00ffd5, [0x20]) // LoROM, which SmwRom checks
    const rom = new SmwRom(raw)
    // Real failure path: a zero-filled cart holds no stock exit code, so the real reader gives up.
    expect(readMapEntrances(rom)).toBeUndefined()
    const spy = vi.mocked(buildL3Verdict)
    // Inject only what a cart without GFX cannot give (chars, code gate); the graph arguments stay real.
    spy.mockImplementationOnce((r, i, w, b, _c, _g, s, e) => realBuild(r, i, w, b, sheets, { ok: true }, s, e, [])) // prettier-ignore
    const built = buildMapInputs(rom, MAP, flags, () => bg, () => ({ ok: true, inputs }) as never) // prettier-ignore
    expect(built.ok && built.inputs.l3?.l3?.camYReasons).toEqual([EXIT_GRAPH_UNAVAILABLE])
  })

  it('the Theia build: a map the available graph never reaches gets no note', () => {
    const rom = new SmwRom(cart())
    const spy = vi.mocked(buildL3Verdict)
    spy.mockImplementationOnce((r, i, w, b, _c, _g, s, e) => realBuild(r, i, w, b, sheets, { ok: true }, s, e, [])) // prettier-ignore
    const built = buildMapInputs(rom, MAP, flags, () => bg, () => ({ ok: true, inputs }) as never, () => new Map()) // prettier-ignore
    expect(built.ok && built.inputs.l3?.l3?.camYReasons).toBeUndefined()
  })
})

describe.skipIf(!hasRom(VANILLA))(
  'vanilla: the graph builds, so no map gains the note (corpus)',
  () => {
    it('every map with a layer 3 reads its camera without the graph note', () => {
      const rom = new SmwRom(freshRom(VANILLA))
      const graph = readMapEntrances(rom) // built once: 512 rebuilds time the test out
      expect(graph).toBeDefined()
      let drawn = 0
      for (let i = 0; i < 0x200; i++) {
        const built = buildMapInputs(rom, i, flags, undefined, undefined, () => graph)
        if (!built.ok) continue
        const note = (built.inputs.l3?.l3?.camYReasons ?? []).join(' ')
        if (built.inputs.l3?.l3) drawn++
        expect(note ?? '', `map ${i}`).not.toContain(EXIT_GRAPH_UNAVAILABLE)
      }
      expect(drawn).toBeGreaterThan(0) // the loop saw layer 3 maps, not an empty set
    }, 120_000)
  },
)
