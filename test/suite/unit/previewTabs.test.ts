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

describe.skipIf(!theiaInstalled)(
  'PreviewTabs.preview focuses a row that already has a tab (#1324)',
  () => {
    const setup = async (open: object | undefined) => {
      const { PreviewTabs } = await import('../../../theia/extension/src/browser/preview-tabs')
      const previewWidget = {
        id: 'x',
        isDisposed: false,
        isAttached: false,
        title: { className: '' },
      }
      const tabs = new PreviewTabs() as any
      const shell = { addWidget: vi.fn(), activateWidget: vi.fn(), revealWidget: vi.fn() }
      const getOrCreateWidget = vi.fn(async () => previewWidget)
      const tryGetWidget = vi.fn(() => open)
      Object.assign(tabs, { shell, context: {}, widgets: { getOrCreateWidget, tryGetWidget } })
      return { tabs, shell, getOrCreateWidget, tryGetWidget, previewWidget }
    }
    const row = { index: 7 }

    it('activates the open tab, asks for it by the row key, and opens no preview', async () => {
      const tab = { id: 'v:7', isDisposed: false, isAttached: true }
      const s = await setup(tab)
      const apply = vi.fn(async () => {})
      expect(await s.tabs.preview('v', apply, row)).toBe(tab)
      expect(s.tryGetWidget).toHaveBeenCalledWith('v', row)
      expect(s.shell.activateWidget).toHaveBeenCalledWith('v:7')
      expect(s.getOrCreateWidget).not.toHaveBeenCalled()
      expect(apply).not.toHaveBeenCalled()
      expect(s.shell.addWidget).not.toHaveBeenCalled()
    })

    it.each([
      ['no tab', undefined],
      ['a tab that was never attached', { id: 'v:7', isDisposed: false, isAttached: false }],
      ['a disposed tab', { id: 'v:7', isDisposed: true, isAttached: true }],
    ])('still previews the row with %s', async (_, open) => {
      const s = await setup(open)
      const apply = vi.fn(async () => {})
      expect(await s.tabs.preview('v', apply, row)).toBe(s.previewWidget)
      expect(apply).toHaveBeenCalledWith(s.previewWidget)
      expect(s.shell.addWidget).toHaveBeenCalledTimes(1)
      expect(s.shell.activateWidget).not.toHaveBeenCalled()
    })
  },
)

/**
 * CodeRabbit on #1366: preview B of row Y is still inside `apply` (Map16's is
 * a JSON-RPC sheet load) when the user picks tab A. B must still land - the
 * row was asked for - but revealing it would cover the tab picked after it.
 */
describe.skipIf(!theiaInstalled)(
  'PreviewTabs.preview does not reveal over a tab focused while it loaded (#1324)',
  () => {
    const setup = async () => {
      const { PreviewTabs } = await import('../../../theia/extension/src/browser/preview-tabs')
      const b = { id: 'b', isDisposed: false, isAttached: false, title: { className: '' } }
      const a = { id: 'a', isDisposed: false, isAttached: true, title: { className: '' } }
      const tabs = new PreviewTabs() as any
      const calls: string[] = []
      const shell = {
        widgets: [] as unknown[],
        addWidget: vi.fn((w: { id: string }) => calls.push(`add ${w.id}`)),
        activateWidget: vi.fn((id: string) => calls.push(`activate ${id}`)),
        revealWidget: vi.fn((id: string) => calls.push(`reveal ${id}`)),
      }
      const rows = new Map<number, object>([[1, a]])
      const tryGetWidget = vi.fn((_: string, row: { index: number }) => rows.get(row.index))
      const getOrCreateWidget = vi.fn(async () => b)
      Object.assign(tabs, { shell, context: {}, widgets: { getOrCreateWidget, tryGetWidget } })
      let release!: () => void
      const held = vi.fn(() => new Promise<void>(r => (release = r)))
      return { tabs, shell, calls, a, b, held, release: () => release(), getOrCreateWidget }
    }

    it('attaches B but leaves the focused tab A current', async () => {
      const s = await setup()
      const loadingB = s.tabs.preview('v', s.held, { index: 2 })
      await vi.waitFor(() => expect(s.held).toHaveBeenCalled())
      expect(await s.tabs.preview('v', vi.fn(), { index: 1 })).toBe(s.a)
      s.release()
      expect(await loadingB).toBe(s.b)
      expect(s.calls).toEqual(['activate a', 'add v:preview'])
      expect(s.shell.revealWidget).not.toHaveBeenCalled()
    })

    it('attaches B but leaves a tab pinned while it loaded current', async () => {
      const s = await setup()
      const loadingB = s.tabs.preview('v', s.held, { index: 2 })
      await vi.waitFor(() => expect(s.held).toHaveBeenCalled())
      const pinned = { id: 'p', isDisposed: false, isAttached: false, title: { className: '' } }
      s.getOrCreateWidget.mockImplementationOnce(async () => pinned)
      await s.tabs.pin(
        'w',
        {},
        async () => {},
        () => false,
        {},
      )
      s.release()
      await loadingB
      expect(s.calls).toEqual(['add p', 'activate p', 'add v:preview'])
    })

    it('reveals a preview when no tab was focused while it loaded', async () => {
      const s = await setup()
      const loadingB = s.tabs.preview('v', s.held, { index: 2 })
      await vi.waitFor(() => expect(s.held).toHaveBeenCalled())
      s.release()
      await loadingB
      expect(s.calls).toEqual(['add v:preview', 'reveal v:preview'])
    })
  },
)
