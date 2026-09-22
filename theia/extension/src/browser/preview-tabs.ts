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

/** Italic title. Applied to `title.className`, which the tab renderer passes through. */
export const PREVIEW_TAB_CLASS = 'hb-preview-tab'

@injectable()
export class PreviewTabs {
  @inject(WidgetManager) protected readonly widgets!: WidgetManager
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell

  /**
   * Opens `target` in this view's preview tab.
   *
   * `apply` sets the widget's content and title; it is the same call the
   * persistent path makes, so a preview and a pinned tab of the same row are
   * identical apart from the italic and the key.
   */
  async preview<W extends Widget>(viewId: string, apply: (widget: W) => Promise<void>): Promise<W> {
    const widget = await this.widgets.getOrCreateWidget<W>(viewId, { preview: true })
    await apply(widget)
    // apply() sets a per-row id; the preview tab has to keep ONE identity or
    // the shell loses track of it the moment a second row is clicked.
    widget.id = previewId(viewId)
    addClass(widget, PREVIEW_TAB_CLASS)
    this.attach(widget)
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
  ): Promise<W> {
    const existingPreview = this.widgets.tryGetWidget<W>(viewId, { preview: true })
    const widget = await this.widgets.getOrCreateWidget<W>(viewId, key)
    await apply(widget)
    removeClass(widget, PREVIEW_TAB_CLASS)
    this.attach(widget)

    if (existingPreview && existingPreview !== widget && sameRow(existingPreview)) {
      existingPreview.close()
    }
    return widget
  }

  protected attach(widget: Widget): void {
    if (!widget.isAttached) this.shell.addWidget(widget, { area: 'main' })
    void this.shell.activateWidget(widget.id)
  }
}

/** One stable id per view's preview tab. */
export function previewId(viewId: string): string {
  return `${viewId}:preview`
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
