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
 * reason: a cartridge not on this machine is an ordinary first-run state, not
 * an error.
 */
export type EmulatorRomResult =
  | { status: 'ok'; romBytes: Uint8Array }
  | { status: 'rom-not-located'; baseRom: EmulatorRomIdentityDto }

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

  /** The registered core's bytes, ready to instantiate. */
  coreFiles(): Promise<CoreFilesResult>

  /** The project's base cartridge, resolved through the ROM registry. */
  romForEmulator(manifestPath: string): Promise<EmulatorRomResult>
}
