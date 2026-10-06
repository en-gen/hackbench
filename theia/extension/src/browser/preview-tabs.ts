/**
 * VS Code's preview-tab behaviour, which Theia 1.75 does not provide.
 *
 * `EditorOpenerOptions` declares `preview?: boolean` and one caller passes it,
 * but nothing reads it: there is no `workbench.editor.enablePreview`
 * preference and the tab bar's own "preview" handling is
 * `window.tabbar.enhancedPreview`, the hover tooltip. So this is ours.
 *
 * Single click reuses ONE widget per view, keyed `{ preview: true }`, so
 * clicking row after row swaps the content of a single italic tab. Double
 * click opens the row's own widget under its real key, which is an ordinary
 * tab, and releases the preview so the next single click starts a fresh one.
 */
import { injectable, inject } from '@theia/core/shared/inversify'
import { ApplicationShell, WidgetManager, Widget } from '@theia/core/lib/browser'
import { previewId } from './preview-id'
import { PreviewSequence } from './preview-sequence'
import { ProjectContext } from './project-context'
import { boundToOther } from './project-bound'

export { previewId }

/** Italic title. Applied to `title.className`, which the tab renderer passes through. */
export const PREVIEW_TAB_CLASS = 'hb-preview-tab'

@injectable()
export class PreviewTabs {
  @inject(WidgetManager) protected readonly widgets!: WidgetManager
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell
  @inject(ProjectContext) protected readonly context!: ProjectContext
  /** The preview opens still running, so `pin` can wait for one rather than
   * race it - see PreviewSequence. */
  protected readonly sequence = new PreviewSequence()

  /**
   * Opens `target` in this view's preview tab.
   *
   * `apply` sets the widget's content and title; it is the same call the
   * persistent path makes, so a preview and a pinned tab of the same row are
   * identical apart from the italic and the key.
   */
  async preview<W extends Widget>(
    viewId: string,
    apply: (widget: W) => Promise<void>,
    key: object = {},
  ): Promise<W> {
    const tabId = previewId(viewId, key)
    const widget = await this.widgets.getOrCreateWidget<W>(viewId, { preview: true, ...key })
    // Registered as in flight for the whole of `apply`, which is where the
    // time goes (Map16's is a JSON-RPC sheet load) and therefore where a
    // double click's pin used to look for this widget and miss it.
    await this.sequence.track(tabId, apply(widget))
    // A pin that ran anyway and retired this preview leaves it disposed, and
    // Lumino throws on attaching a disposed widget. Losing the race is not
    // an error; attaching afterwards would be.
    if (widget.isDisposed) return widget
    // apply() sets a per-row id; the preview tab has to keep ONE identity or
    // the shell loses track of it the moment a second row is clicked. `key`
    // splits that identity where a view has genuinely independent tabs -
    // Map16's two tables - so previewing one never replaces the other.
    widget.id = tabId
    addClass(widget, PREVIEW_TAB_CLASS)
    this.attach(widget, false)
    return widget
  }

  /**
   * Opens `target` as a persistent tab, and drops the preview tab if it was
   * showing the same row - otherwise double-clicking leaves two tabs of one
   * thing, which is not what the gesture means.
   */
  async pin<W extends Widget>(
    viewId: string,
    key: object,
    apply: (widget: W) => Promise<void>,
    sameRow: (preview: W) => boolean,
    previewKey: object,
  ): Promise<W> {
    // Looked up BY ID, and `previewKey` is required rather than defaulted.
    //
    // This used to synthesize `{ preview: true, ...key }` and ask the widget
    // manager, which silently never matched for three of the four views: a
    // view's `key` names a ROW (`{ index }`, `{ groupId, variant }`) while
    // its preview tab is keyed by TAB identity, which for those views is
    // `{}`. The two are different things that happened to coincide for
    // Map16, so Map16 worked and the GFX, Map and Palette views quietly
    // stopped retiring their preview tab. Double-clicking left two tabs of
    // one row, which is not what the gesture means.
    //
    // `previewId` already computes the tab's identity, so comparing against
    // it removes the key-shape coupling entirely. Required, because the
    // defect was exactly an implicit mismatch between two call sites.
    const wantedId = previewId(viewId, previewKey)
    // The single click that precedes this double click may still be opening
    // the preview. Looking before it finishes finds nothing - it is neither
    // attached nor yet under its tab id - and the gesture then leaves TWO
    // widgets of one row attached, both rendering the same controls. That is
    // what happened on ccb66b4. See PreviewSequence.
    await this.sequence.settled(wantedId)
    const existingPreview = this.shell.widgets.find(w => w.id === wantedId) as W | undefined
    const widget = await this.widgets.getOrCreateWidget<W>(viewId, key)
    await apply(widget)
    removeClass(widget, PREVIEW_TAB_CLASS)
    this.attach(widget, true)

    if (existingPreview && existingPreview !== widget && sameRow(existingPreview)) {
      existingPreview.close()
    }
    return widget
  }

  /**
   * `focus` false reveals the tab without taking focus, so a single click
   * leaves the caret in the tree and the arrow keys keep walking the list,
   * previewing each row as it goes. Pinning is an explicit "I want this
   * one", so it focuses.
   */
  protected attach(widget: Widget, focus: boolean): void {
    // A view of the previous project that was still loading when another
    // project opened is not in shell.widgets, so the switch could not close
    // it. It must not appear now (#628).
    const open = this.context.current?.manifestPath
    if (open && boundToOther([widget], open).length > 0) {
      widget.dispose()
      return
    }
    if (!widget.isAttached) this.shell.addWidget(widget, { area: 'main' })
    if (focus) void this.shell.activateWidget(widget.id)
    else void this.shell.revealWidget(widget.id)
  }
}

function addClass(widget: Widget, cls: string): void {
  const current = widget.title.className ?? ''
  if (!current.split(/\s+/).includes(cls)) {
    widget.title.className = current ? `${current} ${cls}` : cls
  }
}

function removeClass(widget: Widget, cls: string): void {
  const current = widget.title.className ?? ''
  widget.title.className = current
    .split(/\s+/)
    .filter(c => c && c !== cls)
    .join(' ')
}
