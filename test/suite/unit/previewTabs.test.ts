/**
 * `previewId` is the identity of a view's preview tab, and `pin` has to
 * look up the SAME identity that `preview` created or it retires nothing.
 *
 * This file exists because `PreviewTabs` had no test of any kind while four
 * views shared it, and a key-shape mismatch between `preview` and `pin`
 * silently stopped three of them retiring their preview tab. Double-clicking
 * a row left two tabs of one thing. Nothing failed, because nothing looked.
 */
import { describe, it, expect } from 'vitest'
import { previewId } from '../../../theia/extension/src/browser/preview-id'

const GFX = 'hackbench.gfx-view'
const MAP16 = 'hackbench.map16-view'

describe('previewId', () => {
  it('gives a view with one preview tab a single stable identity', () => {
    expect(previewId(GFX)).toBe(`${GFX}:preview`)
    expect(previewId(GFX, {})).toBe(previewId(GFX))
  })

  it('splits identity where a view has genuinely independent tabs', () => {
    expect(previewId(MAP16, { layer: 'fg' })).not.toBe(previewId(MAP16, { layer: 'bg' }))
  })

  it('does not depend on key order, so two call sites cannot disagree', () => {
    expect(previewId(MAP16, { layer: 'fg', tileset: 3 })).toBe(
      previewId(MAP16, { tileset: 3, layer: 'fg' }),
    )
  })

  it('ignores undefined members, which a spread of optional options produces', () => {
    expect(previewId(MAP16, { layer: 'fg', variant: undefined })).toBe(
      previewId(MAP16, { layer: 'fg' }),
    )
  })

  /**
   * The regression itself, stated as an identity rather than as behavior so
   * it needs no shell. A view's ROW key and its PREVIEW TAB key are
   * different things: the GFX view opens a widget per row (`{ index }`) but
   * has ONE preview tab (`{}`). Deriving the tab id from the row key yields
   * a different id per row, so the lookup never matched and the italic tab
   * was never closed.
   */
  it('a row key and a preview-tab key are not interchangeable', () => {
    const rowKeyed = previewId(GFX, { index: 7 })
    const tabKeyed = previewId(GFX, {})
    expect(rowKeyed).not.toBe(tabKeyed)
    // And every row would produce yet another id, which is why nothing matched.
    expect(previewId(GFX, { index: 8 })).not.toBe(rowKeyed)
  })
})
