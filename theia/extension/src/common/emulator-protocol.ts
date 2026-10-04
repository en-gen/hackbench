/**
 * The emulator service, as seen from both sides.
 *
 * Own file, own RPC path, deliberately separate from project-protocol.ts: the
 * frontend cannot read the filesystem, so both the ROM and the user's chosen
 * core have to cross this same JSON-RPC boundary as bytes.
 */

/** Where the frontend reaches the backend. Must match the backend binding. */
export const EMULATOR_SERVICE_PATH = '/services/hackbench-emulator'

export const EmulatorService = Symbol('EmulatorService')

/** What the registered core IS, never where it lives on disk. */
export interface CoreIdentityDto {
  label: string
}

/**
 * Picking a core is a result, not just a throw, so the widget can show WHY a
 * file was refused (missing sibling .wasm, missing entry points) rather than
 * a bare failure.
 */
export type LocateCoreResult =
  { status: 'ok'; core: CoreIdentityDto } | { status: 'invalid'; message: string }

/** The Emscripten glue and WASM binary for the registered core, as bytes. */
export interface CoreFilesDto {
  js: string
  wasm: Uint8Array
}

export type CoreFilesResult = { status: 'ok'; files: CoreFilesDto } | { status: 'no-core' }

/**
 * Named separately from RomIdentityDto (project-protocol.ts) rather than
 * imported: this file and project-protocol.ts are edited by different
 * concurrent agents on this codebase, and importing one from the other would
 * make an unrelated change to either a source of merge conflicts and a
 * coupling neither file's owner asked for.
 */
export interface EmulatorRomIdentityDto {
  title: string
}

/**
 * Same shape as ProjectService.loadMaps's LoadMapsResult, and for the same
 * reason: a ROM not on this machine is an ordinary first-run state, not
 * an error. `digest` identifies these exact bytes, so the frontend can tell
 * whether the working copy has moved on since a core booted from them.
 */
export type EmulatorRomResult =
  | { status: 'ok'; romBytes: Uint8Array; digest: string }
  | { status: 'rom-not-located'; baseRom: EmulatorRomIdentityDto }

/** One save slot: `saves/<ROM title>.<slot>.srm`, and its label if it has one. */
export interface SaveSlotDto {
  slot: number
  label?: string
}

export interface EmulatorService {
  /** The core currently registered on this machine, if any. */
  registeredCore(): Promise<CoreIdentityDto | undefined>

  /** Forget the registered core. Affects this machine only. */
  forgetCore(): Promise<void>

  /**
   * Validate and remember a core the user picked via the platform file dialog.
   * Replaces whatever was registered before.
   */
  locateCore(jsPath: string): Promise<LocateCoreResult>

  /** The validation `locateCore` runs, without remembering the core. */
  checkCore(jsPath: string): Promise<LocateCoreResult>

  /** The registered core's bytes, ready to instantiate. */
  coreFiles(): Promise<CoreFilesResult>

  /** The project's working copy, every edit layer applied. */
  romForEmulator(manifestPath: string): Promise<EmulatorRomResult>

  /**
   * romForEmulator's digest without shipping the bytes: cheap enough to ask
   * on every edit. Undefined when the ROM is not on this machine.
   */
  romDigest(manifestPath: string): Promise<string | undefined>

  /** The project's save slots, lowest number first. */
  listSaves(manifestPath: string): Promise<SaveSlotDto[]>

  /** One slot's save game (SRAM), if that slot has one yet. */
  loadSave(manifestPath: string, slot: number): Promise<Uint8Array | undefined>

  /** Replace one slot's save game. Rejects anything but a real project. */
  storeSave(manifestPath: string, slot: number, bytes: Uint8Array): Promise<void>

  deleteSave(manifestPath: string, slot: number): Promise<void>

  /**
   * Copy a slot into the next free number, skipping `reserved` (slots chosen
   * or running but not yet written, which have no file); returns it.
   */
  duplicateSave(manifestPath: string, slot: number, reserved?: number[]): Promise<number>

  /** Set a slot's label; an empty one clears it. */
  labelSave(manifestPath: string, slot: number, label: string): Promise<void>

  /**
   * Other .srm files in saves/ (e.g. from another emulator, named after the
   * ROM file), which the user can import. Never renamed unasked.
   */
  listForeignSaves(manifestPath: string): Promise<string[]>

  /** Move a foreign save into the next free slot, skipping `reserved`; returns it. */
  importSave(manifestPath: string, file: string, reserved?: number[]): Promise<number>

  /** The lowest slot number with no save in it and not `reserved`, for "New save". */
  nextFreeSlot(manifestPath: string, reserved?: number[]): Promise<number>
}
