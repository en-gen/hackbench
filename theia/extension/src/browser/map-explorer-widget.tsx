/**
 * The map explorer: every map in the project's cartridge, grouped.
 *
 *   1. Yoshi's Island
 *   |- $105 YOSHI'S ISLAND 1
 *   |   \- $0C5
 *   \- ...
 *   Unassigned
 *   |- $0D3 (an entry map)
 *   \- $0D8 (an orphan: not reached from the overworld, dimmed)
 *
 * The top rows follow the order the player meets them: Title Screen, New
 * Game, Overworld. The Overworld row is frontend-only (no slot, no hex label):
 * opening it runs `hackbench.overworld.focus`, which opens or focuses the one
 * Overworld view. Groups and maps follow.
 *
 * There is no separate Overworld folder. Every top-level map not in a user
 * group, entry map or orphan alike, lands in Unassigned, sorted by slot: an
 * entry map moved there is exactly as "unassigned" as an orphan is, the row
 * just says which by its icon and (for an orphan) its dimming.
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
  TreeSelection,
  createTreeContainer,
} from '@theia/core/lib/browser'
import { CommandService, Emitter, MessageService } from '@theia/core/lib/common'
import { OVERWORLD_FOCUS_COMMAND_ID } from './overworld-view-widget'
import { orderSpecials } from './map-explorer-order'
import {
  GroupedMapNodeDto,
  GroupedMapTreeDto,
  MapGroupDto,
  MapNodeDto,
  ProjectService,
  SpecialMapNodeDto,
} from '../common/project-protocol'

export const MAP_EXPLORER_ID = 'hackbench.map-explorer'

/** Registered in map-explorer-contribution.ts; named here to avoid a circular import. */
export const MAP_EXPLORER_CONTEXT_MENU = ['map-explorer-context-menu']

/**
 * What a row IS, in the glossary's terms (docs/glossary.md).
 *
 * An ENTRY MAP is what a launch tile starts, a SUB AREA is reachable only
 * from another map, and an ORPHANED map is reachable from neither. A BONUS
 * map is entered after a level: reached, but by no launch tile.
 */
export type MapCategory =
  | SpecialMapNodeDto['role']
  | 'overworld'
  | 'unassigned-group'
  | 'user-group'
  | 'entry'
  | 'bonus'
  | 'subarea'
  | 'orphan'
  | 'loop'
  | 'truncated'
  | 'message'

/**
 * A map, or one of the grouping folders.
 *
 * `expanded` is OPTIONAL and deliberately absent on leaves. Theia decides
 * whether to draw an expansion chevron with `ExpandableTreeNode.is`, which
 * tests for the property rather than for children, so a childless node that
 * carries `expanded: false` renders a chevron that expands nothing.
 */
export interface MapTreeNode extends CompositeTreeNode, SelectableTreeNode {
  /** Pointer-table slot, or -1 for a grouping folder or the Overworld row. */
  index: number
  mapName: string | null
  kind: 'map' | 'loop' | 'truncated' | 'group' | 'message'
  category: MapCategory
  /** Set on a 'bonus' row: which flag sends the player there. */
  role?: BonusRole
  expanded?: boolean
}

type BonusRole = NonNullable<GroupedMapNodeDto['role']>

/**
 * Icon and tooltip per bonus role, from the flag CODE_05DBAC tests (see
 * src/rom/BonusEntrances.ts). BonusGameActivate is set by HandleBonusStars
 * (bank_00.asm:1717); YoshiHeavenFlag by YoshiWingsAni once the player has
 * flown up off the screen (bank_00.asm:8295-8331).
 */
const BONUS_ROLES: Record<BonusRole, { icon: string; title: string }> = {
  'bonus-game': { icon: 'codicon-star-empty', title: 'Entered after a level' },
  'yoshi-heaven': { icon: 'codicon-arrow-up', title: 'Entered by flying up on Yoshi wings' },
}

/** What each special row is labeled with. */
const SPECIAL_LABELS: Record<SpecialMapNodeDto['role'], string> = {
  'title-screen': 'Title Screen',
  'new-game': 'New Game',
}

const isSpecial = (category: MapCategory): boolean => category in SPECIAL_LABELS

/** Marks a drag as one of this explorer's own map-row drags. */
const MAP_ROWS_TYPE = 'application/vnd.hackbench.map-rows'

export const CATEGORY_ICONS: Record<MapCategory, string> = {
  'title-screen': 'codicon-device-desktop',
  'new-game': 'codicon-play-circle',
  overworld: 'codicon-globe',
  // Deliberately the same mark as the orphans it contains: the folder is not
  // a different kind of thing from its children, it is just where they sit.
  'unassigned-group': 'codicon-question',
  'user-group': 'codicon-folder',
  // What a launch tile starts: the way into a level.
  entry: 'codicon-map',
  // Only when a row has no role; iconFor takes the role's own icon first.
  bonus: 'codicon-star-empty',
  subarea: 'codicon-git-branch',
  orphan: 'codicon-question',
  loop: 'codicon-sync',
  truncated: 'codicon-ellipsis',
  message: 'codicon-info',
}

const iconFor = (node: MapTreeNode): string =>
  node.role ? BONUS_ROLES[node.role].icon : CATEGORY_ICONS[node.category]

export const slotLabel = (index: number): string =>
  `$${index.toString(16).toUpperCase().padStart(3, '0')}`

@injectable()
export class MapExplorerWidget extends TreeWidget {
  @inject(CommandService) protected readonly commands!: CommandService
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(MessageService) protected readonly messages!: MessageService

  /** Exposed for tests: the count the backend reported for this cartridge. */
  mapCount = 0

  protected manifestPath = ''

  /**
   * The raw meta/groups.json list, as the server last read it: not rebuilt
   * from the resolved tree, so a slot the current ROM cannot resolve (a
   * stale group member) survives an edit instead of being dropped.
   */
  protected groups: MapGroupDto[] = []

  /** Set when meta/groups.json failed to read; group editing is refused while set. */
  protected groupsError: string | undefined

  /** Chains group writes so a second edit always starts from the first one's result. */
  protected writeQueue: Promise<void> = Promise.resolve()

  /**
   * Bumped on every `load()` call; a response is applied only if it is still
   * the latest one requested. Without this, switching projects while an
   * older `load()` is still in flight could let it resolve AFTER the newer
   * one and overwrite the view with the wrong project's tree.
   */
  protected loadGeneration = 0

  /** True while restoreSelectionAndExpansion is rebuilding a multi-selection. */
  protected restoringSelection = false

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

    // A multi-row selection (Ctrl/Shift+click) opens nothing: it is there to
    // build a group from, not to preview.
    this.toDispose.push(
      this.model.onSelectionChanged(nodes => {
        if (!this.restoringSelection && nodes.length === 1) {
          this.fireOpen(nodes[0] as MapTreeNode, false)
        }
      }),
    )
  }

  /**
   * Load a project's maps.
   *
   * manifestPath is committed only once the load actually succeeds: setting
   * it eagerly left a failed load pointing the NEXT edit at a project whose
   * tree and groups still belonged to whatever was open before.
   *
   * Guarded by `loadGeneration`: if a second `load()` starts before this one
   * resolves (switching projects quickly), the first one's response is
   * dropped rather than applied after the second one's, which would leave
   * project A's tree on screen while project B is actually open.
   */
  async load(manifestPath: string): Promise<void> {
    const generation = ++this.loadGeneration
    let result
    try {
      result = await this.projects.loadMaps(manifestPath)
    } catch (err) {
      if (generation !== this.loadGeneration) return
      this.manifestPath = ''
      this.mapCount = 0
      this.groups = []
      this.groupsError = undefined
      const reason = err instanceof Error ? err.message : String(err)
      this.setRoot([this.message(`Could not load maps: ${reason}`)])
      this.messages.error(reason)
      return
    }
    if (generation !== this.loadGeneration) return

    this.manifestPath = manifestPath

    if (result.status === 'rom-not-located') {
      this.mapCount = 0
      this.groups = []
      this.groupsError = undefined
      this.setRoot([
        this.message(`Locate ${result.baseRom.title || 'the base ROM'} to load its maps`),
      ])
      return
    }

    this.mapCount = result.tree.mapCount
    this.groups = result.rawGroups
    this.groupsError = result.groupsError

    const rows: MapTreeNode[] = [
      ...orderSpecials(result.tree.special).map(s => this.specialNode(s)),
      this.overworldNode(),
    ]
    if (this.groupsError) {
      rows.push(this.message(`Groups unavailable: ${this.groupsError}`))
      this.messages.error(`meta/groups.json: ${this.groupsError}`)
    }
    rows.push(...result.tree.groups.map(g => this.userGroupNode(g)))
    // The count is rows actually listed under the folder, not a derived ROM
    // figure: a map that moved into a group no longer counts here.
    rows.push(this.unassignedNode(result.tree.unassigned))
    this.setRoot(rows)

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

  /**
   * The single structural folder: every top-level map not in a user group,
   * sorted by slot, each carrying its own entry/orphan marking (there is no
   * separate Overworld folder to infer it from position).
   */
  protected unassignedNode(maps: GroupedMapNodeDto[]): MapTreeNode {
    const node: MapTreeNode = {
      id: 'group:unassigned',
      name: `Unassigned (${maps.length})`,
      index: -1,
      mapName: null,
      kind: 'group',
      category: 'unassigned-group',
      parent: undefined,
      children: [],
      selected: false,
    }
    node.children = maps.map(m => this.topNode(m, node))
    if (node.children.length > 0) node.expanded = true
    return node
  }

  /** `group:user:<name>`, distinct from the structural `group:unassigned`. */
  protected userGroupNode(g: GroupedMapTreeDto['groups'][number]): MapTreeNode {
    const node: MapTreeNode = {
      id: `group:user:${g.name}`,
      name: `${g.name} (${g.maps.length})`,
      index: -1,
      mapName: null,
      kind: 'group',
      category: 'user-group',
      parent: undefined,
      children: [],
      selected: false,
    }
    node.children = g.maps.map((m: GroupedMapNodeDto) => this.topNode(m, node))
    // Empty group still shows, as an empty folder with no chevron.
    if (node.children.length > 0) node.expanded = true
    return node
  }

  /** A map at the top of a folder: bonus, orphan or entry, whichever folder holds it. */
  protected topNode(m: GroupedMapNodeDto, parent: MapTreeNode): MapTreeNode {
    const node = this.toNode(m, parent, m.role ? 'bonus' : m.orphan ? 'orphan' : 'entry')
    if (m.role) node.role = m.role
    return node
  }

  /**
   * Node ids are path-scoped, not slot-scoped: a sub-area reachable from two
   * roots is listed under both (see reachableSlots in src/rom/LevelTree.ts),
   * and a tree that reused one id for both copies would collapse them into one row.
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
    node.children = dto.children.map(c => this.toNode(c, node, 'subarea'))
    if (node.children.length > 0) node.expanded = false
    return node
  }

  /**
   * A special map is a top-level ROW, not a folder: it IS one map, so it is
   * labelled by what it is for and carries its slot like any other row.
   */
  protected specialNode(dto: SpecialMapNodeDto): MapTreeNode {
    return {
      id: `special:${dto.role}:${dto.index}`,
      name: SPECIAL_LABELS[dto.role],
      index: dto.index,
      mapName: dto.name,
      kind: 'map',
      category: dto.role,
      parent: undefined,
      children: [],
      selected: false,
    }
  }

  /** Not a slot: opening it runs the Overworld command, so it needs no ROM read here. */
  protected overworldNode(): MapTreeNode {
    return {
      id: 'overworld',
      name: 'Overworld',
      index: -1,
      mapName: null,
      kind: 'map',
      category: 'overworld',
      parent: undefined,
      children: [],
      selected: false,
    }
  }

  protected override handleDblClickEvent(
    node: TreeNode | undefined,
    event: React.MouseEvent<HTMLElement>,
  ): void {
    super.handleDblClickEvent(node, event)
    this.fireOpen(node as MapTreeNode | undefined, true)
  }

  /** Groups and messages name no map; a marker points at a row shown elsewhere. */
  protected fireOpen(map: MapTreeNode | undefined, pinned: boolean): void {
    if (map?.category === 'overworld') {
      this.commands
        .executeCommand(OVERWORLD_FOCUS_COMMAND_ID, { activate: pinned })
        .catch(err =>
          this.messages.error(
            `Could not open the Overworld: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      return
    }
    if (!map || map.index < 0 || map.kind !== 'map' || !this.manifestPath) return
    this.onMapOpenedEmitter.fire({
      index: map.index,
      pinned,
      iconClass: `codicon ${iconFor(map)}`,
      label: isSpecial(map.category)
        ? (map.name ?? slotLabel(map.index))
        : `${slotLabel(map.index)}${map.mapName ? ` ${map.mapName}` : ''}`,
    })
  }

  /**
   * Rows belong to a project, and nothing is open on a fresh load, so none of
   * them are persisted.
   */
  override storeState(): object {
    return {}
  }

  override restoreState(_state: object): void {
    // Intentionally empty; load() repopulates when a project opens.
  }

  /**
   * A map that can belong to a group: an entry map, a bonus map or an
   * orphan, the tree's top-level categories. Excludes sub areas, loops,
   * truncated rows and the Title Screen/New Game rows.
   */
  protected groupable(node: MapTreeNode): boolean {
    const { kind, category } = node
    return kind === 'map' && (category === 'entry' || category === 'bonus' || category === 'orphan')
  }

  protected selected(): MapTreeNode[] {
    return this.model.selectedNodes as MapTreeNode[]
  }

  /** Add to Group is refused when the selection contains anything ungroupable. */
  canAddToGroup(): boolean {
    if (this.groupsError) return false
    const selected = this.selected()
    return selected.length > 0 && selected.every(m => this.groupable(m))
  }

  canRemoveFromGroup(): boolean {
    if (this.groupsError) return false
    return this.selected()
      .filter(m => this.groupable(m))
      .some(m => this.groupAncestor(m) !== undefined)
  }

  protected groupAncestor(node: MapTreeNode): MapTreeNode | undefined {
    let n: TreeNode | undefined = node.parent
    while (n) {
      if ((n as MapTreeNode).category === 'user-group') return n as MapTreeNode
      n = (n as MapTreeNode).parent
    }
    return undefined
  }

  groupNames(): string[] {
    return this.groups.map(g => g.name)
  }

  isUserGroupNode(node: TreeNode | undefined): node is MapTreeNode {
    return !!node && (node as MapTreeNode).category === 'user-group'
  }

  /** The single selected group folder's name, or undefined when that is not the selection. */
  selectedGroupName(): string | undefined {
    const selected = this.model.selectedNodes
    if (selected.length !== 1) return undefined
    const node = selected[0] as MapTreeNode
    return this.isUserGroupNode(node) ? node.name!.replace(/ \(\d+\)$/, '') : undefined
  }

  /** Trimmed, non-empty, unique ignoring case: same rule the write path enforces. */
  validateGroupName(name: string, ignoring?: string): string | undefined {
    const trimmed = name.trim()
    if (!trimmed) return 'Group name cannot be empty'
    const clash = this.groups.some(
      g => g.name.toLowerCase() === trimmed.toLowerCase() && g.name !== ignoring,
    )
    if (clash) return `A group named "${trimmed}" already exists`
    return undefined
  }

  async addSelectionToGroup(name: string): Promise<void> {
    const slots = this.selected()
      .filter(m => this.groupable(m))
      .map(m => m.index)
    await this.queueEdit(current => mergeIntoGroup(current, name, slots))
  }

  async removeSelectionFromGroup(): Promise<void> {
    const slots = this.selected()
      .filter(m => this.groupable(m))
      .map(m => m.index)
    await this.queueEdit(current => withoutSlots(current, slots))
  }

  async renameGroup(oldName: string, newName: string): Promise<void> {
    const trimmed = newName.trim()
    await this.queueEdit(current =>
      current.map(g => (g.name === oldName ? { ...g, name: trimmed } : g)),
    )
  }

  async deleteGroup(name: string): Promise<void> {
    await this.queueEdit(current => current.filter(g => g.name !== name))
  }

  /**
   * Runs `mutate` against the CURRENT server-held list, chained after every
   * write already queued, so a second edit started before the first one's
   * reload finishes still sees its result rather than stale local state.
   *
   * `manifestPath` is captured NOW, at queue time, not read from `this` when
   * the write finally runs: the project the edit was meant for is fixed the
   * moment the user asks for it, and if a different project is open by the
   * time this edit's turn comes up (or while its RPC call is in flight),
   * `performWrite` drops it rather than writing project B's file with an
   * edit meant for project A, or reloading A's tree over B's.
   */
  protected queueEdit(mutate: (current: MapGroupDto[]) => MapGroupDto[]): Promise<void> {
    const manifestPath = this.manifestPath
    const task = this.writeQueue.then(() => {
      if (this.manifestPath !== manifestPath) return undefined
      return this.performWrite(manifestPath, mutate(this.groups))
    })
    this.writeQueue = task.catch(() => {})
    return task
  }

  protected async performWrite(manifestPath: string, next: MapGroupDto[]): Promise<void> {
    if (this.groupsError) {
      this.messages.error(`Fix meta/groups.json before editing groups: ${this.groupsError}`)
      return
    }

    const selectedIndices = new Set(
      this.selected()
        .filter(n => this.isTopLevelMap(n))
        .map(n => n.index),
    )
    const selectedFolderIds = new Set(
      this.selected()
        .filter(n => n.kind === 'group')
        .map(n => n.id),
    )
    const expanded = new Set(this.collectExpandedSlots())
    // Group folders default to expanded on every rebuild; a folder the user
    // had collapsed is tracked separately so the rebuild does not reopen it.
    const collapsedGroups = this.collectCollapsedGroupIds()

    const result = await this.projects.setMapGroups(manifestPath, next)
    if (this.manifestPath !== manifestPath) return // switched projects mid-write; drop the reload
    if (result.status !== 'ok') {
      this.messages.error(
        result.status === 'invalid'
          ? result.reason
          : 'The base ROM for this project is not on this machine',
      )
      return
    }

    await this.load(manifestPath)
    if (this.manifestPath !== manifestPath) return
    this.restoreSelectionAndExpansion(selectedIndices, selectedFolderIds, expanded)
    await this.restoreCollapsedGroups(collapsedGroups)
  }

  /** A row directly under a folder (a group or Unassigned), as opposed to a nested sub area. */
  protected isTopLevelMap(node: MapTreeNode): boolean {
    return node.kind === 'map' && !!node.parent && (node.parent as MapTreeNode).kind === 'group'
  }

  protected collectCollapsedGroupIds(): Set<string> {
    const ids = new Set<string>()
    const root = this.model.root
    if (CompositeTreeNode.is(root)) {
      for (const child of root.children) {
        const node = child as MapTreeNode
        if (node.kind === 'group' && ExpandableTreeNode.is(node) && !node.expanded) ids.add(node.id)
      }
    }
    return ids
  }

  protected async restoreCollapsedGroups(ids: Set<string>): Promise<void> {
    const root = this.model.root
    if (!CompositeTreeNode.is(root)) return
    for (const child of root.children) {
      const node = child as MapTreeNode
      if (ids.has(node.id) && ExpandableTreeNode.is(node) && node.expanded) {
        await this.model.collapseNode(node)
      }
    }
  }

  protected forEachNode(run: (node: MapTreeNode) => void): void {
    const root = this.model.root
    if (!CompositeTreeNode.is(root)) return
    const walk = (n: TreeNode): void => {
      run(n as MapTreeNode)
      if (CompositeTreeNode.is(n)) n.children.forEach(walk)
    }
    root.children.forEach(walk)
  }

  protected collectExpandedSlots(): number[] {
    const slots: number[] = []
    this.forEachNode(node => {
      if (node.expanded && node.index >= 0) slots.push(node.index)
    })
    return slots
  }

  /**
   * Restores selection and expansion by SLOT, not by node id: a grouped
   * map's id changes with its parent. Only the group folders that WERE
   * expanded are re-expanded; a group the user had collapsed stays that way.
   *
   * `clearSelection()` runs first: Theia can carry a selection over across a
   * model reset for a node whose id did not change, so TOGGLE-ing it back in
   * would instead toggle it OFF. Restored selection is also restricted to
   * top-level map rows and folders: a sub area can share its slot with an
   * unrelated top-level row elsewhere in the tree (see the spec), and
   * selecting both from one index would select a row Add to Group must
   * refuse without the user having asked for it.
   */
  protected restoreSelectionAndExpansion(
    selectedIndices: Set<number>,
    selectedFolderIds: Set<string>,
    expanded: Set<number>,
  ): void {
    this.model.clearSelection()

    const toSelect: MapTreeNode[] = []
    this.forEachNode(node => {
      if (expanded.has(node.index) && ExpandableTreeNode.is(node)) void this.model.expandNode(node)
      if (node.kind === 'group' && selectedFolderIds.has(node.id)) toSelect.push(node)
      else if (this.isTopLevelMap(node) && selectedIndices.has(node.index)) toSelect.push(node)
    })

    // TOGGLE each in turn (no single call sets a whole selection at once),
    // guarded so the intermediate one-node states do not each open a preview.
    this.restoringSelection = true
    try {
      for (const node of toSelect) {
        this.model.addSelection({ node, type: TreeSelection.SelectionType.TOGGLE })
      }
    } finally {
      this.restoringSelection = false
    }
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

  /** Nodes being dragged; null when the drag is invalid (any dragged node ungroupable). */
  protected dragNodes: MapTreeNode[] | null = null

  protected dragAttributes(node: MapTreeNode): React.HTMLAttributes<HTMLElement> {
    // Sub areas, loops, truncated rows and special maps are never a drag
    // source, but still clear dragNodes on their own dragstart.
    const source: React.HTMLAttributes<HTMLElement> = this.groupable(node)
      ? {
          draggable: true,
          onDragStart: event => {
            const selected = this.selected()
            const dragging = selected.includes(node) ? selected : [node]
            // Loops, truncated rows and special maps refuse the WHOLE drag,
            // not just their own row.
            this.dragNodes = dragging.every(n => this.groupable(n)) ? dragging : null
            event.dataTransfer.setData(MAP_ROWS_TYPE, '')
          },
          onDragEnd: () => {
            this.dragNodes = null
            this.setDropHighlight(undefined)
          },
        }
      : { onDragStart: () => (this.dragNodes = null) }
    const folder = this.dropFolder(node)
    if (!folder) return source
    // Theia's FrontendApplication resets dropEffect to 'none' on every
    // dragenter/dragover that bubbles to the document (to refuse file drops),
    // and the browser drops only if the FINAL dropEffect allows it. So the
    // verdict has to stop here, as Theia's own FileTreeWidget does (#625).
    const hover = (event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const accepted = this.accepts(event, folder)
      event.dataTransfer.dropEffect = accepted ? 'move' : 'none'
      this.setDropHighlight(accepted ? folder : undefined)
    }
    return {
      ...source,
      onDragEnter: event => {
        this.dragEnteredRow = true
        hover(event)
      },
      onDragOver: hover,
      // The browser fires dragenter on the element entered BEFORE dragleave
      // on the one left, so a leave with no enter just before it means the
      // pointer left every folder row (or the drag was cancelled with Esc,
      // which ends with a dragleave). Moving between rows or their child
      // elements keeps the highlight the enter already set: no flicker.
      onDragLeave: () => {
        if (!this.dragEnteredRow) this.setDropHighlight(undefined)
        this.dragEnteredRow = false
      },
      onDrop: event => {
        event.preventDefault()
        event.stopPropagation()
        if (this.accepts(event, folder)) void this.handleDrop(folder)
        this.dragNodes = null
        this.setDropHighlight(undefined)
      },
    }
  }

  /** The id of the folder an accepted drag is over, drawn with list.dropBackground. */
  protected dropHighlight: string | undefined
  /** Set by a folder row's dragenter, consumed by the dragleave that follows it. */
  protected dragEnteredRow = false

  protected setDropHighlight(folder: MapTreeNode | undefined): void {
    if (this.dropHighlight === folder?.id) return
    this.dropHighlight = folder?.id
    this.update()
  }

  /** The folder a drop on this row lands in: the row itself, or the group or Unassigned holding it. */
  protected dropFolder(node: MapTreeNode): MapTreeNode | undefined {
    for (let n: MapTreeNode | undefined = node; n; n = n.parent as MapTreeNode | undefined) {
      if (n.category === 'user-group' || n.category === 'unassigned-group') return n
    }
    return undefined
  }

  /**
   * Only a drag this widget started carries MAP_ROWS_TYPE. Without the check,
   * dragNodes left stale by a drag whose source row unmounted before dragend
   * would let a later file or text drop move those maps.
   */
  protected accepts(event: React.DragEvent, folder: MapTreeNode): boolean {
    return event.dataTransfer.types.includes(MAP_ROWS_TYPE) && this.canDrop(folder)
  }

  /**
   * Onto a user group: every dragged node must be groupable (already true by
   * construction of dragNodes), and at least one must be outside that group,
   * or the drop would change nothing. Onto Unassigned, the one structural folder:
   * every dragged node must currently be grouped, since Unassigned is every
   * grouped map's structural parent regardless of entry/orphan.
   */
  protected canDrop(target: MapTreeNode): boolean {
    const dragged = this.dragNodes
    if (!dragged || dragged.length === 0 || this.groupsError) return false
    if (target.category === 'user-group') {
      return dragged.some(n => this.groupAncestor(n)?.id !== target.id)
    }
    return dragged.every(n => this.groupAncestor(n) !== undefined)
  }

  protected async handleDrop(target: MapTreeNode): Promise<void> {
    const dragged = this.dragNodes
    if (!dragged) return
    const slots = dragged.map(n => n.index)

    if (target.category === 'user-group') {
      // Every group node's name is set at construction and carries its own
      // row count; strip it back to the bare name before writing.
      const name = target.name!.replace(/ \(\d+\)$/, '')
      await this.queueEdit(current => mergeIntoGroup(current, name, slots))
    } else {
      await this.queueEdit(current => withoutSlots(current, slots))
    }
  }

  protected override renderIcon(node: TreeNode, _props: NodeProps): React.ReactNode {
    if (!(node as MapTreeNode).category) return undefined
    return <span className={`hb-map-icon codicon ${iconFor(node as MapTreeNode)}`} />
  }

  /** Orphan rows get their dim/italic marking and tooltip here, on the whole row. */
  protected override createNodeClassNames(node: TreeNode, props: NodeProps): string[] {
    const classNames = super.createNodeClassNames(node, props)
    if ((node as MapTreeNode).category === 'orphan') classNames.push('hb-map-row-orphan')
    // The whole folder lights up, header and visible rows, as VS Code's does.
    if (this.dropHighlight && this.dropFolder(node as MapTreeNode)?.id === this.dropHighlight) {
      classNames.push('hb-map-drop-target')
    }
    return classNames
  }

  protected override createNodeAttributes(
    node: TreeNode,
    props: NodeProps,
  ): React.Attributes & React.HTMLAttributes<HTMLElement> {
    const attrs = super.createNodeAttributes(node, props)
    const map = node as MapTreeNode
    if (map.category === 'orphan') attrs.title = 'Not reached from the overworld'
    if (map.role) attrs.title = BONUS_ROLES[map.role].title
    // Theia's own default caption only carries the node id on expandable
    // rows (via the toggle element); a leaf map row otherwise has no DOM
    // marker at all. The same slot can appear twice in the tree (a sub area
    // reachable from one root while also being a root of its own), so a
    // caller (a test, most reliably) that needs THIS exact row rather than
    // whichever one text search finds first needs this on every row.
    return {
      ...attrs,
      ...this.dragAttributes(map),
      ...({ 'data-node-id': node.id } as Record<string, string>),
    }
  }

  protected override renderCaption(node: TreeNode, props: NodeProps): React.ReactNode {
    const map = node as MapTreeNode
    if (map.kind === 'group' || map.kind === 'message') return super.renderCaption(node, props)

    if (map.category === 'overworld') return <span key="label">{map.name}</span>
    if (isSpecial(map.category)) {
      return [
        <span key="label">{map.name}</span>,
        <span key="slot" className="hb-map-slot hb-map-trailing">
          {slotLabel(map.index)}
        </span>,
      ]
    }

    const suffix =
      map.kind === 'loop' ? ' (loops back)' : map.kind === 'truncated' ? ' (not expanded)' : ''
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

/**
 * A map belongs to at most one group, so it is dropped from every other before
 * joining this one. Maps already in the group stay where they are: adding
 * them again must not move them to the end.
 */
function mergeIntoGroup(groups: MapGroupDto[], name: string, slots: number[]): MapGroupDto[] {
  const members = new Set(groups.find(g => g.name === name)?.slots ?? [])
  const joining = slots.filter(s => !members.has(s))
  const next = withoutSlots(groups, joining)
  const target = next.find(g => g.name === name)
  if (target) target.slots.push(...joining)
  else next.push({ name, slots: joining })
  return next
}

function withoutSlots(groups: MapGroupDto[], slots: number[]): MapGroupDto[] {
  const drop = new Set(slots)
  return groups.map(g => ({ name: g.name, slots: g.slots.filter(s => !drop.has(s)) }))
}

export function createMapExplorerWidget(parent: interfaces.Container): MapExplorerWidget {
  const child: Container = createTreeContainer(parent, {
    widget: MapExplorerWidget,
    props: {
      // Without this a row click toggles expansion as well as selecting, so a
      // folder cannot be opened without collapsing it.
      expandOnlyOnExpansionToggleClick: true,
      globalSelection: true,
      // Theia already indents rows that have no expansion chevron, so their
      // icons line up with the expandable ones. Its default of 22px is 2px
      // wider than the toggle actually occupies (measured), which left the
      // icon column visibly ragged wherever leaves and folders are siblings.
      expansionTogglePadding: 20,
      // Ctrl+click toggles a row, Shift+click selects a range, per the spec.
      multiSelect: true,
      contextMenuPath: MAP_EXPLORER_CONTEXT_MENU,
    },
  })
  return child.get(MapExplorerWidget)
}
