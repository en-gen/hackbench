/**
 * The audio explorer: every BGM track and sound effect a project's ROM
 * holds, grouped the way the ROM groups them.
 *
 *   music                    sfx
 *   |- level      29         |- port 0 ($1DF9)  42
 *   |- overworld   9         |- port 3 ($1DFC)  52
 *   |- credits    12
 *
 * A row click SELECTS. It does not open an editor: a track is a short row
 * of facts plus a transport, and pushing that into a tab would put the play
 * controls somewhere other than the list they act on. The transport is
 * composed below the tree by overriding `render`.
 *
 * ── Why the groups are what they are ─────────────────────────────────────
 *
 * Neither level of grouping is a taxonomy we invented. The three music
 * banks are three separate upload routines with three ROM addresses, and
 * they all upload to the SAME ARAM address, so only one is resident at a
 * time and a BGM command means a different song in each: $02 is the level
 * bank's overworld theme and the overworld bank's Donut Plains theme.
 *
 * Sound effects are grouped the same way and for the same reason. They live
 * in the SPC engine upload rather than a music bank, behind one pointer
 * table per APU port, and id $05 on port 0 is a different sound from id $05
 * on port 3. Port 1 has no table at all: its ids 1-4 and $FF are
 * hand-written routines in the engine, so nothing enumerable lives there.
 *
 * Flattening either group would be listing two meanings of one number.
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
  QuickInputService,
  TreeModel,
  TreeNode,
  TreeProps,
  TreeWidget,
  CompositeTreeNode,
  SelectableTreeNode,
  createTreeContainer,
} from '@theia/core/lib/browser'
import { MusicBankName, MusicService, MusicTrackDto } from '../common/music-protocol'
import { ProjectContext } from './project-context'
import { spcPlayback } from './spc-playback'

export const MUSIC_EXPLORER_ID = 'hackbench.music-explorer'

/** What a row is. Drives both rendering and what the transport may act on. */
export type MusicNodeKind = 'group' | 'bank' | 'track' | 'sfxport' | 'sfx' | 'message'

export interface MusicTrackNode extends CompositeTreeNode, SelectableTreeNode {
  kind: MusicNodeKind
  /** 1-based SPC BGM command; -1 for anything that is not a track. */
  bgmCommand: number
  bgmHex: string
  /** Which bank this row belongs to, so the transport knows what to build. */
  bank?: MusicBankName
  /** For an sfx row, which APU port it came from. */
  sfxPort?: number
  /** For an sfx row, whether its phrase is a bare end marker. */
  silent?: boolean
  /** The user's name for this track, or '' if they have not given one. */
  alias: string
  levelIndices: number[]
  /** Real map slots that play this track. Level bank only. */
  maps: number[]
  /** Other commands in this bank resolving to the same song. */
  sharedWith: number[]
  /** Shown to the right of a group or bank row: "29 tracks", a refusal. */
  summary?: string
}

const hexIndex = (i: number): string => `$${i.toString(16).toUpperCase()}`
const hexByte = (i: number): string => `$${i.toString(16).toUpperCase().padStart(2, '0')}`

const BANKS: Array<{ bank: MusicBankName; label: string }> = [
  { bank: 'level', label: 'level' },
  { bank: 'overworld', label: 'overworld' },
  { bank: 'credits', label: 'credits' },
]

@injectable()
export class MusicExplorerWidget extends TreeWidget {
  /**
   * Rows belong to a project, and nothing is open on a fresh load, so none
   * of them are persisted. Theia's TreeWidget serialises its whole model by
   * default, which restores a populated tree over an empty ProjectContext:
   * the view then lists rows from a ROM the session has not opened.
   */
  override storeState(): object {
    return {}
  }

  override restoreState(_state: object): void {
    // Intentionally empty; load() repopulates when a project opens.
  }

  @inject(MusicService) protected readonly music!: MusicService
  @inject(ProjectContext) protected readonly projectContext!: ProjectContext
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService

  /** Exposed for tests: tracks across every bank that loaded. */
  trackCount = 0

  /** Per bank, the refusal reason when its upload routine did not verify. */
  refusals = new Map<MusicBankName, string>()

  /** Per bank, "$0EAED6, 16893 bytes" once it has loaded. */
  provenance = new Map<MusicBankName, string>()

  protected manifestPath = ''

  /** The track currently loaded into the player, if any. */
  playingTrack: MusicTrackNode | null = null

  /** Port 0 $FF: the 099-seconds hurry-up. Latched across track changes. */
  hurryUp = false

  /** Port 1: true is $02 (drums on), false $03 (off), undefined leaves it. */
  yoshiDrums: boolean | undefined = undefined

  /** Set when the engine itself could not be loaded, as opposed to the ROM. */
  playbackError = ''

  /** Why neither sound effect table could be read, when that is the case. */
  sfxRefusal = ''

  protected ticker: number | undefined

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) model: TreeModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer,
  ) {
    super(props, model, contextMenuRenderer)
    this.id = MUSIC_EXPLORER_ID
    this.title.label = 'Audio'
    this.title.caption = 'Audio'
    this.title.iconClass = 'codicon codicon-music'
    this.title.closable = true
    this.addClass('hb-music-panel')
  }

  @postConstruct()
  protected init(): void {
    super.init()
    this.setRoot([this.message('Open a project to load its audio')])

    if (this.projectContext.current) {
      void this.load(this.projectContext.current.manifestPath)
    }
    this.toDispose.push(
      this.projectContext.onChanged(project => {
        if (project) {
          void this.load(project.manifestPath)
        } else {
          this.reset()
          this.setRoot([this.message('Open a project to load its audio')])
        }
      }),
    )
    // The base ROM moved: rebuild as a fresh open would, nothing selected.
    this.toDispose.push(
      this.projectContext.onRomChanged(manifestPath => {
        if (manifestPath !== this.manifestPath) return
        this.model.clearSelection()
        void this.load(manifestPath)
      }),
    )
  }

  protected reset(): void {
    this.manifestPath = ''
    this.trackCount = 0
    this.refusals.clear()
    this.provenance.clear()
  }

  /**
   * Load every bank at once.
   *
   * Eager rather than lazy on expand: three calls returning fifty rows
   * between them is not worth a custom TreeImpl, and the counts beside each
   * group have to be right before anything is expanded anyway.
   */
  async load(manifestPath: string): Promise<void> {
    this.manifestPath = manifestPath
    this.reset()
    this.manifestPath = manifestPath

    const bankNodes: MusicTrackNode[] = []
    let total = 0
    let romMissing = ''

    for (const { bank, label } of BANKS) {
      const result = await this.music.loadBank(manifestPath, bank)

      if (result.status === 'rom-not-located') {
        romMissing = result.baseRom.title || 'the base ROM'
        continue
      }

      if (result.status === 'bank-unreadable') {
        // A refusal, not zero tracks. The children still carry whatever the
        // ROM's maps ask for, so the row is informative rather than empty.
        this.refusals.set(bank, result.reason)
        const rows = result.fallback.mapCounts.map(m =>
          this.trackRow(bank, {
            bgmCommand: m.bgmCommand,
            bgmHex: m.bgmHex,
            alias: m.alias,
            levelIndices: [],
            maps: new Array(m.mapCount).fill(-1),
            sharedWith: [],
          }),
        )
        bankNodes.push(this.bankRow(bank, label, rows, 'not readable', false))
        continue
      }

      this.provenance.set(bank, `${result.bank.romAddrHex}, ${result.bank.blockSize} bytes`)
      total += result.bank.tracks.length
      const rows = result.bank.tracks.map(t => this.trackRow(bank, t))
      bankNodes.push(
        this.bankRow(bank, label, rows, `${rows.length}`, bank === 'level' && rows.length > 0),
      )
    }

    if (romMissing) {
      this.setRoot([this.message(`Locate ${romMissing} to load audio`)])
      return
    }

    this.trackCount = total
    const sfx = await this.loadSfxGroup(manifestPath)
    this.setRoot([this.group('music', 'music', bankNodes, `${total}`, true), sfx])
  }

  /**
   * The sfx subtree: one folder per APU port that has a table.
   *
   * A port with no table is not an empty folder. On a ROM whose sound
   * driver has been replaced the stock reader is absent entirely, and
   * listing the stock 42 and 52 there would name effects the ROM does not
   * have. See docs/sfx-tables.md.
   */
  protected async loadSfxGroup(manifestPath: string): Promise<MusicTrackNode> {
    const result = await this.music.loadSfx(manifestPath)

    if (result.status === 'rom-not-located') {
      return this.group('sfx', 'sfx', [this.message('Locate the base ROM first')], '', false)
    }

    if (result.status === 'unavailable') {
      this.sfxRefusal = result.reasons.map(r => `${r.mirror}: ${r.reason}`).join(' ')
      return this.group(
        'sfx',
        'sfx',
        [this.message('Not readable on this ROM')],
        'unavailable',
        false,
      )
    }

    this.sfxRefusal = ''
    const ports = result.ports.map(p => {
      const rows = p.entries.map(e => ({
        ...this.base(`sfx:${p.port}:${e.id}`, e.idHex, 'sfx' as MusicNodeKind),
        bgmCommand: e.id,
        bgmHex: e.idHex,
        sfxPort: p.port,
        silent: e.empty,
      }))
      return this.bankRowLike(
        `sfxport:${p.port}`,
        `port ${p.port} (${p.mirror})`,
        rows,
        `${rows.length}`,
        'sfxport',
      )
    })
    const total = result.ports.reduce((n, p) => n + p.entries.length, 0)
    return this.group('sfx', 'sfx', ports, `${total}`, false)
  }

  // ── Node construction ─────────────────────────────────────────────────

  protected base(id: string, name: string, kind: MusicNodeKind): MusicTrackNode {
    return {
      id,
      name,
      kind,
      bgmCommand: -1,
      bgmHex: '',
      alias: '',
      levelIndices: [],
      maps: [],
      sharedWith: [],
      parent: undefined,
      children: [],
      selected: false,
    }
  }

  protected group(
    id: string,
    name: string,
    children: MusicTrackNode[],
    summary: string,
    expanded: boolean,
  ): MusicTrackNode {
    const node = { ...this.base(`group:${id}`, name, 'group'), summary, children }
    return this.adopt(Object.assign(node, { expanded }) as MusicTrackNode)
  }

  /** An expandable row that is not a music bank: an sfx port folder. */
  protected bankRowLike(
    id: string,
    name: string,
    children: MusicTrackNode[],
    summary: string,
    kind: MusicNodeKind,
  ): MusicTrackNode {
    const node = { ...this.base(id, name, kind), summary, children }
    return this.adopt(Object.assign(node, { expanded: false }) as MusicTrackNode)
  }

  protected bankRow(
    bank: MusicBankName,
    label: string,
    children: MusicTrackNode[],
    summary: string,
    expanded: boolean,
  ): MusicTrackNode {
    const node = { ...this.base(`bank:${bank}`, label, 'bank'), bank, summary, children }
    return this.adopt(Object.assign(node, { expanded }) as MusicTrackNode)
  }

  protected trackRow(bank: MusicBankName, dto: MusicTrackDto): MusicTrackNode {
    const alias = dto.alias ?? ''
    return {
      ...this.base(`track:${bank}:${dto.bgmCommand}`, alias || `Track ${dto.bgmHex}`, 'track'),
      bank,
      bgmCommand: dto.bgmCommand,
      bgmHex: dto.bgmHex,
      alias,
      levelIndices: dto.levelIndices,
      maps: dto.maps ?? [],
      sharedWith: dto.sharedWith ?? [],
    }
  }

  protected message(text: string): MusicTrackNode {
    return this.base('message:' + text.slice(0, 24), text, 'message')
  }

  /**
   * Parent every child, which Theia needs before the model will walk them.
   *
   * Expandability is structural: TreeWidget asks ExpandableTreeNode.is,
   * which tests for an `expanded` property, so setting it is enough and
   * the interface does not need importing.
   */
  protected adopt(node: MusicTrackNode): MusicTrackNode {
    for (const c of node.children) (c as { parent?: unknown }).parent = node
    return node
  }

  protected setRoot(children: MusicTrackNode[]): void {
    const root: CompositeTreeNode = {
      id: 'hackbench-music-root',
      name: 'audio',
      visible: false,
      parent: undefined,
      children,
    }
    for (const c of children) (c as { parent?: unknown }).parent = root
    this.model.root = root
  }

  // ── Playback ──────────────────────────────────────────────────────────
  //
  // Snapshots are rebuilt per play rather than cached. They come from the
  // project's WORKING COPY, so an edit made elsewhere in the session is
  // audible immediately, and a cache keyed on anything less than the whole
  // working copy would go stale silently.

  /** Every track row, depth first, in display order. */
  protected trackNodes(): MusicTrackNode[] {
    const out: MusicTrackNode[] = []
    const walk = (n: TreeNode): void => {
      const m = n as MusicTrackNode
      if (m.kind === 'track') out.push(m)
      if (CompositeTreeNode.is(n)) for (const c of n.children) walk(c)
    }
    if (this.model.root) walk(this.model.root)
    return out
  }

  /** Every sound effect row, in display order. */
  protected sfxNodes(): MusicTrackNode[] {
    const out: MusicTrackNode[] = []
    const walk = (n: TreeNode): void => {
      const m = n as MusicTrackNode
      if (m.kind === 'sfx') out.push(m)
      if (CompositeTreeNode.is(n)) for (const c of n.children) walk(c)
    }
    if (this.model.root) walk(this.model.root)
    return out
  }

  /** The row the transport acts on: the selection, else the first track. */
  protected currentTrack(): MusicTrackNode | undefined {
    const selected = this.model.selectedNodes[0] as MusicTrackNode | undefined
    if (selected && selected.kind === 'track') return selected
    return this.trackNodes()[0]
  }

  /**
   * Play one track.
   *
   * Must run inside the click that asked for it: an AudioContext only
   * starts from a user gesture, so an await before the first resume would
   * leave the engine silently locked.
   */
  async playTrack(track: MusicTrackNode): Promise<void> {
    if (!this.manifestPath || !track.bank || this.refusals.has(track.bank)) return
    this.playbackError = ''

    const bytes = await this.music.trackSpc(this.manifestPath, track.bank, track.bgmCommand, {
      hurryUp: this.hurryUp,
      ...(this.yoshiDrums === undefined ? {} : { yoshiDrums: this.yoshiDrums }),
    })
    if (!bytes) {
      this.playbackError = `${track.bgmHex} could not be built from this ROM`
      this.update()
      return
    }

    if (!(await spcPlayback.play(Uint8Array.from(bytes)))) {
      this.playbackError = 'The SPC player could not be loaded'
      this.update()
      return
    }

    this.playingTrack = track
    this.startTicker()
    this.update()
  }

  /**
   * Play one sound effect.
   *
   * Same player, same gesture rule as a track. A silent entry still plays:
   * its phrase really is a bare end marker, and hiding that would be the
   * panel disagreeing with the ROM.
   */
  async playSfx(node: MusicTrackNode): Promise<void> {
    if (!this.manifestPath || node.sfxPort === undefined) return
    this.playbackError = ''

    const bytes = await this.music.sfxSpc(this.manifestPath, node.sfxPort, node.bgmCommand)
    if (!bytes) {
      this.playbackError = `${node.bgmHex} could not be built from this ROM`
      this.update()
      return
    }
    if (!(await spcPlayback.play(Uint8Array.from(bytes)))) {
      this.playbackError = 'The SPC player could not be loaded'
      this.update()
      return
    }
    this.playingTrack = node
    this.startTicker()
    this.update()
  }

  async togglePlay(): Promise<void> {
    if (spcPlayback.state === 'stopped') {
      const selected = this.model.selectedNodes[0] as MusicTrackNode | undefined
      if (selected?.kind === 'sfx') {
        await this.playSfx(selected)
        return
      }
      const track = this.currentTrack()
      if (track) await this.playTrack(track)
      return
    }
    await spcPlayback.togglePause()
    this.update()
  }

  stopPlayback(): void {
    spcPlayback.stop()
    this.playingTrack = null
    this.stopTicker()
    this.update()
  }

  /** Step by one track row and play it, wrapping at either end. */
  async step(delta: number): Promise<void> {
    const tracks = this.trackNodes().filter(t => t.bank && !this.refusals.has(t.bank))
    if (tracks.length === 0) return
    const at = this.playingTrack ? tracks.indexOf(this.playingTrack) : -1
    const from = at >= 0 ? at : tracks.indexOf(this.currentTrack() as MusicTrackNode)
    const base = from < 0 ? 0 : from
    const next = tracks[(((base + delta) % tracks.length) + tracks.length) % tracks.length]
    this.model.selectNode(next)
    await this.playTrack(next)
  }

  /**
   * Toggle a control the game drives with a port write.
   *
   * The engine cannot write a port once a snapshot is loaded, so this
   * rebuilds and reloads, which RESTARTS the track. The buttons say so;
   * pretending otherwise would be a control that silently half-works.
   */
  async toggleHurryUp(): Promise<void> {
    this.hurryUp = !this.hurryUp
    await this.reloadIfPlaying()
  }

  async toggleYoshiDrums(): Promise<void> {
    this.yoshiDrums = this.yoshiDrums === true ? false : true
    await this.reloadIfPlaying()
  }

  protected async reloadIfPlaying(): Promise<void> {
    if (this.playingTrack) await this.playTrack(this.playingTrack)
    else this.update()
  }

  protected startTicker(): void {
    if (this.ticker !== undefined) return
    this.ticker = window.setInterval(() => {
      if (spcPlayback.state === 'stopped') this.stopTicker()
      this.update()
    }, 500)
  }

  protected stopTicker(): void {
    if (this.ticker !== undefined) window.clearInterval(this.ticker)
    this.ticker = undefined
  }

  override dispose(): void {
    // The interval outlives the widget otherwise, calling update() on a
    // disposed React root once per half-second for the rest of the session.
    this.stopTicker()
    spcPlayback.stop()
    super.dispose()
  }

  /** Name the selected track, or clear its name with an empty answer. */
  async renameSelected(): Promise<void> {
    const node = this.model.selectedNodes[0] as MusicTrackNode | undefined
    if (!node || node.kind !== 'track' || !node.bank || !this.manifestPath) return

    const value = await this.quickInput.input({
      prompt: `Name for track ${node.bgmHex} (leave empty to clear)`,
      value: node.alias,
    })
    // Dismissed is not the same as cleared: an escaped prompt must not wipe
    // a name the user already gave.
    if (value === undefined) return

    await this.music.setTrackAlias(this.manifestPath, node.bank, node.bgmCommand, value)
    await this.load(this.manifestPath)
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  /** Double click renames a track. A single click only selects. */
  protected override handleDblClickEvent(
    node: TreeNode | undefined,
    event: React.MouseEvent<HTMLElement>,
  ): void {
    super.handleDblClickEvent(node, event)
    const n = node as MusicTrackNode | undefined
    if (n?.kind === 'sfx') {
      void this.playSfx(n)
      return
    }
    void this.renameSelected()
  }

  protected override renderIcon(node: TreeNode, _props: NodeProps): React.ReactNode {
    const n = node as MusicTrackNode
    if (n.kind === 'group') {
      return (
        <span
          className={`hb-music-icon codicon codicon-${n.id === 'group:sfx' ? 'radio-tower' : 'music'}`}
        />
      )
    }
    if (n.kind === 'track') return <span className="hb-music-icon codicon codicon-play-circle" />
    if (n.kind === 'sfx') {
      return (
        <span
          className={`hb-music-icon codicon codicon-${n.silent ? 'mute' : 'unmute'}`}
          title={n.silent ? 'Silent: this phrase is a bare end marker' : undefined}
        />
      )
    }
    return undefined
  }

  protected override renderCaption(node: TreeNode, props: NodeProps): React.ReactNode {
    const n = node as MusicTrackNode
    if (n.kind === 'message') return super.renderCaption(node, props)

    if (n.kind === 'sfx') {
      return [
        <span key="id" className="hb-music-command">
          {n.bgmHex}
        </span>,
        n.silent ? (
          // Real ROM behaviour, not a fault: port 0's $22 and $24 point at
          // a phrase that is only an end marker.
          <span key="silent" className="hb-music-note">
            silent
          </span>
        ) : null,
        this.playingTrack === n ? (
          <span key="p" className="codicon codicon-unmute hb-music-playing" title="Playing" />
        ) : null,
      ]
    }

    if (n.kind === 'group' || n.kind === 'bank' || n.kind === 'sfxport') {
      return [
        <span key="name" className="hb-music-groupname">
          {n.name}
        </span>,
        n.summary ? (
          <span key="sum" className="hb-music-note">
            {n.summary}
          </span>
        ) : null,
      ]
    }

    return [
      // The name span carries ONLY the user's name. The hex is rendered
      // once, below, so an unnamed track reads "$01" not "Track $01$01".
      n.alias ? (
        <span key="name" className="hb-music-name">
          {n.alias}
        </span>
      ) : null,
      <span key="cmd" className="hb-music-command">
        {n.bgmHex}
      </span>,
      n.maps.length > 0 ? (
        <span key="maps" className="hb-music-note">
          {n.maps.length} {n.maps.length === 1 ? 'map' : 'maps'}
        </span>
      ) : null,
      n.levelIndices.length > 0 ? (
        <span key="idx" className="hb-music-note">
          slot {n.levelIndices.map(hexIndex).join(', ')}
        </span>
      ) : null,
      n.sharedWith.length > 0 ? (
        // Two commands, one song. Without this they read as separate tracks
        // and replacing one looks like it changed the other by magic.
        <span key="shared" className="hb-music-shared" title="Same song as another command">
          = {n.sharedWith.map(hexByte).join(', ')}
        </span>
      ) : null,
      this.playingTrack === n ? (
        <span key="playing" className="codicon codicon-unmute hb-music-playing" title="Playing" />
      ) : null,
    ]
  }

  protected override render(): React.ReactNode {
    return (
      <div className="hb-music-body">
        <div className="hb-music-list">{super.render()}</div>
        {this.renderTransport()}
        {this.renderFooter()}
      </div>
    )
  }

  /**
   * The transport, in the panel rather than in a tab.
   *
   * Hidden when there is nothing playable, rather than shown dead: a row of
   * buttons that cannot work is a worse answer than none, and the footer
   * already says why.
   */
  protected renderTransport(): React.ReactNode {
    // Sound effects count: a ROM whose music banks all refuse can still
    // have a readable engine, and the transport has to be there for them.
    const playable =
      this.trackNodes().some(t => t.bank && !this.refusals.has(t.bank)) ||
      this.sfxNodes().length > 0
    if (!playable) return null

    const playing = spcPlayback.state === 'playing'
    const elapsed = spcPlayback.elapsed()
    const mins = Math.floor(elapsed / 60)
    const secs = Math.floor(elapsed % 60)

    return (
      <div className="hb-music-transport" data-transport="true">
        <div className="hb-music-buttons">
          <button
            className="hb-music-btn"
            data-action="prev"
            title="Previous track"
            onClick={() => void this.step(-1)}
          >
            <span className="codicon codicon-chevron-left" />
          </button>
          <button
            className="hb-music-btn"
            data-action="play"
            data-state={spcPlayback.state}
            title={playing ? 'Pause' : 'Play'}
            onClick={() => void this.togglePlay()}
          >
            <span className={`codicon codicon-${playing ? 'debug-pause' : 'play'}`} />
          </button>
          <button
            className="hb-music-btn"
            data-action="stop"
            title="Stop"
            onClick={() => this.stopPlayback()}
          >
            <span className="codicon codicon-primitive-square" />
          </button>
          <button
            className="hb-music-btn"
            data-action="next"
            title="Next track"
            onClick={() => void this.step(1)}
          >
            <span className="codicon codicon-chevron-right" />
          </button>

          <span className="hb-music-elapsed" data-elapsed="true">
            {mins}:{String(secs).padStart(2, '0')}
          </span>

          <span className="codicon codicon-unmute hb-music-volicon" />
          <input
            className="hb-music-volume"
            data-volume="true"
            type="range"
            min="0"
            max="1.5"
            step="0.01"
            defaultValue={String(spcPlayback.getVolume())}
            title="Volume"
            onChange={e => spcPlayback.setVolume(Number(e.target.value))}
          />
        </div>

        <div className="hb-music-toggles">
          {/*
            Both are single port writes in the game, but the engine cannot
            write a port once a snapshot is loaded, so toggling one rebuilds
            and reloads and the track restarts. The titles say so. See
            docs/music-playback.md.
          */}
          <button
            className={`hb-music-toggle${this.hurryUp ? ' hb-music-toggle-on' : ''}`}
            data-toggle="hurry-up"
            aria-pressed={this.hurryUp}
            title="Hurry up: what the game plays at 099 seconds. Restarts the track."
            onClick={() => void this.toggleHurryUp()}
          >
            Hurry up
          </button>
          <button
            className={`hb-music-toggle${this.yoshiDrums ? ' hb-music-toggle-on' : ''}`}
            data-toggle="yoshi-drums"
            aria-pressed={this.yoshiDrums === true}
            title="Yoshi's drums, as when riding him. Restarts the track."
            onClick={() => void this.toggleYoshiDrums()}
          >
            Yoshi drums
          </button>
        </div>

        {this.playbackError ? (
          <div className="hb-music-note hb-music-playback-error" data-playback-error="true">
            {this.playbackError}
          </div>
        ) : null}
      </div>
    )
  }

  protected renderFooter(): React.ReactNode {
    const selected = this.model.selectedNodes[0] as MusicTrackNode | undefined

    if (this.sfxRefusal && (selected?.kind === 'sfx' || selected?.id === 'group:sfx')) {
      return (
        <div className="hb-music-footer hb-music-refusal" data-refusal="true">
          <span className="codicon codicon-warning" /> {this.sfxRefusal}
        </div>
      )
    }

    const bank = selected?.bank

    if (bank && this.refusals.has(bank)) {
      return (
        <div className="hb-music-footer hb-music-refusal" data-refusal="true">
          <span className="codicon codicon-warning" /> {this.refusals.get(bank)}
        </div>
      )
    }
    const cite = bank ? this.provenance.get(bank) : undefined
    if (!cite) return null
    return (
      <div className="hb-music-footer" data-provenance="true">
        <span className="hb-music-command">{cite}</span>
        <span className="hb-music-note">{bank}</span>
      </div>
    )
  }
}

export function createMusicExplorerWidget(parent: interfaces.Container): MusicExplorerWidget {
  const child: Container = createTreeContainer(parent, {
    widget: MusicExplorerWidget,
    props: {
      // A row click selects; only the chevron expands. Same as the map
      // explorer, which established the rule after a folder could not be
      // opened without collapsing it.
      expandOnlyOnExpansionToggleClick: true,
      globalSelection: true,
    },
  })
  return child.get(MusicExplorerWidget)
}
