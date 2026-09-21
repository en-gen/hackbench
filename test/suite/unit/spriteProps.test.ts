/**
 * spriteProps - read-only inspector model for a selected sprite.
 *
 * Locks what the map editor's sprite pane may claim. Every field is
 * derived from data the webview already holds (the Sprite model graph
 * plus the payload palette rows); nothing here reads the ROM.
 */

import { describe, expect, it } from 'vitest'
import { Sprite } from '../../../src/rom/model/sprites/Sprite'
import {
  StaticSpriteAppearance,
  type SpritePart,
} from '../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import type { SpriteAppearance } from '../../../src/rom/model/sprites/SpriteAppearance'
import type { SpriteBehavior } from '../../../src/rom/model/sprites/SpriteBehavior'
import { Char } from '../../../src/rom/model/chars/Char'
import {
  paintSpritePreviews,
  spriteProps,
  spritePropsHtml,
  spriteSelectionKey,
  type PreviewCanvas,
} from '../../../src/webview/mapEditor/spriteProps'

const NO_PIXELS = { getPixels: () => new Uint8Array(64) }

function part(
  charId: number,
  palette: number,
  flipX = false,
  flipY = false,
  dx = 0,
  dy = 0,
): SpritePart {
  return { char: new Char(charId, NO_PIXELS), palette, flipX, flipY, dx, dy }
}

/** A part whose every pixel is colour index 1, so a preview of it is visible. */
function solidPart(charId: number, palette: number, dx = 0, dy = 0): SpritePart {
  return {
    char: new Char(charId, { getPixels: () => new Uint8Array(64).fill(1) }),
    palette,
    flipX: false,
    flipY: false,
    dx,
    dy,
  }
}

/** Every `<canvas>` opening tag in a rendered pane. */
function canvasTags(html: string): string[] {
  return html.match(/<canvas [^>]*>/g) ?? []
}

const BEHAVIOR: SpriteBehavior = { kind: 'test', displayName: 'Green Koopa' }

function staticSprite(id: number, x: number, y: number, parts: SpritePart[]): Sprite {
  return new Sprite(id, x, y, new StaticSpriteAppearance(parts), BEHAVIOR)
}

/** An appearance that keeps its parts private, like SpikeTop or Wiggler. */
function opaqueAppearance(): SpriteAppearance {
  return {
    hitRect: { dx: 0, dy: 0, w: 16, h: 16 },
    render: () => {},
    tickAnimation: () => {},
  }
}

const PALETTE_ROWS: number[][][] = Array.from({ length: 16 }, (_, r) =>
  Array.from({ length: 16 }, (_, c) => [r * 16, c * 16, 0, 255]),
)

describe('spriteSelectionKey', () => {
  it('matches the id:x,y form used by the overlay toggle set', () => {
    expect(spriteSelectionKey(staticSprite(0x0f, 32, 48, [part(0x100, 8)]))).toBe('15:32,48')
  })

  it('distinguishes two copies of the same sprite id', () => {
    const a = staticSprite(0x0f, 32, 48, [part(0x100, 8)])
    const b = staticSprite(0x0f, 48, 48, [part(0x100, 8)])
    expect(spriteSelectionKey(a)).not.toBe(spriteSelectionKey(b))
  })
})

describe('spriteProps', () => {
  it('reports id, display name and tile position', () => {
    const p = spriteProps(staticSprite(0x0f, 32, 48, [part(0x100, 8)]))
    expect(p.id).toBe(0x0f)
    expect(p.displayName).toBe('Green Koopa')
    expect(p.col).toBe(2)
    expect(p.row).toBe(3)
  })

  it('lists every part char with its flip flags', () => {
    const p = spriteProps(
      staticSprite(0x0f, 0, 0, [
        part(0x100, 8, false, false),
        part(0x102, 8, true, false),
        part(0x120, 8, false, true),
      ]),
    )
    expect(
      p.parts?.map(({ char, palette, flipX, flipY }) => ({ char, palette, flipX, flipY })),
    ).toEqual([
      { char: 0x100, palette: 8, flipX: false, flipY: false },
      { char: 0x102, palette: 8, flipX: true, flipY: false },
      { char: 0x120, palette: 8, flipX: false, flipY: true },
    ])
  })

  it('carries each part displacement and its pixels, so the pane can draw it', () => {
    const p = spriteProps(staticSprite(0x0f, 0, 0, [solidPart(0x100, 8, 8, -16)]))
    expect(p.parts?.[0].dx).toBe(8)
    expect(p.parts?.[0].dy).toBe(-16)
    expect(p.parts?.[0].pixels).toHaveLength(64)
    expect(p.parts?.[0].pixels[0]).toBe(1)
  })

  it('collects the distinct palette rows the parts use, ascending', () => {
    const p = spriteProps(
      staticSprite(0x0f, 0, 0, [part(0x100, 10), part(0x101, 8), part(0x102, 10)]),
    )
    expect(p.paletteRows).toEqual([8, 10])
  })

  it('reports parts as unknown for an appearance that does not expose them', () => {
    const p = spriteProps(new Sprite(0x2e, 16, 16, opaqueAppearance(), { kind: 'spikeTop' }))
    expect(p.parts).toBeNull()
    expect(p.paletteRows).toEqual([])
  })

  it('marks a sprite animated only when its appearance ticks', () => {
    expect(spriteProps(staticSprite(0x0f, 0, 0, [part(0x100, 8)])).animated).toBe(false)
    expect(spriteProps(new Sprite(0x2e, 0, 0, opaqueAppearance(), { kind: 'k' })).animated).toBe(
      true,
    )
  })

  it('falls back to no display name when the behavior has none', () => {
    const s = new Sprite(0x12, 0, 0, new StaticSpriteAppearance([part(0x100, 8)]), { kind: 'k' })
    expect(spriteProps(s).displayName).toBeUndefined()
  })
})

describe('spritePropsHtml', () => {
  const html = (s: Sprite) => spritePropsHtml(spriteProps(s), PALETTE_ROWS)

  it('shows the sprite id in hex', () => {
    expect(html(staticSprite(0x0f, 32, 48, [part(0x100, 8)]))).toContain('$0F')
  })

  it('shows tile position as col and row', () => {
    const out = html(staticSprite(0x0f, 32, 48, [part(0x100, 8)]))
    expect(out).toMatch(/col[\s\S]*?\b2\b/i)
    expect(out).toMatch(/row[\s\S]*?\b3\b/i)
  })

  it('renders one swatch per color for each palette row in use', () => {
    const out = html(staticSprite(0x0f, 0, 0, [part(0x100, 9), part(0x101, 11)]))
    expect((out.match(/class="pp-swatch"/g) ?? []).length).toBe(32)
  })

  it('renders every part char in hex', () => {
    const out = html(staticSprite(0x0f, 0, 0, [part(0x100, 8), part(0x1ab, 8)]))
    expect(out).toContain('$100')
    expect(out).toContain('$1AB')
  })

  it('marks flipped parts and leaves unflipped ones unmarked', () => {
    const out = html(staticSprite(0x0f, 0, 0, [part(0x100, 8, true, true)]))
    expect(out).toContain('XY')
    expect(html(staticSprite(0x0f, 0, 0, [part(0x100, 8)]))).not.toContain('>XY<')
  })

  it('says so when the appearance does not expose its parts', () => {
    const out = spritePropsHtml(
      spriteProps(new Sprite(0x2e, 0, 0, opaqueAppearance(), { kind: 'k' })),
      PALETTE_ROWS,
    )
    expect(out).toMatch(/not exposed/i)
  })

  it('escapes a display name so payload text cannot inject markup', () => {
    const s = new Sprite(0x01, 0, 0, new StaticSpriteAppearance([part(0x100, 8)]), {
      kind: 'k',
      displayName: '<img src=x onerror=1>',
    })
    const out = spritePropsHtml(spriteProps(s), PALETTE_ROWS)
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
  })

  it('tolerates a palette row missing from the payload', () => {
    expect(() =>
      spritePropsHtml(spriteProps(staticSprite(0x0f, 0, 0, [part(0x100, 9)])), []),
    ).not.toThrow()
  })
})

describe('spritePropsHtml previews', () => {
  const html = (s: Sprite) => spritePropsHtml(spriteProps(s), PALETTE_ROWS)

  it('draws one tile canvas per part plus one composite', () => {
    const out = html(staticSprite(0x0f, 0, 0, [solidPart(0x100, 8), solidPart(0x101, 8, 8, 0)]))
    expect((out.match(/data-pp-part="/g) ?? []).length).toBe(2)
    expect((out.match(/data-pp-composite="/g) ?? []).length).toBe(1)
  })

  it('numbers the tile canvases in part order', () => {
    const out = html(
      staticSprite(0x0f, 0, 0, [solidPart(0x100, 8), solidPart(0x101, 8), solidPart(0x102, 8)]),
    )
    expect(out).toContain('data-pp-part="0"')
    expect(out).toContain('data-pp-part="2"')
    expect(out).not.toContain('data-pp-part="3"')
  })

  it('sizes the composite canvas to the union of the part displacements', () => {
    const out = html(staticSprite(0x0f, 0, 0, [solidPart(0x100, 8), solidPart(0x101, 8, 8, 16)]))
    const composite = canvasTags(out).find(t => t.includes('data-pp-composite'))!
    expect(composite).toContain('width="16"')
    expect(composite).toContain('height="24"')
  })

  it('upscales with whole-number nearest-neighbour steps', () => {
    for (const tag of canvasTags(html(staticSprite(0x0f, 0, 0, [solidPart(0x100, 8)])))) {
      expect(tag).toContain('image-rendering:pixelated')
      const [, css] = /width:(\d+)px/.exec(tag)!
      const [, intrinsic] = /width="(\d+)"/.exec(tag)!
      expect(Number(css) % Number(intrinsic)).toBe(0)
      expect(Number(css)).toBeGreaterThan(Number(intrinsic))
    }
  })

  it('bounds the parts grid so later sections are never pushed off the pane', () => {
    const out = html(
      staticSprite(
        0x0f,
        0,
        0,
        Array.from({ length: 64 }, (_, i) =>
          solidPart(0x100 + i, 8, (i % 8) * 8, Math.floor(i / 8) * 8),
        ),
      ),
    )
    expect(out).toMatch(/max-height:\d+px;overflow-y:auto/)
    expect(out.indexOf('ANIMATION')).toBeGreaterThan(out.indexOf('PARTS (64)'))
  })

  it('opens the parts fold for a small sprite and collapses it for a 64-part one', () => {
    expect(html(staticSprite(0x0f, 0, 0, [solidPart(0x100, 8)]))).toContain('<details open')
    const big = html(
      staticSprite(
        0x9f,
        0,
        0,
        Array.from({ length: 64 }, (_, i) => solidPart(0x100 + i, 8)),
      ),
    )
    expect(big).toContain('<details ')
    expect(big).not.toContain('<details open')
  })

  it('puts the assembled sprite above the position and parts sections', () => {
    const out = html(staticSprite(0x0f, 32, 48, [solidPart(0x100, 8)]))
    expect(out.indexOf('data-pp-composite')).toBeLessThan(out.indexOf('POSITION'))
  })

  it('draws no canvas at all when the appearance does not expose its parts', () => {
    const out = spritePropsHtml(
      spriteProps(new Sprite(0x2e, 0, 0, opaqueAppearance(), { kind: 'k' })),
      PALETTE_ROWS,
    )
    expect(canvasTags(out)).toEqual([])
    expect(out).toMatch(/not exposed/i)
  })

  it('describes animation as the editor rendering, never as a fact about the sprite', () => {
    const out = html(staticSprite(0x0f, 0, 0, [solidPart(0x100, 8)]))
    expect(out).toContain('not animated in the editor')
    expect(out).not.toMatch(/>\s*static\s*</)
    const ticking = spritePropsHtml(
      spriteProps(new Sprite(0x2e, 0, 0, opaqueAppearance(), { kind: 'k' })),
      PALETTE_ROWS,
    )
    expect(ticking).toContain('animated in the editor')
  })
})

describe('paintSpritePreviews', () => {
  interface Painted {
    attr: string
    w: number
    h: number
    data: Uint8ClampedArray
  }

  function fakeCanvas(attr: string, value: string, out: Painted[]): PreviewCanvas {
    return {
      getAttribute: (n: string) => (n === attr ? value : null),
      getContext: () => ({
        putImageData: (img: never) =>
          out.push({ attr, ...(img as unknown as Omit<Painted, 'attr'>) }),
      }),
    }
  }

  const makeImage = (data: Uint8ClampedArray, w: number, h: number) => ({ data, w, h })

  /** Part i is solid colour index i+1, so each tile is identifiable by pixel. */
  function distinctParts(count: number) {
    return spriteProps(
      new Sprite(
        0x0f,
        0,
        0,
        new StaticSpriteAppearance(
          Array.from({ length: count }, (_, i) => ({
            char: new Char(0x100 + i, { getPixels: () => new Uint8Array(64).fill(i + 1) }),
            palette: 8,
            flipX: false,
            flipY: false,
            dx: i * 8,
            dy: 0,
          })),
        ),
        BEHAVIOR,
      ),
    ).parts!
  }

  it('paints each tile canvas from its own part, not a neighbour', () => {
    const parts = distinctParts(3)
    const out: Painted[] = []
    paintSpritePreviews(
      [0, 1, 2].map(i => fakeCanvas('data-pp-part', String(i), out)),
      parts,
      PALETTE_ROWS,
      makeImage,
    )
    expect(out.map(p => [p.w, p.h])).toEqual([
      [8, 8],
      [8, 8],
      [8, 8],
    ])
    // PALETTE_ROWS[8][n] is [128, n*16, 0]; the red channel is constant, so
    // the green channel identifies which colour index, hence which part, was drawn.
    expect(out.map(p => p.data[1])).toEqual([16, 32, 48])
  })

  it('paints the composite canvas with every part at its displacement', () => {
    const parts = distinctParts(3)
    const out: Painted[] = []
    paintSpritePreviews([fakeCanvas('data-pp-composite', '1', out)], parts, PALETTE_ROWS, makeImage)
    expect([out[0].w, out[0].h]).toEqual([24, 8])
    expect(out[0].data[1]).toBe(16) // x=0  from part 0
    expect(out[0].data[8 * 4 + 1]).toBe(32) // x=8  from part 1
    expect(out[0].data[16 * 4 + 1]).toBe(48) // x=16 from part 2
  })

  it('does nothing for an appearance with no parts to draw', () => {
    const out: Painted[] = []
    paintSpritePreviews([fakeCanvas('data-pp-composite', '1', out)], null, PALETTE_ROWS, makeImage)
    expect(out).toEqual([])
  })

  it('skips a canvas that carries no preview attribute', () => {
    const out: Painted[] = []
    paintSpritePreviews(
      [fakeCanvas('data-other', '1', out)],
      distinctParts(1),
      PALETTE_ROWS,
      makeImage,
    )
    expect(out).toEqual([])
  })
})
