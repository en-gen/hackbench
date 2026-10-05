/**
 * The project service, as seen from both sides.
 *
 * Creating a project writes to disk, and a Theia frontend cannot. So this is a
 * backend service the frontend calls over JSON-RPC, and this file is the
 * contract both ends compile against.
 */
import type { Map16SwitchButtonImages, Map16SwitchKind } from './map16-protocol'

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

/** Where this machine keeps the ROM and the emulator core. Null: not located / not set up. */
export interface WorkstationPathsDto {
  romPath: string | null
  corePath: string | null
}

/** `mismatch` carries both full hashes; the dialog shortens them. */
export type RomCheckDto =
  { status: 'ok' } | { status: 'mismatch'; picked: string; expected: string }

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
   * them. Either may be absent when the code that loads it has been replaced.
   */
  special: SpecialMapNodeDto[]
  overworld: MapNodeDto[]
  unassigned: MapNodeDto[]
  mapCount: number
  counts: MapTreeCountsDto
  notes: string[]
}

/** A user-named group and the slots it holds. Order is not meaningful. */
export interface MapGroupDto {
  name: string
  slots: number[]
}

/**
 * A map at the top of a group, or of the single Unassigned folder. `orphan`
 * carries the reachability marking regardless of which folder holds it.
 */
export interface GroupedMapNodeDto extends MapNodeDto {
  orphan: boolean
  /** Set on a map entered after a level (Bonus Games, Yoshi Heaven): reached, but not an entry map. */
  role?: 'bonus-game' | 'yoshi-heaven'
}

/**
 * The explorer's tree once meta/groups.json has pulled some top-level maps
 * out of the top level into their groups. There is no separate Overworld
 * folder: every top-level map not in a user group, entry map or orphan
 * alike, is Unassigned.
 */
export interface GroupedMapTreeDto {
  special: SpecialMapNodeDto[]
  unassigned: GroupedMapNodeDto[]
  mapCount: number
  counts: MapTreeCountsDto
  notes: string[]
  groups: { name: string; maps: GroupedMapNodeDto[] }[]
}

/**
 * Why loading maps is a result rather than a throw.
 *
 * A project names its cartridge by hash and never by path, so "we have no
 * idea where your ROM is" is an ordinary first-run state that the UI answers
 * by asking the user to locate it. Modelling it as an error would leave the
 * frontend matching on message strings across JSON-RPC to tell it apart from
 * a genuine failure.
 *
 * `rawGroups` is the file's own list (not rebuilt from the resolved tree), so
 * the frontend can edit and send it back without losing a slot the current
 * ROM no longer resolves. `groupsError` is set when meta/groups.json exists
 * but fails validation; `tree` is still the full, ungrouped map list, and
 * `rawGroups` is empty.
 */
export type LoadMapsResult =
  | {
      status: 'ok'
      tree: GroupedMapTreeDto
      rawGroups: MapGroupDto[]
      romPath: string
      groupsError?: string
    }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }

/** Result of writing meta/groups.json. The caller reloads to see the effect. */
export type SetMapGroupsResult =
  | { status: 'ok' }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }
  | { status: 'invalid'; reason: string }

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
  /** Why `name` is null when the translevel mapping itself is unreadable,
   *  rather than the slot simply having no name. */
  nameUnavailable?: string
  /** Why the slot's level data could not be read. When set, every field
   *  below it is absent, and nothing past the name is claimed. */
  levelDataUnavailable?: string
  /** The five header bytes, so the user can check the decode themselves. */
  headerBytes?: number[]
  screens?: number
  /** Absent when the object walk did not end on $FF; see `objectsUnavailable`. */
  objectCount?: number
  /** Why `objectCount` is absent when level data was read. */
  objectsUnavailable?: string
  /** Absent when VerticalTable could not be read; see `orientationUnavailable`. */
  isVertical?: boolean
  /** Why `isVertical` is absent. Set only when it is. */
  orientationUnavailable?: string
  /** Absent when the sprite stream could not be read; see `spriteUnavailable`. */
  spriteCount?: number
  /** Why `spriteCount` is absent. Set only when it is. */
  spriteUnavailable?: string
  /** Decoded header fields, label and value, in header-byte order. */
  header?: Array<{ label: string; value: string }>
  /** Why the GFX files the tileset and sprite set name may not be what loads. */
  gfxAssignmentNote?: string
}

/**
 * Which switch palaces a map is drawn as pressed, in the ROM's own
 * SwitchBlockFlags terms (bank_0D.asm:3739-3747, :4226-4232). A pressed
 * palace draws its blocks solid. Per map tab, never global.
 */
export interface SwitchFlagsDto {
  green: boolean
  yellow: boolean
  blue: boolean
  red: boolean
}

/**
 * The map's planes, bottom to top (the view's z-order): BG mode 1 stacks
 * BG1 high > BG2 high > BG1 low > BG2 low, each layer split by its subtiles'
 * priority bit (#459). L1 is BG1 (foreground), L2 BG2 (background).
 */
export const MAP_PLANE_KEYS = ['l2Low', 'l1Low', 'l2High', 'l1High'] as const
export type MapPlaneKey = (typeof MAP_PLANE_KEYS)[number]

/**
 * One screen of a map's L1 (foreground), drawn by the backend from the
 * working copy. Horizontal maps have 16 x 27 tile screens; vertical maps
 * 32 x 16 (two 16-wide halves). The back-area color shows where L1 draws nothing.
 * `screenCount` and `orientation` let the tab size itself from any screen.
 */
export type MapScreenResult =
  | {
      status: 'ok'
      screen: number
      screenCount: number
      orientation: 'horizontal' | 'vertical'
      /** Pixels. */
      width: number
      height: number
      /** Base64 RGBA per plane; null where nothing draws, with no image sent. */
      planes: Record<MapPlaneKey, string | null>
      /** Why the animated tiles are drawn from unverified or no frames, when they are. */
      note?: string
      /** Caveats on the layers: a background that is not drawn, a layer order that is unverified. */
      layerNotes: string[]
      /** The back area (CGRAM color 0), RGB: its own layer under L1. */
      backdrop: [number, number, number]
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }

/**
 * Which char switches a map is drawn with (#573): the blue and silver
 * P-switches and ON/OFF swap the chars they animate, not the grid. Per tab.
 */
export type SwitchStateDto = Record<Map16SwitchKind, boolean>

/** One palace's switch block as 16x16 RGBA, both states, or why it cannot be drawn. */
export type PalaceIconDto = { palace: keyof SwitchFlagsDto } & (
  { uncleared: string; cleared: string } | { unavailable: string }
)

/** The map toolbar's art: each palace's block (per ROM) and each char switch's own (#574's). */
export type PalaceIconsResult =
  | {
      status: 'ok'
      icons: PalaceIconDto[]
      switchArt: Partial<Record<Map16SwitchKind, Map16SwitchButtonImages>>
      /** Why a switch has no art. */
      switchUnavailable: Partial<Record<Map16SwitchKind, string>>
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }

/** 'bps' is the default: SMW Central's Hacks section no longer accepts IPS. */
export type PatchFormatDto = 'bps' | 'ips'

/**
 * Result of exporting the working copy as a patch file.
 *
 * `hasCopierHeader` matters only for IPS: which base variant the patch's
 * offsets are relative to. BPS always targets the unheadered ROM.
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
  /**
   * The project's base ROM was swapped (relocated, or its working copy was
   * rebuilt): every view reading it must rebuild from scratch, unlike the
   * per-edit notice above, which keeps selection and expansion.
   */
  onRomChanged(manifestPath: string): void
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

  /** The registered ROM and core paths, for Project Properties' Local workstation section. */
  workstationPaths(manifestPath: string): Promise<WorkstationPathsDto>

  /** Hash a candidate ROM against the project's base ROM. Registers nothing. */
  checkRom(manifestPath: string, romPath: string): Promise<RomCheckDto>

  /** Re-check, then register the ROM's new path. A different ROM is refused. */
  relocateRom(manifestPath: string, romPath: string): Promise<RomCheckDto>

  /**
   * Change what the hack says about itself.
   *
   * Metadata only. The base ROM identity and the creation date are facts
   * about the project rather than opinions, and are not editable.
   */
  updateProject(manifestPath: string, changes: Partial<HackMetadataDto>): Promise<ProjectDto>

  /**
   * Read one map out of the project's working copy.
   *
   * Throws when the slot holds no readable level data, which is a real answer
   * rather than an empty map: an empty map looks like one that lost its work.
   */
  mapDetails(manifestPath: string, index: number): Promise<MapDetailsDto>

  /** Draw one screen of a map's L1 (foreground) from the working copy. */
  mapScreen(
    manifestPath: string,
    index: number,
    screen: number,
    switchFlags: SwitchFlagsDto,
    switches: SwitchStateDto,
  ): Promise<MapScreenResult>

  /** The map toolbar's art: the palace blocks and the char switches' buttons. */
  mapPalaceIcons(manifestPath: string, index: number): Promise<PalaceIconsResult>

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
   * Every map in the project's working copy, grouped for display.
   *
   * Resolves the ROM through the registry; reports `rom-not-located` rather
   * than failing when this machine has not been told where it is.
   */
  loadMaps(manifestPath: string): Promise<LoadMapsResult>

  /**
   * Replace meta/groups.json wholesale and return the regrouped tree.
   *
   * Validated before writing (unique non-empty names, in-range slots, no
   * slot in two groups); `invalid` reports the refusal and leaves the file
   * untouched.
   */
  setMapGroups(manifestPath: string, groups: MapGroupDto[]): Promise<SetMapGroupsResult>

  /**
   * Diff the working copy against the base cartridge and write a patch into
   * `<project>/export/`, BPS by default or IPS. Includes every persisted
   * edit layer; a live preview layer (mid-drag) is never part of an export.
   */
  exportPatch(manifestPath: string, format?: PatchFormatDto): Promise<ExportPatchResult>

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
