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
  CommonCommands,
  CompositeTreeNode,
  ExpandableTreeNode,
  Key,
  KeyCode,
  SelectableTreeNode,
  TREE_CONTAINER_CLASS,
  TreeNode,
  TreeProps,
  TreeSearch,
  TreeWidget,
  createTreeContainer,
} from '@theia/core/lib/browser'
import { SearchBox, SearchBoxProps } from '@theia/core/lib/browser/tree/search-box'
import {
  SearchBoxDebounce,
  SearchBoxDebounceOptions,
} from '@theia/core/lib/browser/tree/search-box-debounce'
import { codicon } from '@theia/core/lib/browser/widgets'
import { nls } from '@theia/core/lib/common/nls'
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry,
} from '@theia/core/lib/browser/shell/tab-bar-toolbar'
import { ContextKeyService } from '@theia/core/lib/browser/context-key-service'
import { KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser/keybinding'
import { Command, CommandContribution, CommandRegistry, Emitter } from '@theia/core/lib/common'
import { filterTree, parseQuery, pickSelectTarget, restorePlan, SearchRow } from './explorer-match'

export const FindInExplorerCommand: Command = {
  id: 'hackbench.explorer.find',
  label: 'Find',
  category: 'HackBench',
  iconClass: 'codicon codicon-search',
}

const FIND_FOCUSED_KEY = 'hackbench.explorerFindFocused'

/** Escape in a focused find input: close the box, focus the tree. */
export const CloseFindCommand: Command = { id: 'hackbench.explorer.closeFind' }

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

  /** The last pattern given, so a rebuilt tree can be filtered again. */
  protected lastPattern: string | undefined
  /** False for no text, a bare `$`/`0x` and a root with no rows: then every row passes. */
  protected filtering = false

  get active(): boolean {
    return this.filtering
  }

  /** Run the last pattern again, after the tree behind it was rebuilt. */
  refilter(): Promise<TreeNode[]> {
    return this.filter(this.lastPattern)
  }

  override passesFilters(node: TreeNode): boolean {
    return !this.filtering || super.passesFilters(node)
  }

  override async filter(pattern: string | undefined): Promise<TreeNode[]> {
    this.lastPattern = pattern
    const query = parseQuery(pattern ?? '')
    const { matches, shown, searchable } = filterTree(this.tree.root, query, n => this.rowOf(n))
    // A root of messages only ("Open a project") has nothing to filter: keep it.
    this.filtering = query.text !== '' && !query.incomplete && searchable
    this._filteredNodesAndParents = shown
    // Empty ranges: no text highlight (out of scope), but Theia sizes its match
    // count and the Up/Down cycle from this list.
    this._filterResult = matches.map(item => ({ item, ranges: [], score: 0 }) as never)
    this._filteredNodes = matches
    this.outcomeEmitter.fire({ query: this.filtering ? query.text : null, matches })
    // Not the matches: TreeWidget selects the first node of this event, and
    // Maps, Graphics and Palettes open on selection. The widget selects its
    // own target, quietly, in onSearchOutcome.
    this.fireFilteredNodesChanged([])
    return matches.slice()
  }

  override dispose(): void {
    this.outcomeEmitter.dispose()
    super.dispose()
  }
}

/** A debounce that can take the whole text at once, as a text field gives it. */
export class ExplorerSearchDebounce extends SearchBoxDebounce {
  protected timer: ReturnType<typeof setTimeout> | undefined

  constructor(options: SearchBoxDebounceOptions) {
    super(options)
    // Core's handler is a lodash debounce that `.bind` stripped of flush(), so
    // Enter inside the delay could not apply the text just typed. Own timer
    // instead, used by both key-fed append() and set().
    ;(this as unknown as { handler: () => void }).handler = () => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.flush(), options.delay)
    }
  }

  set(text: string): void {
    this.state = text
    this.handler()
  }

  /** Deliver a pending change now; nothing happens when none is waiting. */
  flush(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.fireChanged(this.state)
  }

  override dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    super.dispose()
  }
}

// The one find input holding focus, so the Escape keybinding can close it
// before core's "hide notifications" binding eats the key (#336).
let focusedBox: ExplorerSearchBox | undefined
const findFocusEmitter = new Emitter<boolean>()
/** True while a find input has focus; feeds the keybinding's when-context. */
export const onFindFocusChange = findFocusEmitter.event
/** Close the focused find box and give focus back to its tree. */
export function dismissFocusedFind(): void {
  focusedBox?.dismiss()
}

/**
 * Starts in filter mode: hiding non-matches is the point, not an opt-in. Takes
 * Space while open, so a name like "donut plains" can be typed.
 *
 * Theia's own box has no text field at all: a plain span that echoes keys the
 * TREE caught, so opening it empty drew buttons and nothing to type in, and its
 * focus handler sent focus straight back to the tree (#336 T4). This one draws
 * a real input and takes focus on open. The tree still feeds it while the tree
 * has focus (handleKey), so a user who just starts typing keeps working.
 */
export class ExplorerSearchBox extends SearchBox {
  protected readonly dismissEmitter = new Emitter<void>()
  protected readonly enterEmitter = new Emitter<KeyboardEvent>()
  /** Escape or the close button, used in the input: focus belongs on the tree again. */
  readonly onDismiss = this.dismissEmitter.event
  /** Enter typed in the input: the owner opens the selected match. */
  readonly onEnter = this.enterEmitter.event
  protected inputEl: HTMLInputElement | null = null
  protected wantFocus = false

  constructor(props: SearchBoxProps, debounce: ExplorerSearchDebounce) {
    super(props, debounce)
    this.toDispose.pushAll([this.dismissEmitter, this.enterEmitter])
  }

  protected setFocused(on: boolean): void {
    if (on)
      focusedBox = this // eslint-disable-line @typescript-eslint/no-this-alias
    else if (focusedBox === this) focusedBox = undefined
    else return
    findFocusEmitter.fire(on)
  }

  /** Hide the box and hand focus back to the tree. */
  dismiss(): void {
    this.hide()
    this.dismissEmitter.fire()
  }

  /** Apply any text still inside the debounce delay (Enter acts on what is typed). */
  flushPending(): void {
    ;(this.debounce as ExplorerSearchDebounce).flush()
  }

  /** Focus the text field now, or as soon as the first render mounts it. */
  focusInput(): void {
    if (this.inputEl) this.inputEl.focus()
    else this.wantFocus = true
  }

  /** The whole text from the field (typing, paste, cut): same effects as a key. */
  protected setText(value: string): void {
    if (this.inputText === '' && !this._isFiltering) this.doFireFilterToggle(true)
    this.inputText = value
    // Core only clears the red no-match state when a non-empty filter reports
    // matches; emptied text sends no such report.
    if (value === '') this.hasMatch = true
    ;(this.debounce as ExplorerSearchDebounce).set(value)
    this.update()
  }

  protected onInputKey(e: React.KeyboardEvent<HTMLInputElement>): void {
    // An IME confirming a candidate sends Enter/Escape: those belong to it.
    if (e.nativeEvent.isComposing && (e.key === 'Escape' || e.key === 'Enter')) return
    if (e.key === 'Escape') {
      e.preventDefault()
      this.dismiss()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      this.enterEmitter.fire(e.nativeEvent)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (this.hasMatch) {
        if (e.key === 'ArrowDown') this.fireNext()
        else this.firePrevious()
      }
    }
  }

  protected override render(): React.ReactNode {
    const button = (cls: string, title: string, onClick: () => void, off = false) =>
      React.createElement('div', {
        className: `theia-search-button ${off ? 'no-match' : 'action-label'} ${cls}`,
        title,
        onClick,
        // A click must not move focus off the input (or the typed text loses
        // its home and the next key goes to the tree).
        onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
      })
    return React.createElement(
      'div',
      { className: `theia-search-box${this.hasMatch ? '' : ' no-match'}` },
      React.createElement('input', {
        className: 'theia-search-input hb-explorer-search-input',
        type: 'text',
        value: this.inputText,
        spellCheck: false,
        autoComplete: 'off',
        'aria-label': 'Find',
        placeholder: 'Find',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => this.setText(e.target.value),
        onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => this.onInputKey(e),
        onFocus: () => this.setFocused(true),
        onBlur: () => this.setFocused(false),
        ref: (el: HTMLInputElement | null) => {
          this.inputEl = el
          if (el && this.wantFocus) {
            this.wantFocus = false
            el.focus()
          }
        },
      }),
      React.createElement(
        'div',
        { className: 'theia-search-buttons-wrapper' },
        button(
          this._isFiltering ? codicon('list-filter') : codicon('list-selection'),
          this._isFiltering
            ? nls.localize('theia/core/searchbox/showAll', 'Show all items')
            : nls.localize('theia/core/searchbox/showOnlyMatching', 'Show only matching items'),
          () => this.fireFilterToggle(),
        ),
        button(
          codicon('find-previous-match'),
          nls.localize('theia/core/searchbox/previous', 'Previous (Up)'),
          () => this.hasMatch && this.firePrevious(),
          !this.hasMatch,
        ),
        button(
          codicon('find-next-match'),
          nls.localize('theia/core/searchbox/next', 'Next (Down)'),
          () => this.hasMatch && this.fireNext(),
          !this.hasMatch,
        ),
        button(
          codicon('widget-close'),
          nls.localize('theia/core/searchbox/close', 'Close (Escape)'),
          () => this.dismiss(),
        ),
      ),
    )
  }

  protected override canHandle(keyCode: KeyCode | undefined): boolean {
    if (
      keyCode &&
      this.isVisible &&
      Key.equals(Key.SPACE, keyCode) &&
      !keyCode.ctrl &&
      !keyCode.alt &&
      !keyCode.meta
    ) {
      return true
    }
    return super.canHandle(keyCode)
  }

  protected override handleKey(keyCode: KeyCode): void {
    // Only the first key of a search: later keystrokes must not undo a user
    // who switched filtering off with the box's button.
    if (this.inputText === '' && !this._isFiltering) this.doFireFilterToggle(true)
    super.handleKey(keyCode)
  }
}
/**
 * Base of the four explorers. Subclasses say what a row matches and the noun
 * for the empty state; this class owns the filter's side effects on expansion,
 * selection and Enter.
 */
export abstract class ExplorerTreeWidget extends TreeWidget {
  /** Plural noun for the empty state: "No maps match ...". */
  protected abstract readonly searchNoun: string
  protected abstract manifestPath: string
  protected abstract searchRow(node: TreeNode): SearchRow | undefined

  /** Ids expanded when the filter started; undefined while no filter is active. */
  protected expandedBeforeSearch: Set<string> | undefined
  protected snapshotProject = ''
  protected activeQuery: string | null = null
  protected matchCount = 0
  /**
   * True while the filter itself moves the selection. Subclasses that open a
   * tab on selection must not: typing would open one per keystroke.
   */
  protected selectingFromFilter = false
  protected lastRoot: TreeNode | undefined

  protected override init(): void {
    super.init()
    const search = this.treeSearch as ExplorerTreeSearch
    search.rowOf = n => this.searchRow(n)
    this.toDispose.push(search.onOutcome(o => void this.onSearchOutcome(o)))
    const box = this.searchBox as ExplorerSearchBox
    this.toDispose.pushAll([
      box.onDismiss(() => this.node.focus()),
      box.onEnter(e => void this.enterFromBox(box, e)),
    ])
    // A reload, a palette edit or a project switch swaps the root: the nodes
    // the filter chose are gone, so choose again from the current text.
    this.toDispose.push(
      this.model.onChanged(() => {
        if (this.model.root === this.lastRoot) return
        this.lastRoot = this.model.root
        // Another project: its rows are not the ones the snapshot or the typed
        // text were about, so drop the snapshot and close the box (which clears
        // the filter).
        if (this.expandedBeforeSearch && this.manifestPath !== this.snapshotProject) {
          this.expandedBeforeSearch = undefined
          this.searchBox.hide()
        }
        if (search.active) {
          void search.refilter().then(() => {
            this.searchHighlights = search.getHighlights()
            this.update()
          })
        }
      }),
    )
  }

  /**
   * Enter in the input: first apply text still inside the debounce delay and
   * let its outcome land, or Enter would open the match of the OLD query.
   */
  protected async enterFromBox(box: ExplorerSearchBox, e: KeyboardEvent): Promise<void> {
    box.flushPending()
    await this.outcomeQueue
    this.handleEnter(e)
  }

  /** Outcomes run one at a time, in order, so a restore never overlaps an earlier expand. */
  protected outcomeQueue: Promise<void> = Promise.resolve()
  /** Bumped per outcome: an earlier one, still awaiting an expand, stops when a newer arrives. */
  protected outcomeGen = 0

  protected onSearchOutcome(o: SearchOutcome): Promise<void> {
    const gen = ++this.outcomeGen
    this.outcomeQueue = this.outcomeQueue
      .then(() => this.applyOutcome(o, gen))
      .catch(err => console.error('explorer search', err))
    return this.outcomeQueue
  }

  protected async applyOutcome(o: SearchOutcome, gen: number): Promise<void> {
    this.activeQuery = o.query
    this.matchCount = o.matches.length
    if (o.query === null) {
      await this.restoreExpansion()
    } else {
      if (!this.expandedBeforeSearch) {
        this.expandedBeforeSearch = this.expandedIds()
        this.snapshotProject = this.manifestPath
      }
      // Ancestors only: a matching folder is not opened by its own match.
      for (const m of o.matches) {
        for (let p = m.parent; p; p = p.parent) {
          if (gen !== this.outcomeGen) return
          if (ExpandableTreeNode.is(p) && !p.expanded) await this.model.expandNode(p)
        }
      }
      if (gen !== this.outcomeGen) return
      this.selectTarget(o.matches)
    }
    this.update()
  }

  protected selectTarget(matches: readonly TreeNode[]): void {
    const target = pickSelectTarget(matches, n => this.searchRow(n))
    if (!target || !SelectableTreeNode.is(target)) return
    this.selectingFromFilter = true
    try {
      this.model.selectNode(target)
    } finally {
      this.selectingFromFilter = false
    }
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

  /** Reopen what was open and close what the filter opened, at any depth. */
  protected async restoreExpansion(): Promise<void> {
    const before = this.expandedBeforeSearch
    this.expandedBeforeSearch = undefined
    if (!before) return
    for (const { node, expand } of restorePlan(this.model.root, before)) {
      if (!ExpandableTreeNode.is(node)) continue
      if (expand) await this.model.expandNode(node)
      else await this.model.collapseNode(node)
    }
  }

  /** The toolbar's Find button and Ctrl+F: show the box and put the cursor in its field. */
  openSearch(): void {
    this.searchBox.show()
    // SearchBox is a ReactWidget: show() only unhides its node, and it draws on
    // an update request. Theia's own path updates in handleKey on the first
    // typed key, so opening without one left an empty zero-size node (#336 T4).
    this.searchBox.update()
    // Not the tree: Theia's box focus handler and the old code both sent focus
    // there, which left an empty box nothing could type into (#336 T4).
    ;(this.searchBox as ExplorerSearchBox).focusInput()
  }

  /**
   * Open a matched row the way a click would; false leaves Enter to Theia
   * (folders toggle). Only runs while a filter is active.
   */
  protected openMatch(_node: TreeNode): boolean {
    return false
  }

  protected override handleEnter(event: KeyboardEvent): void {
    const node = this.model.selectedNodes[0]
    if (
      this.activeQuery !== null &&
      node &&
      !this.searchRow(node)?.folder &&
      this.openMatch(node)
    ) {
      return
    }
    super.handleEnter(event)
  }

  /** Space belongs to the search box while it is open. */
  protected override handleSpace(event: KeyboardEvent): void {
    if (!this.searchBox.isVisible) super.handleSpace(event)
  }

  /** The empty state replaces the tree: under it, a full-height tree hides it. */
  protected override render(): React.ReactNode {
    if (this.activeQuery === null || this.matchCount > 0) return super.render()
    return React.createElement(
      'div',
      { className: TREE_CONTAINER_CLASS },
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
      new ExplorerSearchBox(options, new ExplorerSearchDebounce(options)),
  } as never)
}

/** One Find command and toolbar button for every explorer. */
@injectable()
export class ExplorerFindContribution
  implements CommandContribution, TabBarToolbarContribution, KeybindingContribution
{
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell
  @inject(ContextKeyService) protected readonly contextKeys!: ContextKeyService

  /**
   * Core binds Escape to hide notifications while any is showing, in the
   * capture phase, so the first Escape in the find input would only dismiss a
   * toast. This binding is true only while a find input has focus and closes
   * the box instead; it is registered after core's, and later bindings win.
   */
  registerKeybindings(keybindings: KeybindingRegistry): void {
    const focused = this.contextKeys.createKey<boolean>(FIND_FOCUSED_KEY, false)
    onFindFocusChange(v => focused.set(v))
    keybindings.registerKeybinding({
      command: CloseFindCommand.id,
      keybinding: 'esc',
      when: FIND_FOCUSED_KEY,
    })
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(CloseFindCommand, { execute: () => dismissFocusedFind() })
    commands.registerCommand(FindInExplorerCommand, {
      execute: (w?: unknown) => {
        const target = w instanceof ExplorerTreeWidget ? w : this.shell.currentWidget
        if (target instanceof ExplorerTreeWidget) target.openSearch()
      },
      isEnabled: (w?: unknown) =>
        w instanceof ExplorerTreeWidget || this.shell.currentWidget instanceof ExplorerTreeWidget,
      isVisible: (w?: unknown) => w instanceof ExplorerTreeWidget,
    })
    // Core binds Ctrl+F to a no-op Find and its keybinding registry takes the
    // key first, so a DOM listener on the tree never sees it. Ours is added
    // later and wins while an explorer is the active widget.
    commands.registerHandler(CommonCommands.FIND.id, {
      execute: () => this.activeExplorer()?.openSearch(),
      isEnabled: () => this.activeExplorer() !== undefined,
    })
  }

  protected activeExplorer(): ExplorerTreeWidget | undefined {
    const w = this.shell.activeWidget
    return w instanceof ExplorerTreeWidget ? w : undefined
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
