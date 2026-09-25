/**
 * The project service, as seen from both sides.
 *
 * Creating a project writes to disk, and a Theia frontend cannot. So this is a
 * backend service the frontend calls over JSON-RPC, and this file is the
 * contract both ends compile against.
 */

/** Where the frontend reaches the backend. Must match the backend binding. */
export const PROJECT_SERVICE_PATH = '/services/hackbench-project'

export const ProjectService = Symbol('ProjectService')

/** Identity of the cartridge a project is built against. Never a path. */
export interface RomIdentityDto {
  sha256: string
  size: number
  title: string
}

/**
 * What the hack IS, as opposed to what HackBench needs to open it.
 *
 * `title` is separate from `name` because `name` is the manifest's filename
 * stem and so is constrained by the filesystem; a hack title is not. `version`
 * is the author's, and has nothing to do with schemaVersion.
 */
export interface HackMetadataDto {
  title: string
  summary: string
  authors: string[]
  version: string
}

export interface ProjectDto extends HackMetadataDto {
  manifestPath: string
  directory: string
  name: string
  baseRom: RomIdentityDto
}

/** Metadata is optional at creation: an author need not have a summary yet. */
export interface CreateProjectRequest extends Partial<HackMetadataDto> {
  romPath: string
  name: string
  directory: string
}

/**
 * One map in the explorer tree. Mirrors src/rom/MapTree.MapNode; declared
 * again here because this file is the wire contract and must not drag the ROM
 * layer into the frontend bundle.
 */
export interface MapNodeDto {
  index: number
  name: string | null
  kind: 'map' | 'loop' | 'truncated'
  children: MapNodeDto[]
}

/** A map the game enters without the overworld, named by what it is for. */
export interface SpecialMapNodeDto extends MapNodeDto {
  role: 'title-screen' | 'new-game'
  /** The SNES address the slot was read from, for a citation the user can check. */
  foundAt: string
}

/** `entrances` is null when the overworld is unreadable: unknown, not zero. */
export interface MapTreeCountsDto {
  entrances: number | null
  unassigned: number
}

export interface MapTreeDto {
  /**
   * The title screen and the new-game intro, in the order a player meets
   * them. Either may be absent when its loader has been replaced.
   */
  special: SpecialMapNodeDto[]
  overworld: MapNodeDto[]
  unassigned: MapNodeDto[]
  mapCount: number
  counts: MapTreeCountsDto
  notes: string[]
}

/**
 * Why loading maps is a result rather than a throw.
 *
 * A project names its cartridge by hash and never by path, so "we have no
 * idea where your ROM is" is an ordinary first-run state that the UI answers
 * by asking the user to locate it. Modelling it as an error would leave the
 * frontend matching on message strings across JSON-RPC to tell it apart from
 * a genuine failure.
 */
export type LoadMapsResult =
  | { status: 'ok'; tree: MapTreeDto; romPath: string }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }

/** An entry in the recent-projects list. Per-machine, never in a project. */
export interface RecentProjectDto {
  manifestPath: string
  name: string
  title: string
  lastOpened: string
}

/**
 * What one map holds, read from the cartridge.
 *
 * Every field is decoded from the level header, whose bit layout and ASM
 * citations live in src/rom/LevelParser.ts. Nothing here is inferred: a field
 * this build cannot read is absent rather than defaulted.
 */
export interface MapDetailsDto {
  index: number
  name: string | null
  /** The five header bytes, so the user can check the decode themselves. */
  headerBytes: number[]
  screens: number
  objectCount: number
  /** Absent when VerticalTable could not be read; see `orientationUnavailable`. */
  isVertical?: boolean
  /** Why `isVertical` is absent. Set only when it is. */
  orientationUnavailable?: string
  /** Absent when the sprite stream could not be read; see `spriteUnavailable`. */
  spriteCount?: number
  /** Why `spriteCount` is absent. Set only when it is. */
  spriteUnavailable?: string
  /** Decoded header fields, label and value, in header-byte order. */
  header: Array<{ label: string; value: string }>
}

/**
 * Result of exporting the working copy as an .ips patch.
 *
 * `hasCopierHeader` describes the BASE cartridge the patch's offsets are
 * relative to: an .ips generated against a headered dump will not line up
 * against a headerless one of the same game, so the user needs to know
 * which variant to apply it to.
 */
export type ExportPatchResult =
  | { status: 'ok'; path: string; hasCopierHeader: boolean; opCount: number }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }
  | { status: 'unreadable'; reason: string }

/**
 * What undo and redo can do for the open project right now.
 *
 * Mirrors src/project/WorkingRomRegistry.EditStackState; declared again here
 * because this file is the wire contract and must not drag the project layer
 * into the frontend bundle.
 *
 * The labels are the layers' own, so a caller can name the edit that is about
 * to move rather than offering a bare "Undo".
 */
export interface EditStackDto {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

/**
 * Result of reading or moving the edit stack.
 *
 * `stale` is the redo refusal: a persisted `ops/redo/` entry whose address no
 * longer holds the value it recorded (hand-edited, or belonging to a different
 * base cartridge). Nothing is written, and the layer stays redoable.
 *
 * `io-error` is the write-back failing after the in-memory move already
 * succeeded; the working copy is rolled back to match, same as `setColor`.
 *
 * Running out of layers is NOT an error: it comes back `ok` with `canUndo` or
 * `canRedo` false. A user pressing Ctrl+Z on an untouched project has not done
 * anything that deserves a message.
 */
export type EditStackResult =
  | ({ status: 'ok' } & EditStackDto)
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }
  | { status: 'unreadable'; reason: string }
  | { status: 'stale'; reason: string }
  | { status: 'io-error'; reason: string }

/**
 * Pushed to the frontend when a project's working copy changes, so the Edit
 * menu's enablement reflects an edit made in any view. No payload beyond which
 * project: a subscriber re-fetches, same reasoning as PaletteServiceClient.
 */
export interface ProjectServiceClient {
  onWorkingCopyChanged(manifestPath: string): void
}

export interface ProjectService {
  /** Registers the frontend's push target. Theia calls this once per connection. */
  setClient(client: ProjectServiceClient | undefined): void

  /**
   * Create a project against a base ROM.
   *
   * The ROM is read to identify it and is never copied or modified. Rejects
   * rather than merging if the target directory already has contents.
   */
  createProject(req: CreateProjectRequest): Promise<ProjectDto>

  /** Read a project back from its `.hbproj` manifest. */
  openProject(manifestPath: string): Promise<ProjectDto>

  /** Identify a cartridge without creating anything, for validating a pick. */
  identifyRom(romPath: string): Promise<RomIdentityDto>

  /**
   * Remember where a cartridge lives on this machine, so projects naming it
   * by hash can find it later. Per-user, never written into a project.
   */
  registerRom(romPath: string): Promise<RomIdentityDto>

  /**
   * Change what the hack says about itself.
   *
   * Metadata only. The base ROM identity and the creation date are facts
   * about the project rather than opinions, and are not editable.
   */
  updateProject(manifestPath: string, changes: Partial<HackMetadataDto>): Promise<ProjectDto>

  /**
   * Read one map out of the project's base cartridge.
   *
   * Throws when the slot holds no readable level data, which is a real answer
   * rather than an empty map: an empty map looks like one that lost its work.
   */
  mapDetails(manifestPath: string, index: number): Promise<MapDetailsDto>

  /**
   * Projects this user has opened, most recent first.
   *
   * Entries whose manifest has gone are pruned rather than offered: a recent
   * list that fails when clicked reads as data loss.
   */
  recentProjects(): Promise<RecentProjectDto[]>

  /** Forget every remembered project. Affects this machine only. */
  clearRecentProjects(): Promise<void>

  /**
   * Every map in the project's base cartridge, grouped for display.
   *
   * Resolves the ROM through the registry; reports `rom-not-located` rather
   * than failing when this machine has not been told where it is.
   */
  loadMaps(manifestPath: string): Promise<LoadMapsResult>

  /**
   * Diff the working copy against the base cartridge and write an .ips into
   * `<project>/export/`. Includes every persisted edit layer; a live preview
   * layer (mid-drag) is never part of an export.
   */
  exportPatch(manifestPath: string): Promise<ExportPatchResult>

  /**
   * What undo/redo can do for this project right now, without moving
   * anything. The Edit menu's enablement is synchronous, so the frontend
   * caches this and refreshes it on the working-copy push.
   */
  editStack(manifestPath: string): Promise<EditStackResult>

  /**
   * Undo: take the top edit layer off the stack.
   *
   * The layer is KEPT, in `ops/redo/`, so the redo survives the project being
   * closed. Returns the stack's state afterwards.
   */
  undo(manifestPath: string): Promise<EditStackResult>

  /** Redo: put the most recently undone layer back. */
  redo(manifestPath: string): Promise<EditStackResult>
}
