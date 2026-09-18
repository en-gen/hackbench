/**
 * propsPane - which inspector pane is visible, and what the sprite pane
 * is filled with.
 *
 * The map editor's right-hand panel stacks four panes and shows one. The
 * sprite pane existed but nothing ever switched to it or wrote into it,
 * so these tests lock both halves of that wiring.
 */

import { describe, expect, it } from 'vitest'
import { Sprite } from '../../../src/rom/model/sprites/Sprite'
import { StaticSpriteAppearance, type SpritePart } from '../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import { Char } from '../../../src/rom/model/chars/Char'
import { setPropContext, showSpriteProps, type PaneEl, type PaneHost } from '../../../src/webview/mapEditor/propsPane'
import type { PreviewCanvas } from '../../../src/webview/mapEditor/spriteProps'

const PANE_IDS = ['pp-tile', 'pp-sprite', 'pp-object', 'pp-empty', 'props-ctx']

function makeHost(): PaneHost & { els: Map<string, PaneEl> } {
  const els = new Map<string, PaneEl>()
  for (const id of PANE_IDS) {
    els.set(id, { style: { display: '' }, innerHTML: '', textContent: null, setAttribute: () => {} })
  }
  return { els, getElementById: (id: string) => els.get(id) ?? null }
}

const NO_PIXELS = { getPixels: () => new Uint8Array(64) }
function part(charId: number): SpritePart {
  return { char: new Char(charId, NO_PIXELS), palette: 8, flipX: false, flipY: false, dx: 0, dy: 0 }
}

/**
 * Stands in for the canvases a real pane would hold after `innerHTML`.
 * A plain PaneEl has no DOM behind it, so the pane cannot parse the markup
 * it just wrote; this supplies the elements the selector would have found.
 */
function withCanvases(host: ReturnType<typeof makeHost>, attrs: readonly [string, string][]) {
  const painted: { w: number; h: number }[] = []
  const canvases: PreviewCanvas[] = attrs.map(([name, value]) => ({
    getAttribute: (n: string) => (n === name ? value : null),
    getContext: () => ({ putImageData: (img: never) => painted.push(img as unknown as { w: number; h: number }) }),
  }))
  const pane = host.els.get('pp-sprite')!
  const selectors: string[] = []
  pane.querySelectorAll = (sel: string) => { selectors.push(sel); return canvases }
  return { painted, selectors }
}
function sprite(id: number, x: number, y: number, charId = 0x100, displayName?: string): Sprite {
  return new Sprite(id, x, y, new StaticSpriteAppearance([part(charId)]), { kind: 'k', displayName })
}

const PALETTE_ROWS: number[][][] = Array.from({ length: 16 }, () =>
  Array.from({ length: 16 }, () => [0, 0, 0, 255]))

describe('setPropContext', () => {
  it('shows exactly the requested pane', () => {
    const host = makeHost()
    setPropContext(host, 'sprite', 'Goomba')
    expect(host.els.get('pp-sprite')!.style.display).toBe('block')
    expect(host.els.get('pp-tile')!.style.display).toBe('none')
    expect(host.els.get('pp-object')!.style.display).toBe('none')
    expect(host.els.get('pp-empty')!.style.display).toBe('none')
  })

  it('switches away from the sprite pane when a tile is picked', () => {
    const host = makeHost()
    setPropContext(host, 'sprite', 'Goomba')
    setPropContext(host, 'tile', 'Map16 $100')
    expect(host.els.get('pp-sprite')!.style.display).toBe('none')
    expect(host.els.get('pp-tile')!.style.display).toBe('block')
  })

  it('lays the empty pane out as a flex box, not a block', () => {
    const host = makeHost()
    setPropContext(host, 'empty')
    expect(host.els.get('pp-empty')!.style.display).toBe('flex')
  })

  it('writes the label into the header', () => {
    const host = makeHost()
    setPropContext(host, 'sprite', 'Goomba')
    expect(host.els.get('props-ctx')!.textContent).toBe('Goomba')
  })

  it('tolerates a host with no panes at all', () => {
    expect(() => setPropContext({ getElementById: () => null }, 'sprite', 'x')).not.toThrow()
  })
})

describe('showSpriteProps', () => {
  it('brings the sprite pane to the front', () => {
    const host = makeHost()
    setPropContext(host, 'tile', 'Map16 $100')
    showSpriteProps(host, sprite(0x0F, 32, 48), PALETTE_ROWS)
    expect(host.els.get('pp-sprite')!.style.display).toBe('block')
    expect(host.els.get('pp-tile')!.style.display).toBe('none')
  })

  it('fills the pane with the sprite it was given', () => {
    const host = makeHost()
    showSpriteProps(host, sprite(0x0F, 32, 48, 0x1AB), PALETTE_ROWS)
    const html = host.els.get('pp-sprite')!.innerHTML
    expect(html).toContain('$0F')
    expect(html).toContain('$1AB')
  })

  it('replaces the previous sprite rather than appending to it', () => {
    const host = makeHost()
    showSpriteProps(host, sprite(0x0F, 32, 48, 0x1AB), PALETTE_ROWS)
    showSpriteProps(host, sprite(0x26, 64, 48, 0x120), PALETTE_ROWS)
    const html = host.els.get('pp-sprite')!.innerHTML
    expect(html).toContain('$26')
    expect(html).toContain('$120')
    expect(html).not.toContain('$1AB')
  })

  it('distinguishes two placements of the same sprite id by position', () => {
    const a = makeHost(); const b = makeHost()
    showSpriteProps(a, sprite(0x0F, 32, 48), PALETTE_ROWS)
    showSpriteProps(b, sprite(0x0F, 160, 48), PALETTE_ROWS)
    expect(a.els.get('pp-sprite')!.innerHTML).not.toBe(b.els.get('pp-sprite')!.innerHTML)
  })

  it('heads the panel with the display name when there is one', () => {
    const host = makeHost()
    showSpriteProps(host, sprite(0x0F, 0, 0, 0x100, 'Goomba'), PALETTE_ROWS)
    expect(host.els.get('props-ctx')!.textContent).toBe('Goomba')
  })

  it('falls back to the hex id when there is no display name', () => {
    const host = makeHost()
    showSpriteProps(host, sprite(0x12, 0, 0), PALETTE_ROWS)
    expect(host.els.get('props-ctx')!.textContent).toBe('Sprite $12')
  })

  it('paints the preview canvases it just wrote into the pane', () => {
    const host = makeHost()
    const { painted, selectors } = withCanvases(host,
      [['data-pp-composite', '1'], ['data-pp-part', '0']])
    showSpriteProps(host, sprite(0x0F, 0, 0), PALETTE_ROWS, (_d, w, h) => ({ w, h }))
    expect(selectors[0]).toContain('data-pp-part')
    expect(selectors[0]).toContain('data-pp-composite')
    expect(painted).toEqual([{ w: 8, h: 8 }, { w: 8, h: 8 }])
  })

  it('still fills the pane when the host element cannot be queried', () => {
    const host = makeHost()
    expect(() => showSpriteProps(host, sprite(0x0F, 0, 0), PALETTE_ROWS)).not.toThrow()
    expect(host.els.get('pp-sprite')!.innerHTML).toContain('$0F')
  })
})
