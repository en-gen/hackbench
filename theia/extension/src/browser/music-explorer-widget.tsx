/**
 * The music explorer: every BGM track the project's cartridge's level music
 * bank holds, read through MusicService.
 *
 * Flat by design: unlike maps, tracks have no containment hierarchy (see
 * docs/glossary.md and src/rom/MusicData.ts), so this is a plain TreeWidget
 * list rather than a grouped tree, kept for the row selection, keyboard nav
 * and theming MapExplorerWidget already established.
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
import { MusicService, MusicTrackDto } from '../common/music-protocol'
import { ProjectContext } from './project-context'

export const MUSIC_EXPLORER_ID = 'hackbench.music-explorer'

/** A track row, or the single message row shown when there is nothing to list. */
export interface MusicTrackNode extends CompositeTreeNode, SelectableTreeNode {
  /** 1-based SPC BGM command; -1 for a message row. */
  bgmCommand: number
  bgmHex: string
  levelIndices: number[]
  kind: 'track' | 'message'
}

const hexIndex = (i: number): string => `$${i.toString(16).toUpperCase()}`

@injectable()
export class MusicExplorerWidget extends TreeWidget {
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

  @inject(MusicService) protected readonly music!: MusicService
  @inject(ProjectContext) protected readonly projectContext!: ProjectContext

  /** Exposed for tests: the count the backend reported for this cartridge. */
  trackCount = 0

  /** The project currently loaded, needed to open a track from a row. */
  protected manifestPath = ''

  /**
   * Fired when a row is clicked, carrying the track it names.
   *
   * An event rather than a direct call so the tree stays a view, the same
   * separation MapExplorerWidget.onMapOpened keeps.
   */
  protected readonly onTrackOpenedEmitter = new Emitter<{
    manifestPath: string
    bgmCommand: number
    pinned: boolean
  }>()
  readonly onTrackOpened = this.onTrackOpenedEmitter.event

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) model: TreeModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer,
  ) {
    super(props, model, contextMenuRenderer)
    this.id = MUSIC_EXPLORER_ID
    this.title.label = 'Music'
    this.title.caption = 'Music'
    this.title.iconClass = 'codicon codicon-music'
    this.title.closable = true
  }

  @postConstruct()
  protected init(): void {
    super.init()
    this.setRoot([this.message('Open a project to load its music')])

    // ProjectContext is the shared "which project is open" signal every
    // surface reacts to (project-context.ts); this widget never opens one.
    if (this.projectContext.current) {
      void this.load(this.projectContext.current.manifestPath)
    }
    this.toDispose.push(
      this.projectContext.onChanged(project => {
        if (project) {
          void this.load(project.manifestPath)
        } else {
          this.manifestPath = ''
          this.trackCount = 0
          this.setRoot([this.message('Open a project to load its music')])
        }
      }),
    )
  }

  /**
   * Load a project's music.
   *
   * A cartridge this machine cannot locate is an ordinary first-run state,
   * mirroring MapExplorerWidget.load's rom-not-located branch.
   */
  async load(manifestPath: string): Promise<void> {
    this.manifestPath = manifestPath
    const result = await this.music.loadMusic(manifestPath)

    if (result.status === 'rom-not-located') {
      this.trackCount = 0
      this.setRoot([
        this.message(`Locate ${result.baseRom.title || 'the base cartridge'} to load its music`),
      ])
      return
    }

    if (result.status === 'bank-unreadable') {
      // A distinct refusal, not zero tracks: the bank's upload routine has
      // been replaced (MusicService.loadMusic), which is a fact about this
      // cartridge, not a fact about its soundtrack.
      this.trackCount = 0
      this.setRoot([
        this.message(
          "This cartridge's music bank could not be read (its upload routine has been modified)",
        ),
      ])
      return
    }

    this.trackCount = result.list.trackCount
    if (result.list.tracks.length === 0) {
      this.setRoot([this.message('No BGM tracks found')])
      return
    }
    this.setRoot(result.list.tracks.map(t => this.toNode(t)))
  }

  protected setRoot(children: MusicTrackNode[]): void {
    const root: CompositeTreeNode = {
      id: 'hackbench-music-root',
      name: 'music',
      visible: false,
      parent: undefined,
      children,
    }
    for (const c of children) (c as { parent?: unknown }).parent = root
    this.model.root = root
  }

  protected toNode(dto: MusicTrackDto): MusicTrackNode {
    return {
      id: `track:${dto.bgmCommand}`,
      name: `Track ${dto.bgmCommand}`,
      bgmCommand: dto.bgmCommand,
      bgmHex: dto.bgmHex,
      levelIndices: dto.levelIndices,
      kind: 'track',
      parent: undefined,
      children: [],
      selected: false,
    }
  }

  protected message(text: string): MusicTrackNode {
    return {
      id: 'message',
      name: text,
      bgmCommand: -1,
      bgmHex: '',
      levelIndices: [],
      kind: 'message',
      parent: undefined,
      children: [],
      selected: false,
    }
  }

  protected override tapNode(node: TreeNode | undefined): void {
    super.tapNode(node)
    this.fireOpen(node as MusicTrackNode | undefined, false)
  }

  /** Double click pins, matching the map and graphics explorers. */
  protected override handleDblClickEvent(
    node: TreeNode | undefined,
    event: React.MouseEvent<HTMLElement>,
  ): void {
    super.handleDblClickEvent(node, event)
    this.fireOpen(node as MusicTrackNode | undefined, true)
  }

  protected fireOpen(track: MusicTrackNode | undefined, pinned: boolean): void {
    if (!track || track.kind !== 'track' || !this.manifestPath) return
    this.onTrackOpenedEmitter.fire({
      manifestPath: this.manifestPath,
      bgmCommand: track.bgmCommand,
      pinned,
    })
  }

  protected override renderIcon(node: TreeNode, _props: NodeProps): React.ReactNode {
    const track = node as MusicTrackNode
    if (track.kind !== 'track') return undefined
    return <span className="hb-music-icon codicon codicon-music" />
  }

  protected override renderCaption(node: TreeNode, props: NodeProps): React.ReactNode {
    const track = node as MusicTrackNode
    if (track.kind === 'message') return super.renderCaption(node, props)

    return [
      <span key="cmd" className="hb-music-command">
        {track.bgmHex}
      </span>,
      track.levelIndices.length > 0 ? (
        <span key="idx" className="hb-music-note">
          {track.levelIndices.map(hexIndex).join(', ')}
        </span>
      ) : null,
    ]
  }
}

export function createMusicExplorerWidget(parent: interfaces.Container): MusicExplorerWidget {
  const child: Container = createTreeContainer(parent, {
    widget: MusicExplorerWidget,
    props: {
      // A row click both selects and opens (see tapNode); the toggle should
      // not also collapse whatever the row is doing, same as the map explorer.
      expandOnlyOnExpansionToggleClick: true,
      globalSelection: true,
    },
  })
  return child.get(MusicExplorerWidget)
}
