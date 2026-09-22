/**
 * The map explorer: every map in the project's cartridge, grouped.
 *
 *   Overworld
 *   |- $105 YOSHI'S ISLAND 1
 *   |   \- $0C5
 *   \- ...
 *   Unassigned
 *   \- $0D3
 *
 * "Map" is the glossary's term (docs/glossary.md): a pointer-table slot
 * holding real data, and the editable unit. Vanilla has 235 of them, and the
 * count is derived per ROM rather than assumed, so a hack with 354 shows 354.
 *
 * Slots are labelled in hex. Names are decoded from the cartridge's own name
 * tables and shown only where they exist, which is most entry maps and few
 * sub-areas; a slot is never given a name from any other source.
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
import { Emitter, MessageService } from '@theia/core/lib/common'
import { MapNodeDto, ProjectService, SpecialMapNodeDto } from '../common/project-protocol'

export const MAP_EXPLORER_ID = 'hackbench.map-explorer'

/**
 * What a row IS, in the glossary's terms (docs/glossary.md).
 *
 * Drives the icon. The distinction the icons are actually carrying is the one
 * the glossary insists on: an ENTRY MAP is what a launch tile starts, a SUB
 * AREA is reachable only from another map, and an ORPHANED map is reachable
 * from neither. Those are three different things and a tree that draws them
 * identically makes the user infer the difference from indentation.
 */
export type MapCategory =
  | 'title-screen'
  | 'new-game'
  | 'overworld-group'
  | 'unassigned-group'
  | 'entry'
  | 'subarea'
  | 'orphan'
  | 'loop'
  | 'truncated'
  | 'message'

/**
 * A map, or one of the two grouping folders.
 *
 * `expanded` is OPTIONAL and deliberately absent on leaves. Theia decides
 * whether to draw an expansion chevron with `ExpandableTreeNode.is`, which
 * tests for the property rather than for children, so a childless node that
 * carries `expanded: false` renders a chevron that expands nothing.
 */
export interface MapTreeNode extends CompositeTreeNode, SelectableTreeNode {
  /** Pointer-table slot, or -1 for a grouping folder. */
  index: number
  mapName: string | null
  kind: 'map' | 'loop' | 'truncated' | 'group' | 'message'
  category: MapCategory
  expanded?: boolean
}

/**
 * Codicons, the icon font VS Code uses and Theia bundles, so the tree matches
 * the rest of the shell rather than introducing a second icon vocabulary.
 */
export const CATEGORY_ICONS: Record<MapCategory, string> = {
  // The first thing a player sees.
  'title-screen': 'codicon-device-desktop',
  // The intro cutscene that runs when a file is started.
  'new-game': 'codicon-play-circle',
  'overworld-group': 'codicon-globe',
  // Deliberately the same mark as the orphans it contains: the folder is not
  // a different kind of thing from its children, it is just where they sit.
  'unassigned-group': 'codicon-question',
  // What a launch tile starts: the way into a level.
  entry: 'codicon-home',
  // Reached only from another map, which is what a branch is.
  subarea: 'codicon-git-branch',
  // Real map data no overworld root reaches.
  orphan: 'codicon-question',
  // A back edge to a map already on the path from this root.
  loop: 'codicon-sync',
  // A subtree left unexpanded by LevelTree's caps.
  truncated: 'codicon-ellipsis',
  message: 'codicon-info',
}

export const slotLabel = (index: number): string =>
  `$${index.toString(16).toUpperCase().padStart(3, '0')}`

@injectable()
export class MapExplorerWidget extends TreeWidget {
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(MessageService) protected readonly messages!: MessageService

  /** Exposed for tests: the count the backend reported for this cartridge. */
  mapCount = 0

  /** The project currently loaded, needed to open a map from a row. */
  protected manifestPath = ''

  /**
   * Fired when a row is clicked, carrying the map it names.
   *
   * An event rather than a direct call so the tree stays a view: it knows
   * which map was asked for and nothing about what opening one means.
   */
  protected readonly onMapOpenedEmitter = new Emitter<{
    index: number
    label: string
    pinned: boolean
    iconClass: string
  }>()
  readonly onMapOpened = this.onMapOpenedEmitter.event

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) model: TreeModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer,
  ) {
    super(props, model, contextMenuRenderer)
    this.id = MAP_EXPLORER_ID
    this.title.label = 'Maps'
    this.title.caption = 'Maps'
    this.title.iconClass = 'codicon codicon-map'
    this.title.closable = true
  }

  @postConstruct()
  protected init(): void {
    super.init()
    this.setRoot([])

    // Selection drives the preview, not the click: the arrow keys change
    // selection without tapping, so binding to the click left the keyboard
    // moving the highlight and nothing else.
    this.toDispose.push(
      this.model.onSelectionChanged(() => {
        this.fireOpen(this.model.selectedNodes[0] as MapTreeNode | undefined, false)
      }),
    )
  }

  /**
   * Load a project's maps.
   *
   * A cartridge this machine cannot locate is an ordinary first-run state,
   * not a failure: the project names its ROM by hash so it can be shared, and
   * the answer is to ask the user where theirs is.
   */
  async load(manifestPath: string): Promise<void> {
    this.manifestPath = manifestPath
    const result = await this.projects.loadMaps(manifestPath)

    if (result.status === 'rom-not-located') {
      this.mapCount = 0
      this.setRoot([
        this.message(`Locate ${result.baseRom.title || 'the base cartridge'} to load its maps`),
      ])
      return
    }

    this.mapCount = result.tree.mapCount
    const counts = result.tree.counts
    // Listed in the order a player meets them: title screen, new game, then
    // the overworld and whatever it does not reach.
    this.setRoot([
      ...result.tree.special.map(s => this.specialNode(s)),
      this.group(
        'overworld',
        // A null entrance count means the overworld could not be read, so the
        // label carries no number rather than implying zero.
        counts.entrances === null ? 'Overworld' : `Overworld (${counts.entrances})`,
        'overworld-group',
        result.tree.overworld,
      ),
      this.group(
        'unassigned',
        `Unassigned (${counts.unassigned})`,
        'unassigned-group',
        result.tree.unassigned,
      ),
    ])

    // Notes carry what the grouping could not do (unassigned maps, a ROM
    // whose filler could not be identified confidently). Surfacing them beats
    // a tidy tree that quietly means less than it looks like it does.
    for (const note of result.tree.notes) this.messages.info(note)
  }

  /** Expanded breadth-first so the tree paints top-down rather than in bursts. */
  async expandAll(): Promise<void> {
    const root = this.model.root
    if (!root) return

    const queue: TreeNode[] = [root]
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i]!
      if (ExpandableTreeNode.is(node) && !node.expanded) {
        await this.model.expandNode(node)
      }
      if (CompositeTreeNode.is(node)) queue.push(...node.children)
    }
  }

  async collapseAll(): Promise<void> {
    const root = this.model.root
    if (!CompositeTreeNode.is(root)) return
    await this.model.collapseAll(root)
    // collapseAll folds the grouping folders too, which leaves the view
    // apparently empty; they are containers, not content.
    for (const group of root.children) {
      if (ExpandableTreeNode.is(group)) await this.model.expandNode(group)
    }
  }

  protected setRoot(children: MapTreeNode[]): void {
    const root: CompositeTreeNode = {
      id: 'hackbench-maps-root',
      name: 'maps',
      visible: false,
      parent: undefined,
      children,
    }
    for (const c of children) (c as { parent?: unknown }).parent = root
    this.model.root = root
  }

  /** `id` is stable and lowercase; `label` is what the user reads. */
  protected group(
    id: string,
    label: string,
    category: MapCategory,
    maps: MapNodeDto[],
  ): MapTreeNode {
    const node: MapTreeNode = {
      id: `group:${id}`,
      name: label,
      index: -1,
      mapName: null,
      kind: 'group',
      category,
      parent: undefined,
      children: [],
      selected: false,
    }
    // A map directly under Overworld is an ENTRY MAP; one directly under
    // Unassigned is ORPHANED. Everything deeper is a sub area either way.
    const top: MapCategory = category === 'overworld-group' ? 'entry' : 'orphan'
    node.children = maps.map(m => this.toNode(m, node, top))
    // An empty group gets no chevron either, for the same reason.
    if (node.children.length > 0) node.expanded = true
    return node
  }

  /**
   * Node ids are path-scoped, not slot-scoped: a sub-area reachable from two
   * levels is expanded under both (see src/rom/LevelTree.ts), and a tree that
   * reused one id for both copies would collapse them into one row.
   */
  protected toNode(dto: MapNodeDto, parent: MapTreeNode, asCategory: MapCategory): MapTreeNode {
    // A loop or a truncation is what it is regardless of where it sits: both
    // are dead ends the user must not mistake for an expandable map.
    const category: MapCategory =
      dto.kind === 'loop' ? 'loop' : dto.kind === 'truncated' ? 'truncated' : asCategory

    const node: MapTreeNode = {
      id: `${parent.id}/${slotLabel(dto.index)}`,
      name: slotLabel(dto.index),
      index: dto.index,
      mapName: dto.name,
      kind: dto.kind,
      category,
      parent,
      children: [],
      selected: false,
    }
    // Anything below a top-level map is reachable only from another map,
    // which is the glossary's definition of a sub area.
    node.children = dto.children.map(c => this.toNode(c, node, 'subarea'))
    // Only a node with somewhere to go is expandable. A loop or a truncation
    // never expands by definition and never has children here.
    if (node.children.length > 0) node.expanded = false
    return node
  }

  /**
   * A special map is a top-level ROW, not a folder: it IS one map, so it is
   * labelled by what it is for and carries its slot like any other row.
   */
  protected specialNode(dto: SpecialMapNodeDto): MapTreeNode {
    return {
      id: `special:${dto.role}`,
      // The label the user reads; the slot still shows in the caption.
      name: dto.role === 'title-screen' ? 'Title Screen' : 'New Game',
      index: dto.index,
      mapName: dto.name,
      kind: 'map',
      category: dto.role,
      parent: undefined,
      children: [],
      selected: false,
    }
  }

  /**
   * A click selects and OPENS; only the chevron expands.
   *
   * Theia's default toggles expansion on a row click as well, which means a
   * folder cannot be opened without also collapsing it. The container sets
   * expandOnlyOnExpansionToggleClick to stop that, and this adds the open.
   */
  protected override tapNode(node: TreeNode | undefined): void {
    super.tapNode(node)
  }

  /**
   * Double click pins. Theia fires tapNode for the first click of the pair,
   * so the preview opens and is then promoted, which is what VS Code does.
   */
  protected override handleDblClickEvent(
    node: TreeNode | undefined,
    event: React.MouseEvent<HTMLElement>,
  ): void {
    super.handleDblClickEvent(node, event)
    this.fireOpen(node as MapTreeNode | undefined, true)
  }

  /** Groups and messages name no map; a marker points at a row shown elsewhere. */
  protected fireOpen(map: MapTreeNode | undefined, pinned: boolean): void {
    if (!map || map.index < 0 || map.kind !== 'map' || !this.manifestPath) return
    this.onMapOpenedEmitter.fire({
      index: map.index,
      pinned,
      // The tab wears the row's own mark, so a map is the same thing in the
      // tree and in the tab bar.
      iconClass: `codicon ${CATEGORY_ICONS[map.category]}`,
      label:
        map.category === 'title-screen' || map.category === 'new-game'
          ? (map.name ?? slotLabel(map.index))
          : `${slotLabel(map.index)}${map.mapName ? ` ${map.mapName}` : ''}`,
    })
  }

  /**
   * Rows belong to a project, and nothing is open on a fresh load, so none of
   * them are persisted. Theia's TreeWidget serialises its whole model by
   * default, which restores a populated tree over an empty ProjectContext:
   * the view then lists maps from a cartridge the session has not opened.
   */
  override storeState(): object {
    return {}
  }

  override restoreState(_state: object): void {
    // Intentionally empty; load() repopulates when a project opens.
  }

  protected message(text: string): MapTreeNode {
    return {
      id: 'message',
      name: text,
      index: -1,
      mapName: null,
      kind: 'message',
      category: 'message',
      parent: undefined,
      children: [],
      selected: false,
    }
  }

  /**
   * One icon per category, from the Codicon set Theia bundles.
   *
   * Overridden rather than set per node through `iconClass`, because Theia's
   * default only renders an icon when a decorator supplies one and this tree
   * has no decorator.
   */
  protected override renderIcon(node: TreeNode, _props: NodeProps): React.ReactNode {
    const category = (node as MapTreeNode).category
    if (!category) return undefined
    return <span className={`hb-map-icon codicon ${CATEGORY_ICONS[category]}`} />
  }

  protected override renderCaption(node: TreeNode, props: NodeProps): React.ReactNode {
    const map = node as MapTreeNode
    if (map.kind === 'group' || map.kind === 'message') return super.renderCaption(node, props)

    // A special map leads with its purpose and follows with its slot: the
    // user looks for "Title Screen", not for $0C7.
    if (map.category === 'title-screen' || map.category === 'new-game') {
      return [
        <span key="label">{map.name}</span>,
        <span key="slot" className="hb-map-slot hb-map-trailing">
          {slotLabel(map.index)}
        </span>,
      ]
    }

    // The slot is the identity; the name is a convenience that many maps do
    // not have. Showing the slot first keeps rows aligned and keeps the thing
    // the user actually addresses in the leading column.
    const suffix =
      map.kind === 'loop' ? ' (loops back)' : map.kind === 'truncated' ? ' (not expanded)' : ''
    // Classes only. Styling lives in style/index.css so the active theme can
    // override it; an inline style would outrank every theme rule.
    return [
      <span key="slot" className="hb-map-slot">
        {map.name}
      </span>,
      map.mapName ? (
        <span key="name" className="hb-map-name">
          {map.mapName}
        </span>
      ) : null,
      suffix ? (
        <span key="sfx" className="hb-map-note">
          {suffix}
        </span>
      ) : null,
    ]
  }
}

export function createMapExplorerWidget(parent: interfaces.Container): MapExplorerWidget {
  const child: Container = createTreeContainer(parent, {
    widget: MapExplorerWidget,
    props: {
      // Without this a row click toggles expansion as well as selecting, so a
      // folder cannot be opened without collapsing it.
      expandOnlyOnExpansionToggleClick: true,
      // Opening a map is a single click here, not a double: the tree is the
      // application's primary navigation, not a file browser.
      globalSelection: true,
      // Theia already indents rows that have no expansion chevron, so their
      // icons line up with the expandable ones. Its default of 22px is 2px
      // wider than the toggle actually occupies (measured: an expandable
      // row's icon sits at x+68 with no padding, a non-expandable one at
      // x+48 plus this value), which left the icon column visibly ragged
      // wherever leaves and folders are siblings.
      expansionTogglePadding: 20,
    },
  })
  return child.get(MapExplorerWidget)
}
