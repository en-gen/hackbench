/**
 * `previewId` is the identity of a view's preview tab, and `pin` has to
 * look up the SAME identity that `preview` created or it retires nothing.
 *
 * This file exists because `PreviewTabs` had no test of any kind while four
 * views shared it, and a key-shape mismatch between `preview` and `pin`
 * silently stopped three of them retiring their preview tab. Double-clicking
 * a row left two tabs of one thing. Nothing failed, because nothing looked.
 */
import fs from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { previewId } from '../../../theia/extension/src/browser/preview-id'

// `pin` runs against fakes, since Theia's modules need a DOM; the mock names the resolved file because a bare specifier does not match it.
const browser = vi.hoisted(
  () => `${__dirname}/../../../theia/node_modules/@theia/core/lib/browser/index.js`,
)
const theiaInstalled = fs.existsSync(browser)
it('Theia is installed wherever HB_REQUIRE_THEIA says it must be', () => {
  if (process.env.HB_REQUIRE_THEIA) expect(theiaInstalled).toBe(true)
})
vi.mock(browser, () => ({ ApplicationShell: class {}, WidgetManager: class {}, Widget: class {} }))
vi.mock('../../../theia/extension/src/browser/project-context', () => ({
  ProjectContext: class {},
}))
vi.mock('../../../theia/extension/src/browser/project-bound', () => ({ boundToOther: () => [] }))

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

describe.skipIf(!theiaInstalled)(
  'PreviewTabs.pin hands apply the preview to carry from (#1299)',
  () => {
    const fake = () => ({ id: previewId('v', {}), title: { className: '' }, close: vi.fn() })
    it.each([
      ['the same row', true, true],
      ['another row', true, false],
      ['no preview', false, true],
    ])('%s', async (_, hasPreview, sameRow) => {
      const { PreviewTabs } = await import('../../../theia/extension/src/browser/preview-tabs')
      const [preview, pinned] = [fake(), { ...fake(), id: 'row' }]
      const tabs = new PreviewTabs() as any
      tabs.shell = { widgets: hasPreview ? [preview] : [], addWidget() {}, activateWidget() {} }
      tabs.widgets = { getOrCreateWidget: async () => pinned }
      tabs.context = {}
      const apply = vi.fn(async () => {})
      await tabs.pin('v', {}, apply, () => sameRow, {})
      expect(apply).toHaveBeenCalledWith(pinned, hasPreview && sameRow ? preview : undefined)
    })
  },
)
