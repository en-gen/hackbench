/**
 * The palette explorer: every stock palette group the project's cartridge
 * holds, in the left activity bar. A row opens the group (or one variant of
 * it) as a main-area tab - see palette-group-view-widget.tsx - rather than
 * rendering the swatches itself, the same split GfxExplorerWidget/GfxViewWidget
 * and MapExplorerWidget/level editor already use.
 *
 * A group with more than one variant expands to list them; a single-variant
 * group is a plain leaf, since there is nothing under it worth a second row.
 * Node ids are stable (`palette:<groupId>` / `palette:<groupId>:<vi>`) so a
 * reload after an edit elsewhere - PaletteFrontendClient.onChanged - can
 * rebuild the tree from scratch and still restore which groups were open.
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
  ExpandableTreeNode,
  SelectableTreeNode,
  createTreeContainer,
} from '@theia/core/lib/browser'
import { Emitter } from '@theia/core/lib/common'
import {
  LoadPaletteResult,
  PaletteGroupDto,
  PaletteService,
  PaletteVariantDto,
} from '../common/palette-protocol'
import { ProjectContext } from './project-context'
import { surviving } from './tree-state'
import { PaletteFrontendClient } from './palette-push-client'

export const PALETTE_EXPLORER_ID = 'hackbench.palette-explorer'

export interface PaletteOpenRequest {
  manifestPath: string
  groupId: string
  variant?: number
  pinned: boolean
}

/**
 * A group, one of its variants, or an informational row (no project, ROM not
 * located, a warning, the overworld caveat).
 *
 * `expanded` is OPTIONAL and set only on a group with more than one variant:
 * ExpandableTreeNode.is() tests for the PROPERTY's presence ('expanded' in
 * node), not for a static type, so a childless or single-variant node that
 * never carries the key renders no chevron - the same pattern MapTreeNode
 * uses for its own leaves.
 */
export interface PaletteTreeNode extends CompositeTreeNode, SelectableTreeNode {
  kind: 'group' | 'variant' | 'note'
  groupId?: string
  variant?: number
  sub?: string
  expanded?: boolean
}

const NO_PROJECT_MESSAGE = 'Open a project to see its palettes'
const OVERWORLD_NOTE =
  'Overworld palettes are loaded by a different routine and are not shown here yet.'

@injectable()
export class PaletteExplorerWidget extends TreeWidget {
  /**
   * Rows belong to a project, and nothing is open on a fresh load, so none of
   * them are persisted. Theia's TreeWidget serialises its whole model by
   * default, which restores a populated tree over an empty ProjectContext:
   * the view then lists groups from a cartridge the session has not opened.
   */
  override storeState(): object {
    return {}
  }

  override restoreState(_state: object): void {
    // Intentionally empty; load() repopulates when a project opens.
  }

  @inject(PaletteService) protected readonly palettes!: PaletteService
  @inject(ProjectContext) protected readonly projectContext!: ProjectContext
  @inject(PaletteFrontendClient) protected readonly pushClient!: PaletteFrontendClient

  /** Exposed for tests: the service's last answer for the open project. */
  result: LoadPaletteResult | undefined
  /** The project currently loaded, needed to open a group from a row. */
  protected manifestPath = ''
  /** Discards a response superseded by a later load(). */
  protected requestToken = 0
  /** True while load() puts the pre-edit selection back; that must not open a tab. */
  protected restoringSelection = false
  /** Reset at the start of every load() so note ids stay unique but stable within one render. */
  protected noteSeq = 0

  /**
   * Fired when a row is clicked, carrying which group (and optionally which
   * variant) it names.
   *
   * An event rather than a direct call so the tree stays a view: it knows
   * which group was asked for and nothing about what opening a tab means.
   */
  protected readonly onOpenEmitter = new Emitter<PaletteOpenRequest>()
  readonly onOpen = this.onOpenEmitter.event

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) model: TreeModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer,
  ) {
    super(props, model, contextMenuRenderer)
    this.id = PALETTE_EXPLORER_ID
    this.title.label = 'Palettes'
    this.title.caption = 'Palettes'
    this.title.iconClass = 'codicon codicon-symbol-color'
    this.title.closable = true
  }

  @postConstruct()
  protected init(): void {
    super.init()
    this.setRoot([this.note(NO_PROJECT_MESSAGE)])

    this.toDispose.push(
      this.projectContext.onChanged(project => {
        // Routed through load() rather than reset inline: load() bumps
        // requestToken, so a project A load still in flight is discarded
        // instead of landing after this closes the project and repainting
        // A's groups over the "Open a project" note.
        void this.load(project?.manifestPath)
      }),
    )
    // A working-copy change - this widget's own edit, or one made from an
    // already-open group tab - re-fetches the SAME manifest and rebuilds the
    // tree, so a group's variant count or a warning note never goes stale.
    this.toDispose.push(
      this.pushClient.onChanged(manifestPath => {
        if (manifestPath === this.manifestPath) void this.load(manifestPath)
      }),
    )
    // The base ROM moved: rebuild as a fresh open would, collapsed, nothing selected.
    this.toDispose.push(
      this.projectContext.onRomChanged(manifestPath => {
        if (manifestPath !== this.manifestPath) return
        this.model.clearSelection()
        void this.load(manifestPath, true)
      }),
    )
    this.toDispose.push(
      this.model.onSelectionChanged(() => {
        if (this.restoringSelection) return
        this.fireOpen(this.model.selectedNodes[0] as PaletteTreeNode | undefined, false)
      }),
    )
    // The context may already hold a project by the time this view is first
    // created (e.g. the user opened Palettes after opening a project).
    if (this.projectContext.current) {
      void this.load(this.projectContext.current.manifestPath)
    }
  }

  /**
   * Load (or clear, for `undefined`) a project's palette groups.
   *
   * A cartridge this machine cannot locate is an ordinary first-run state,
   * not a failure, mirroring MapExplorerWidget.load and GfxExplorerWidget.load.
   */
  async load(manifestPath: string | undefined, fresh = false): Promise<void> {
    const token = ++this.requestToken
    this.manifestPath = manifestPath ?? ''
    this.noteSeq = 0
    // Cleared up front, not just on the branches that finish without a
    // result: a reader between here and the RPC settling (or a request this
    // one supersedes) must not see a previous project's answer.
    this.result = undefined

    if (!manifestPath) {
      this.setRoot([this.note(NO_PROJECT_MESSAGE)])
      return
    }

    let result: LoadPaletteResult
    try {
      result = await this.palettes.loadPalettes(manifestPath)
    } catch (err) {
      if (token !== this.requestToken) return // superseded by a later load()
      // Fail closed: a rejected RPC must not leave the PREVIOUS project's
      // groups on screen, since a click on one would open a tab for the
      // NEW manifest instead of the one those rows actually describe.
      this.setRoot([this.note((err as Error).message)])
      return
    }
    if (token !== this.requestToken) return // superseded by a later load()
    this.result = result

    if (result.status === 'rom-not-located') {
      const title = result.baseRom.title || 'the base ROM'
      this.setRoot([this.note(`Locate ${title} to see its palettes`)])
      return
    }
    if (result.status === 'unreadable') {
      this.setRoot([this.note(result.reason)])
      return
    }

    // Node ids are stable across reloads, so an id previously expanded is
    // kept expanded here - the new tree is a fresh object graph (TreeImpl's
    // root setter does not diff against the old one), so nothing carries
    // this forward unless this widget does it itself.
    const wasExpanded = new Set<string>()
    if (!fresh) this.collectExpanded(this.model.root, wasExpanded)
    const wasSelected = fresh ? undefined : this.model.selectedNodes[0]?.id

    const { palettes, romName } = result
    const children: PaletteTreeNode[] = [this.note(romName)]
    if (palettes.customPaletteLevelCount > 0) {
      const n = palettes.customPaletteLevelCount
      children.push(
        this.note(
          `${n} level${n === 1 ? '' : 's'} override these tables with a Lunar Magic custom ` +
            `palette this view does not read.`,
        ),
      )
    }
    if (!palettes.animation.available) {
      const reason =
        palettes.animation.notes.length > 0
          ? palettes.animation.notes.join('; ')
          : 'no reason given'
      children.push(this.note(`Level palette animation unavailable: ${reason}`))
    }
    for (const g of palettes.groups) children.push(this.groupNode(g, wasExpanded))
    children.push(this.note(OVERWORLD_NOTE))
    this.setRoot(children)
    // Only a node the new tree still has; a vanished one is cleared, not replaced.
    this.restoringSelection = true
    try {
      const kept = wasSelected && surviving([wasSelected], this.collectIds(this.model.root, []))[0]
      const node = kept ? this.model.getNode(kept) : undefined
      if (node && SelectableTreeNode.is(node)) this.model.selectNode(node)
      else this.model.clearSelection()
    } finally {
      this.restoringSelection = false
    }
  }

  protected collectIds(node: TreeNode | undefined, out: string[]): string[] {
    if (!node) return out
    out.push(node.id)
    if (CompositeTreeNode.is(node)) for (const c of node.children) this.collectIds(c, out)
    return out
  }

  protected collectExpanded(node: TreeNode | undefined, out: Set<string>): void {
    if (!node) return
    if (ExpandableTreeNode.is(node) && node.expanded) out.add(node.id)
    if (CompositeTreeNode.is(node)) {
      for (const child of node.children) this.collectExpanded(child, out)
    }
  }

  protected setRoot(children: PaletteTreeNode[]): void {
    const root: CompositeTreeNode = {
      id: 'hackbench-palette-root',
      name: 'palettes',
      visible: false,
      parent: undefined,
      children,
    }
    for (const c of children) (c as { parent?: unknown }).parent = root
    this.model.root = root
  }

  protected groupNode(g: PaletteGroupDto, wasExpanded: Set<string>): PaletteTreeNode {
    const id = `palette:${g.id}`
    const node: PaletteTreeNode = {
      id,
      name: g.label,
      kind: 'group',
      groupId: g.id,
      sub: `${g.variants.length} variant${g.variants.length === 1 ? '' : 's'}`,
      parent: undefined,
      children: [],
      selected: false,
    }
    if (g.variants.length > 1) {
      node.children = g.variants.map((v, vi) => this.variantNode(g, v, vi, node))
      node.expanded = wasExpanded.has(id)
    }
    return node
  }

  protected variantNode(
    g: PaletteGroupDto,
    v: PaletteVariantDto,
    vi: number,
    parent: PaletteTreeNode,
  ): PaletteTreeNode {
    return {
      id: `palette:${g.id}:${vi}`,
      name: v.label,
      kind: 'variant',
      groupId: g.id,
      variant: vi,
      parent,
      children: [],
      selected: false,
    }
  }

  protected note(text: string): PaletteTreeNode {
    return {
      id: `palette-note:${this.noteSeq++}`,
      name: text,
      kind: 'note',
      parent: undefined,
      children: [],
      selected: false,
    }
  }

  /** Double click pins, matching the GFX and map explorers. */
  protected override handleDblClickEvent(
    node: TreeNode | undefined,
    event: React.MouseEvent<HTMLElement>,
  ): void {
    super.handleDblClickEvent(node, event)
    this.fireOpen(node as PaletteTreeNode | undefined, true)
  }

  /** A note names nothing to open; a group or variant fires its own request. */
  protected fireOpen(node: PaletteTreeNode | undefined, pinned: boolean): void {
    if (!node || !this.manifestPath) return
    if (node.kind === 'group' && node.groupId !== undefined) {
      this.onOpenEmitter.fire({ manifestPath: this.manifestPath, groupId: node.groupId, pinned })
    } else if (
      node.kind === 'variant' &&
      node.groupId !== undefined &&
      node.variant !== undefined
    ) {
      this.onOpenEmitter.fire({
        manifestPath: this.manifestPath,
        groupId: node.groupId,
        variant: node.variant,
        pinned,
      })
    }
  }

  protected override renderIcon(node: TreeNode, _props: NodeProps): React.ReactNode {
    const n = node as PaletteTreeNode
    if (n.kind !== 'group') return undefined
    return <span className="hb-palette-tree-icon codicon codicon-symbol-color" />
  }

  protected override renderCaption(node: TreeNode, _props: NodeProps): React.ReactNode {
    const n = node as PaletteTreeNode
    if (n.kind === 'note') {
      return <span className="hb-palette-note">{n.name}</span>
    }
    return [
      <span key="name">{n.name}</span>,
      n.sub ? (
        <span key="sub" className="hb-palette-tree-sub">
          {n.sub}
        </span>
      ) : null,
    ]
  }
}

export function createPaletteExplorerWidget(parent: interfaces.Container): PaletteExplorerWidget {
  const child: Container = createTreeContainer(parent, {
    widget: PaletteExplorerWidget,
    props: {
      // A row click both selects and opens the group/variant.
      globalSelection: true,
    },
  })
  return child.get(PaletteExplorerWidget)
}
