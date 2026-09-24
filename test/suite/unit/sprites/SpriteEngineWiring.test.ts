/**
 * The seam, tested where it actually has to hold: after `buildGraph`.
 *
 * This codebase's recurring silent failure is an appearance that degrades to
 * a bare shipped class on the webview side of rehydrate with nothing going
 * red. So these tests do not construct an `EngineSpriteAppearance` directly.
 * They serialize a real level the way the host does, rehydrate it the way the
 * webview does, and assert on what came out the far end.
 *
 * Map $010 is used because the vanilla cart places twelve $4D and eighteen
 * $4E there, which is the largest descriptor-sprite population in the game
 * (measured by parsing every level's sprite stream in the vanilla ROM).
 *
 * Evidence scope: vanilla ROM in the corpus, static reads, no emulator.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effect } from '@vue/reactivity'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildMapPayload } from '../../../../src/rom/model/MapBuilder'
import { buildGraph } from '../../../../src/rom/model/rehydrate'
import { editorStore } from '../../../../src/rom/model/stores/editorStore'
import { EngineSpriteAppearance } from '../../../../src/rom/model/sprites/generic/EngineSpriteAppearance'
import { SPRITE_DRAW_DESCRIPTORS } from '../../../../src/rom/model/sprites/generic/SpriteDrawDescriptor'
import {
  drawSpriteParts,
  resolveHandlerBase,
  resolveRef,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawEngine'
import { readSpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import { bgr555ToRgba } from '../../../../src/rom/GraphicsDecoder'
import type { RenderTarget, PixelPos, PixelSize } from '../../../../src/rom/model/RenderTarget'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { VANILLA, hasRom, romPath } from '../../support/corpus'

const VANILLA_PATH = romPath(VANILLA)
const romPresent = hasRom(VANILLA)
/** $010 carries both Monty Mole variants; see the file header. */
const MAP_WITH_MOLES = 0x010
/** $11C is one of only two vanilla maps whose sprite stream holds a $1F. */
const MAP_WITH_MAGIKOOPA = 0x11c
const DESCRIPTOR_IDS = new Set(SPRITE_DRAW_DESCRIPTORS.map(d => d.spriteId))

/** Records what was asked of the framebuffer without owning a canvas. */
class RecordingTarget implements RenderTarget {
  readonly blits: { x: number; y: number; ink: number }[] = []
  readonly rects: { x: number; y: number; w: number; h: number; color: RgbaColor }[] = []
  /** The CGRAM rows handed to `blit8x8`, copied because `Palette.row`
   *  returns a shared scratch buffer that the next call overwrites. */
  readonly rows: RgbaColor[][] = []
  blit8x8(pixels: Uint8Array, pos: PixelPos, row?: RgbaColor[]): void {
    if (row) this.rows.push(row.map(c => [...c] as RgbaColor))
    // `ink` is a cheap content signature. Without it, a frame change that
    // swaps the CHAR but keeps the corner positions reads as no change.
    let ink = 0
    for (let i = 0; i < pixels.length; i++) ink = (ink * 31 + pixels[i]) | 0
    this.blits.push({ x: pos.x, y: pos.y, ink })
  }
  fillRect(pos: PixelPos, size: PixelSize, color: RgbaColor): void {
    this.rects.push({ x: pos.x, y: pos.y, w: size.w, h: size.h, color })
  }
}

/** Build the webview-side graph exactly as the message handler does. */
function rehydrateMap(levelId: number) {
  const smw = SmwRom.open(VANILLA_PATH)
  const payload = buildMapPayload(smw, levelId)
  // The ROM comes back so a test can plant a byte in it: appearances hold
  // the reference and re-read at render time, so a plant after the build
  // still reaches the render.
  return { ...buildGraph(payload, smw.rom), rom: smw.rom }
}

describe('sprite engine wiring (webview boundary)', () => {
  beforeEach(() => {
    editorStore.setSpriteEngine(false)
    editorStore.setSpriteEngineMarkers(true)
  })

  it.skipIf(!romPresent)('default state is OFF, so nothing changes unless asked', () => {
    expect(editorStore.spriteEngine).toBe(false)
  })

  it.skipIf(!romPresent)(
    'attaches an engine appearance to descriptor sprites after rehydrate',
    () => {
      const { map } = rehydrateMap(MAP_WITH_MOLES)
      const withDescriptor = map.sprites.filter(s => DESCRIPTOR_IDS.has(s.id))
      expect(withDescriptor.length).toBeGreaterThan(0)
      for (const s of withDescriptor) {
        expect(s.engineAppearance).toBeInstanceOf(EngineSpriteAppearance)
      }
    },
  )

  it.skipIf(!romPresent)('leaves sprites without a descriptor untouched', () => {
    const { map } = rehydrateMap(MAP_WITH_MOLES)
    const others = map.sprites.filter(s => !DESCRIPTOR_IDS.has(s.id))
    expect(others.length).toBeGreaterThan(0)
    for (const s of others) expect(s.engineAppearance).toBeUndefined()
  })

  it.skipIf(!romPresent)('toggle OFF renders the shipped appearance', () => {
    const { map } = rehydrateMap(MAP_WITH_MOLES)
    const s = map.sprites.find(x => x.id === 0x4d)!
    let shipped = 0
    const spy = {
      ...s.appearance,
      render: () => {
        shipped++
      },
    }
    Object.defineProperty(s, 'appearance', { value: spy, configurable: true })
    s.render(new RecordingTarget(), map.mapStore)
    expect(shipped).toBe(1)
  })

  it.skipIf(!romPresent)('toggle ON routes a descriptor sprite through the engine', () => {
    const { map } = rehydrateMap(MAP_WITH_MOLES)
    const s = map.sprites.find(x => x.id === 0x4d)!
    let shipped = 0
    Object.defineProperty(s, 'appearance', {
      value: {
        ...s.appearance,
        render: () => {
          shipped++
        },
      },
      configurable: true,
    })
    editorStore.setSpriteEngine(true)
    const target = new RecordingTarget()
    s.render(target, map.mapStore)
    expect(shipped).toBe(0)
    // sub0 emits four independent 8x8 chars.
    expect(target.blits.length).toBe(4)
  })

  it.skipIf(!romPresent)('marks engine-rendered sprites, and stops when markers are off', () => {
    const { map } = rehydrateMap(MAP_WITH_MOLES)
    const s = map.sprites.find(x => x.id === 0x4d)!
    editorStore.setSpriteEngine(true)

    const marked = new RecordingTarget()
    s.render(marked, map.mapStore)
    expect(marked.rects.length).toBeGreaterThan(0)

    editorStore.setSpriteEngineMarkers(false)
    const bare = new RecordingTarget()
    s.render(bare, map.mapStore)
    expect(bare.rects.length).toBe(0)
    // Turning the marker off must not change a single pixel of the sprite.
    expect(bare.blits).toEqual(marked.blits)
  })

  it.skipIf(!romPresent)('engine sprites advance on the shared sprite timer', () => {
    const { map } = rehydrateMap(MAP_WITH_MOLES)
    const s = map.sprites.find(x => x.id === 0x4d)!
    editorStore.setSpriteEngine(true)
    const before = new RecordingTarget()
    s.render(before, map.mapStore)
    // $4D animates off EffFrame >> 4, so 16 game frames = 3 editor ticks at
    // 7.5 frames each. `tickAnimation` is the only advance mechanism.
    for (let i = 0; i < 3; i++) s.tickAnimation()
    const after = new RecordingTarget()
    s.render(after, map.mapStore)
    expect(after.blits).not.toEqual(before.blits)
  })

  it.skipIf(!romPresent)('flipping the toggle re-runs the render effect, with no reload', () => {
    const { map } = rehydrateMap(MAP_WITH_MOLES)
    // Stand-in for `renderModelOverlay`: the webview wraps the same
    // `map.render(target)` call in `effect()`. If the toggle were not a
    // tracked dependency, clicking the button would change nothing on screen
    // until some other input happened to invalidate the effect.
    let passes = 0
    effect(() => {
      passes++
      map.render(new RecordingTarget())
    })
    expect(passes).toBe(1)
    editorStore.setSpriteEngine(true)
    expect(passes).toBe(2)
    editorStore.setSpriteEngineMarkers(false)
    expect(passes).toBe(3)
  })

  it.skipIf(!romPresent)(
    '$1F is drawn with the palette its teleport uploads, not the level row',
    () => {
      const { map } = rehydrateMap(MAP_WITH_MAGIKOOPA)
      const s = map.sprites.find(x => x.id === 0x1f)!
      editorStore.setSpriteEngine(true)
      const target = new RecordingTarget()
      s.render(target, map.mapStore)
      expect(target.blits.length).toBeGreaterThan(0)

      // Read what the descriptor says the hardware leaves in CGRAM, straight
      // from the cart, so nothing ROM-derived is written down here.
      const smw = SmwRom.open(VANILLA_PATH)
      const d = SPRITE_DRAW_DESCRIPTORS.find(x => x.spriteId === 0x1f)!
      const res = drawSpriteParts({
        rom: smw.rom,
        tables: readSpriteTileTables(smw.rom)!,
        descriptor: d,
        spriteX: 0,
        ctx: { marioX: 0, romFrame: 0 },
      })
      expect(res.ok).toBe(true)
      const note = res.ok ? res.paletteNote! : undefined!
      const raw = smw.rom.readAt(note.entryAddr, note.colors * 2)!
      const uploaded = Array.from({ length: note.colors }, (_, i) =>
        bgr555ToRgba(raw[i * 2] | (raw[i * 2 + 1] << 8)),
      )

      const level = map.mapStore.palette.row(note.row).map(c => [...c] as RgbaColor)
      for (const row of target.rows) {
        // The uploaded window replaces the level palette.
        for (let i = 0; i < note.colors; i++) {
          expect(row[note.firstCol + i]).toEqual(uploaded[i])
        }
        // Everything outside it is still the level's own row. This is the
        // whole reason the note carries a column window instead of a row.
        for (let i = note.firstCol + note.colors; i < level.length; i++) {
          expect(row[i]).toEqual(level[i])
        }
      }
      // A composite that changed nothing would mean the note was ignored.
      expect(
        target.rows.some(r =>
          r
            .slice(note.firstCol, note.firstCol + note.colors)
            .some((c, i) => JSON.stringify(c) !== JSON.stringify(level[note.firstCol + i])),
        ),
      ).toBe(true)
    },
  )

  it.skipIf(!romPresent)('$1F draws its wand, and the marker box is wide enough to hold it', () => {
    const { map } = rehydrateMap(MAP_WITH_MAGIKOOPA)
    const s = map.sprites.find(x => x.id === 0x1f)!
    editorStore.setSpriteEngine(true)
    const target = new RecordingTarget()
    s.render(target, map.mapStore)
    // Eight body subtiles, plus the wand on the cast poses.
    expect(target.blits.length).toBeGreaterThanOrEqual(8)

    // The marker box is the union over every frame, so it must span the
    // wand's column even on a frame that does not draw it. Four corner ticks
    // are emitted as eight rects; take the horizontal extent they cover.
    const xs = target.rects.map(r => r.x)
    const blitXs = target.blits.map(b => b.x)
    expect(Math.min(...xs)).toBeLessThanOrEqual(Math.min(...blitXs))
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(Math.max(...blitXs))
    // And it is wider than the 16 px the body alone occupies.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(16)
  })

  it.skipIf(!romPresent)(
    'a repointed draw handler renders the fallback and is marked unverified',
    () => {
      const smw = SmwRom.open(VANILLA_PATH)
      const payload = buildMapPayload(smw, MAP_WITH_MOLES)
      // Repoint $4D's MAIN entry in an in-memory copy of the cart. Nothing is
      // saved, so the corpus is untouched.
      smw.rom.writeAt(0x0185cc + 0x4d * 2, [0x34, 0x12])
      const { map } = buildGraph(payload, smw.rom)
      const s = map.sprites.find(x => x.id === 0x4d)!
      const eng = s.engineAppearance as EngineSpriteAppearance
      expect(eng.provenance.kind).toBe('diverged')

      // The engine captured the shipped appearance at construction, so the
      // spy has to replace the captured reference, not `s.appearance`.
      let shipped = 0
      Object.defineProperty(eng, 'fallback', {
        value: {
          ...eng.fallback,
          render: () => {
            shipped++
          },
        },
        configurable: true,
      })
      editorStore.setSpriteEngine(true)
      const target = new RecordingTarget()
      s.render(target, map.mapStore)
      expect(shipped).toBe(1)
      expect(target.blits.length).toBe(0)
      // Amber marker, visibly different from the engine's cyan ticks.
      expect(target.rects.length).toBeGreaterThan(0)
      expect(target.rects[0].color).toEqual([255, 170, 40, 255])
    },
  )
})

// ── Render-time failures are visible, and distinct from a repointed handler ─

/**
 * A render failure used to degrade exactly like a provenance divergence: the
 * shipped appearance, the same amber ticks, no log. So `unknownDrawRoutine`,
 * `unexpectedOpcode`, `nudgeTargetOutOfRange`, `unmodelledTailCall` and
 * `romReadFailed` were indistinguishable from "this cart repointed the
 * handler", and with markers off they were invisible entirely.
 *
 * The distinction matters because the two are actionable differently. A
 * repointed handler is a property of the cart and nothing can be done about
 * it; a render failure on a cart whose pointers are stock is an engine gap or
 * a partially rewritten handler, and is worth chasing.
 *
 * The plant below NOPs $1F's `JSR SubSprGfx1` (bank_01.asm:8529) without
 * touching either pointer table, so provenance stays vanilla and only the
 * render fails.
 */
describe('a render failure is reported, not silently swallowed', () => {
  beforeEach(() => {
    editorStore.setSpriteEngine(true)
    editorStore.setSpriteEngineMarkers(true)
  })

  const breakMagikoopa = () => {
    const built = rehydrateMap(MAP_WITH_MAGIKOOPA)
    const s = built.map.sprites.find(x => x.id === 0x1f)!
    const d = SPRITE_DRAW_DESCRIPTORS.find(x => x.spriteId === 0x1f)!
    const at = resolveRef(built.rom, d.routineJsr!, resolveHandlerBase(built.rom, d))!
    built.rom.writeAt(at, [0xea])
    return { ...built, sprite: s }
  }

  // FIRST in this block on purpose: the log is deduplicated by sprite and
  // failure kind for the life of the module, so a test that runs after
  // another which already triggered `$1F:unexpectedOpcode` would see no
  // call and pass vacuously.
  it.skipIf(!romPresent)('logs the reason once, naming the failure kind', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { sprite, map } = breakMagikoopa()
      sprite.render(new RecordingTarget(), map.mapStore)
      sprite.render(new RecordingTarget(), map.mapStore)
      const declines = warn.mock.calls.filter(c => String(c[1]).includes('engine declined'))
      // Once, not once per rendered frame.
      expect(declines).toHaveLength(1)
      expect(String(declines[0][1])).toContain('unexpectedOpcode')
      expect(String(declines[0][1])).toContain('$1F')
    } finally {
      warn.mockRestore()
    }
  })
  it.skipIf(!romPresent)('falls back to the shipped appearance and still draws', () => {
    const { sprite, map } = breakMagikoopa()
    const target = new RecordingTarget()
    sprite.render(target, map.mapStore)
    expect(target.blits.length).toBeGreaterThan(0)
  })

  it.skipIf(!romPresent)('marks it in its OWN colour, not the unverified amber', () => {
    const before = new RecordingTarget()
    const ok = rehydrateMap(MAP_WITH_MAGIKOOPA)
    ok.map.sprites.find(x => x.id === 0x1f)!.render(before, ok.map.mapStore)

    const { sprite, map } = breakMagikoopa()
    const after = new RecordingTarget()
    sprite.render(after, map.mapStore)

    const colours = (t: RecordingTarget) => new Set(t.rects.map(r => r.color.join(',')))
    // A healthy render marks with MARK_ENGINE; a declined one must use
    // neither that nor MARK_UNVERIFIED, or the two fallback reasons collapse.
    expect(colours(after)).not.toEqual(colours(before))
    expect(colours(after).size).toBeGreaterThan(0)
    // MARK_UNVERIFIED, the repointed-handler amber.
    expect([...colours(after)]).not.toContain('255,170,40,255')
  })
})
