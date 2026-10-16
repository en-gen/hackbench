/**
 * Search and filter for the four explorers (#336), on Theia's own tree search
 * (docs/decisions/2026-09-20-theia-idioms-only.md): the type-to-filter
 * SearchBox, filter mode, next/previous. What changes is WHAT matches: a row's
 * id or names (explorer-match.ts) instead of fuzzy label matching, because a
 * user types `1fc` or part of a map name, not a fuzzy pattern.
 */
import * as React from '@theia/core/shared/react'
import { Container, inject, injectable, interfaces } from '@theia/core/shared/inversify'
import {
  ApplicationShell,
  CompositeTreeNode,
  ExpandableTreeNode,
  Key,
  KeyCode,
  KeyModifier,
  TreeNode,
  TreeProps,
  TreeSearch,
  TreeWidget,
  createTreeContainer,
} from '@theia/core/lib/browser'
import { SearchBox, SearchBoxProps } from '@theia/core/lib/browser/tree/search-box'
import { SearchBoxDebounce } from '@theia/core/lib/browser/tree/search-box-debounce'
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry,
} from '@theia/core/lib/browser/shell/tab-bar-toolbar'
import { Command, CommandContribution, CommandRegistry, Emitter } from '@theia/core/lib/common'
import { parseQuery, rowMatches, SearchRow } from './explorer-match'

export const FindInExplorerCommand: Command = {
  id: 'hackbench.explorer.find',
  label: 'Find',
  category: 'HackBench',
  iconClass: 'codicon codicon-search',
}

export interface SearchOutcome {
  /** Null when the filter was cleared. */
  query: string | null
  matches: readonly TreeNode[]
}

/** Filters by `rowOf` instead of fuzzy-matching the label. */
@injectable()
export class ExplorerTreeSearch extends TreeSearch {
  /** Set by the owning widget; undefined means the row can never match. */
  rowOf: (node: TreeNode) => SearchRow | undefined = () => undefined

  protected readonly outcomeEmitter = new Emitter<SearchOutcome>()
  readonly onOutcome = this.outcomeEmitter.event

  override async filter(pattern: string | undefined): Promise<TreeNode[]> {
    const { root } = this.tree
    this._filteredNodesAndParents = new Set()
    const query = parseQuery(pattern ?? '')
    const matches: TreeNode[] = []
    if (root && query.text !== '') {
      const walk = (node: TreeNode): void => {
        const row = this.rowOf(node)
        if (row && rowMatches(query, row)) matches.push(node)
        if (CompositeTreeNode.is(node)) node.children.forEach(walk)
      }
      walk(root)
    }
    // Empty ranges: the explorers draw their own captions, but Theia counts
    // matches from this list.
    this._filterResult = matches.map(item => ({ item, ranges: [], score: 0 }) as never)
    this._filteredNodes = matches
    matches.forEach(m => this.addAllParentsToFilteredSet(m))
    this.outcomeEmitter.fire({ query: query.text === '' ? null : query.text, matches })
    this.fireFilteredNodesChanged(this._filteredNodes)
    return matches.slice()
  }

  override dispose(): void {
    this.outcomeEmitter.dispose()
    super.dispose()
  }
}

/** Starts in filter mode: hiding non-matches is the point, not an opt-in. */
export class ExplorerSearchBox extends SearchBox {
  protected override handleKey(keyCode: KeyCode): void {
    if (!this._isFiltering) this.doFireFilterToggle(true)
    super.handleKey(keyCode)
  }
}

/**
 * Base of the four explorers. Subclasses say what a row matches and the noun
 * for the empty state; this class owns the filter's side effects on expansion.
 */
export abstract class ExplorerTreeWidget extends TreeWidget {
  /** Plural noun for the empty state: "No maps match ...". */
  protected abstract readonly searchNoun: string
  protected abstract searchRow(node: TreeNode): SearchRow | undefined

  /** Ids expanded when the filter started; undefined while no filter is active. */
  protected expandedBeforeSearch: Set<string> | undefined
  protected activeQuery: string | null = null
  protected matchCount = 0

  protected override init(): void {
    super.init()
    const search = this.treeSearch as ExplorerTreeSearch
    search.rowOf = n => this.searchRow(n)
    this.toDispose.push(search.onOutcome(o => void this.onSearchOutcome(o)))
  }

  protected async onSearchOutcome(o: SearchOutcome): Promise<void> {
    this.activeQuery = o.query
    this.matchCount = o.matches.length
    if (o.query === null) {
      await this.restoreExpansion()
    } else {
      this.expandedBeforeSearch ??= this.expandedIds()
      for (const m of o.matches) {
        for (let p = m.parent; p; p = p.parent) {
          if (ExpandableTreeNode.is(p) && !p.expanded) await this.model.expandNode(p)
        }
      }
    }
    this.update()
  }

  protected expandedIds(): Set<string> {
    const ids = new Set<string>()
    const walk = (n: TreeNode): void => {
      if (ExpandableTreeNode.is(n) && n.expanded) ids.add(n.id)
      if (CompositeTreeNode.is(n)) n.children.forEach(walk)
    }
    if (this.model.root) walk(this.model.root)
    return ids
  }

  /** Reopen what was open and close what the filter opened, parents first. */
  protected async restoreExpansion(): Promise<void> {
    const before = this.expandedBeforeSearch
    this.expandedBeforeSearch = undefined
    if (!before || !this.model.root) return
    const queue: TreeNode[] = [this.model.root]
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i]!
      if (ExpandableTreeNode.is(n)) {
        if (before.has(n.id) && !n.expanded) await this.model.expandNode(n)
        else if (!before.has(n.id) && n.expanded) await this.model.collapseNode(n)
      }
      if (CompositeTreeNode.is(n) && (!ExpandableTreeNode.is(n) || n.expanded)) {
        queue.push(...n.children)
      }
    }
  }

  /** The toolbar's Find button and Ctrl+F: show the box and keep keys on the tree. */
  openSearch(): void {
    this.searchBox.show()
    this.node.focus()
  }

  protected override onAfterAttach(msg: Parameters<TreeWidget['onAfterAttach']>[0]): void {
    super.onAfterAttach(msg)
    const ctrlF = KeyCode.createKeyCode({ first: Key.KEY_F, modifiers: [KeyModifier.CtrlCmd] })
    this.addKeyListener(this.node, ctrlF, e => {
      e.preventDefault()
      e.stopPropagation()
      this.openSearch()
    })
  }

  protected override render(): React.ReactNode {
    const tree = super.render()
    if (this.activeQuery === null || this.matchCount > 0) return tree
    return React.createElement(
      React.Fragment,
      null,
      tree,
      React.createElement(
        'div',
        { className: 'hb-explorer-no-match', role: 'status' },
        `No ${this.searchNoun} match "${this.activeQuery}".`,
      ),
    )
  }
}

/** A tree container with the explorer search wired in. */
export function createExplorerTreeContainer(
  parent: interfaces.Container,
  widget: new (...args: never[]) => ExplorerTreeWidget,
  props: Partial<TreeProps>,
): Container {
  return createTreeContainer(parent, {
    widget: widget as never,
    props: { ...props, search: true },
    search: ExplorerTreeSearch,
    searchBoxFactory: () => (options: SearchBoxProps) =>
      new ExplorerSearchBox(options, new SearchBoxDebounce(options)),
  } as never)
}

/** One Find command and toolbar button for every explorer. */
@injectable()
export class ExplorerFindContribution implements CommandContribution, TabBarToolbarContribution {
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(FindInExplorerCommand, {
      execute: (w?: unknown) => {
        const target = w instanceof ExplorerTreeWidget ? w : this.shell.currentWidget
        if (target instanceof ExplorerTreeWidget) target.openSearch()
      },
      isEnabled: (w?: unknown) =>
        w instanceof ExplorerTreeWidget || this.shell.currentWidget instanceof ExplorerTreeWidget,
      isVisible: (w?: unknown) => w instanceof ExplorerTreeWidget,
    })
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: FindInExplorerCommand.id,
      command: FindInExplorerCommand.id,
      tooltip: FindInExplorerCommand.label,
      priority: -1,
    })
  }
}
