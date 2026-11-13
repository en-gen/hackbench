/**
 * The Objects service, as seen from both sides: the saved Object definitions
 * of docs/architecture/object-definitions.md.
 *
 * Shapes are declared fresh rather than imported from src/project/, for the
 * reason map16-protocol.ts gives: the core would drag `fs` into the frontend
 * bundle. The tileset sheet is NOT served here; the activity loads it with
 * Map16Service.loadMap16, so there is no second decode.
 */
import { RomIdentityDto } from './project-protocol'

export const OBJECTS_SERVICE_PATH = '/services/hackbench-objects'

export const ObjectsService = Symbol('ObjectsService')

export interface ObjectDefinitionDto {
  version: 1
  id: string
  name: string
  /** The level header's foreground tileset. */
  tileset: number
  /** Sorted Map16 tile numbers. */
  edge: number[]
  /** Sorted Map16 tile numbers, never in `edge`. */
  fill: number[]
}

/** A file in meta/objects/ that was not loaded, with why, in plain words. */
export interface SkippedObjectDto {
  file: string
  reason: string
}

export interface ObjectDraftDto {
  /** Absent on a first save. */
  id?: string
  name: string
  tileset: number
  edge: number[]
  fill: number[]
}

export type ListObjectsResult =
  | { status: 'ok'; definitions: ObjectDefinitionDto[]; skipped: SkippedObjectDto[] }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }

/** `invalid` and `not-found` carry a reason the activity shows as is. */
export type ObjectWriteResultDto =
  | { status: 'ok'; definition: ObjectDefinitionDto }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }
  | { status: 'invalid'; reason: string }
  | { status: 'not-found'; reason: string }
  | { status: 'io-error'; reason: string }

export type DeleteObjectResultDto =
  | { status: 'ok' }
  | { status: 'rom-not-located'; baseRom: RomIdentityDto }
  | { status: 'invalid'; reason: string }
  | { status: 'not-found'; reason: string }
  | { status: 'io-error'; reason: string }

/**
 * Definitions live in the project's meta/ and never reach the ROM, the
 * working copy or ops/. The ROM is read only to learn how many tilesets and
 * tiles it has, which the definitions are checked against.
 */
export interface ObjectsService {
  listObjects(manifestPath: string): Promise<ListObjectsResult>
  saveObject(manifestPath: string, draft: ObjectDraftDto): Promise<ObjectWriteResultDto>
  renameObject(manifestPath: string, id: string, name: string): Promise<ObjectWriteResultDto>
  deleteObject(manifestPath: string, id: string): Promise<DeleteObjectResultDto>
}
