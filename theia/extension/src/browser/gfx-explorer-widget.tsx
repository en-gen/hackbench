/**
 * The GFX explorer: every graphics file the project's cartridge holds.
 *
 * A flat list, unlike the map explorer's tree: GfxLoader's files are not
 * hierarchical (docs/glossary.md has nothing to say about them), so grouping
 * would invent structure the ROM does not have.
 *
 * Reacts to ProjectContext directly rather than being driven by
 * HackBenchContribution.show() the way MapExplorerWidget is: that method is
 * out of scope for this change, and ProjectContext is the shared source of
 * truth both approaches already read from.
 */
import * as React from '@theia/core/shared/react'
import {
  inject,
  injectable,
  postConstruct,
  interfaces,
  Container,
} from '@theia/core/shared/inversify'
import {
  ContextMenuRenderer,
  NodeProps,
  TreeModel,
  TreeNode,
  TreeProps,
  TreeWidget,
  CompositeTreeNode,
  SelectableTreeNode,
  createTreeContainer,
} from '@theia/core/lib/browser'
import { Emitter } from '@theia/core/lib/common'
import { GfxBpp, GfxFileDto, GfxService } from '../common/gfx-protocol'
import { ProjectContext } from './project-context'

export const GFX_EXPLORER_ID = 'hackbench.gfx-explorer'

export interface GfxTreeNode extends CompositeTreeNode, SelectableTreeNode {
  /** GFX file index, or -1 for a placeholder row. */
  index: number
  hex: string | null
  bpp: GfxBpp | null
  /** Null alongside `bpp` null: no depth to divide the length by. */
  tileCount: number | null
  kind: 'file' | 'message'
}

const NO_PROJECT_MESSAGE = 'Open a project to see its graphics'

@injectable()
export class GfxExplorerWidget extends TreeWidget {
  /**
   * Rows belong to a project, and nothing is open on a fresh load, so none of
   * them are persisted. Theia's TreeWidget serialises its whole model by
   * default, which restores a populated tree over an empty ProjectContext:
   * the view then lists rows from a cartridge the session has not opened.
   */
  override storeState(): object {
    return {}
  }

  override restoreState(_state: object): void {
    // Intentionally empty; load() repopulates when a project opens.
  }

  @inject(GfxService) protected readonly gfx!: GfxService
  @inject(ProjectContext) protected readonly projectContext!: ProjectContext

  /** Exposed for tests: the count the backend reported for this cartridge. */
  fileCount = 0
  /** The project currently loaded, needed to open a file from a row. */
  protected manifestPath = ''

  /**
   * Fired when a row is clicked, carrying the file it names.
   *
   * An event rather than a direct call so the tree stays a view: it knows
   * which file was asked for and nothing about what opening one means.
   * Carries `manifestPath` itself, rather than leaving the contribution to
   * reach into the widget for it, so the widget's own state stays private.
   */
  protected readonly onFileOpenedEmitter = new Emitter<{
    manifestPath: string
    index: number
    label: string
    pinned: boolean
  }>()
  readonly onFileOpened = this.onFileOpenedEmitter.event

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) model: TreeModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer,
  ) {
    super(props, model, contextMenuRenderer)
    this.id = GFX_EXPLORER_ID
    this.title.label = 'Graphics'
    this.title.caption = 'Graphics'
    this.title.iconClass = 'codicon codicon-extensions'
    this.title.closable = true
  }

  @postConstruct()
  protected init(): void {
    super.init()
    this.setRoot([this.message(NO_PROJECT_MESSAGE)])

    this.toDispose.push(
      this.projectContext.onChanged(project => {
        if (project) {
          void this.load(project.manifestPath)
        } else {
          this.manifestPath = ''
          this.fileCount = 0
          this.setRoot([this.message(NO_PROJECT_MESSAGE)])
        }
      }),
    )
    this.toDispose.push(
      this.model.onSelectionChanged(() => {
        this.fireOpen(this.model.selectedNodes[0] as GfxTreeNode | undefined, false)
      }),
    )
    // The context may already hold a project by the time this view is first
    // created (e.g. the user opened Graphics after opening a project).
    if (this.projectContext.current) {
      void this.load(this.projectContext.current.manifestPath)
    }
  }

  /**
   * Load a project's GFX files.
   *
   * A cartridge this machine cannot locate is an ordinary first-run state,
   * not a failure, mirroring MapExplorerWidget.load: the project names its
   * ROM by hash so it can be shared, and the answer is to ask the user where
   * theirs is.
   */
  async load(manifestPath: string): Promise<void> {
    this.manifestPath = manifestPath
    const result = await this.gfx.listGfxFiles(manifestPath)

    if (result.status === 'rom-not-located') {
      this.fileCount = 0
      this.setRoot([
        this.message(`Locate ${result.baseRom.title || 'the base cartridge'} to see its graphics`),
      ])
      return
    }

    this.fileCount = result.files.length
    this.setRoot(result.files.map(f => this.toNode(f)))
  }

  protected setRoot(children: GfxTreeNode[]): void {
    const root: CompositeTreeNode = {
      id: 'hackbench-gfx-root',
      name: 'gfx',
      visible: false,
      parent: undefined,
      children,
    }
    for (const c of children) (c as { parent?: unknown }).parent = root
    this.model.root = root
  }

  protected toNode(dto: GfxFileDto): GfxTreeNode {
    return {
      id: `gfx:${dto.hex}`,
      name: `GFX $${dto.hex}`,
      index: dto.index,
      hex: dto.hex,
      bpp: dto.defaultBpp,
      tileCount: dto.tileCount,
      kind: 'file',
      parent: undefined,
      children: [],
      selected: false,
    }
  }

  protected message(text: string): GfxTreeNode {
    return {
      id: 'message',
      name: text,
      index: -1,
      hex: null,
      bpp: null,
      tileCount: null,
      kind: 'message',
      parent: undefined,
      children: [],
      selected: false,
    }
  }

  /** A click selects and opens; there is nothing to expand in a flat list. */
  /**
   * Selection drives the preview, not the click: a click selects, and so do
   * the arrow keys, so both walk the list with the preview following. Only
   * pinning is bound to a gesture.
   */
  protected override tapNode(node: TreeNode | undefined): void {
    super.tapNode(node)
  }

  /** Double click pins, matching the map explorer and VS Code. */
  protected override handleDblClickEvent(
    node: TreeNode | undefined,
    event: React.MouseEvent<HTMLElement>,
  ): void {
    super.handleDblClickEvent(node, event)
    this.fireOpen(node as GfxTreeNode | undefined, true)
  }

  protected fireOpen(file: GfxTreeNode | undefined, pinned: boolean): void {
    if (!file || file.kind !== 'file' || !this.manifestPath) return
    this.onFileOpenedEmitter.fire({
      manifestPath: this.manifestPath,
      index: file.index,
      label: `GFX $${file.hex}`,
      pinned,
    })
  }

  protected override renderIcon(node: TreeNode, _props: NodeProps): React.ReactNode {
    const file = node as GfxTreeNode
    if (file.kind !== 'file') return undefined
    return <span className="hb-gfx-icon codicon codicon-extensions" />
  }

  protected override renderCaption(node: TreeNode, props: NodeProps): React.ReactNode {
    const file = node as GfxTreeNode
    if (file.kind === 'message') return super.renderCaption(node, props)

    // Null means GfxLoader itself cannot place this length at any depth (a
    // relocated GFX arrangement, seen on real hacks): say so rather than
    // printing a fabricated tile count.
    const meta = file.bpp === null ? 'unavailable' : `${file.tileCount} tiles · ${file.bpp}bpp`
    return [
      <span key="id" className="hb-gfx-id">{`GFX $${file.hex}`}</span>,
      <span key="meta" className="hb-gfx-meta">
        {meta}
      </span>,
    ]
  }
}

export function createGfxExplorerWidget(parent: interfaces.Container): GfxExplorerWidget {
  const child: Container = createTreeContainer(parent, {
    widget: GfxExplorerWidget,
    props: {
      // A row click both selects and opens the file; there is no expansion
      // toggle in a flat list to conflict with it.
      globalSelection: true,
    },
  })
  return child.get(GfxExplorerWidget)
}
