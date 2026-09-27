/**
 * The Overworld service: the overworld's L1 (foreground) drawn as one map.
 * Same shape as gfx-protocol.ts: the backend decodes, the frontend paints.
 */
export const OVERWORLD_SERVICE_PATH = '/services/hackbench-overworld'

export const OverworldService = Symbol('OverworldService')

/**
 * The drawn L1, or why it cannot be drawn. A refusal carries no pixels: the
 * view shows the reason and no canvas (CLAUDE.md, fail closed).
 */
export type OverworldL1Dto =
  | {
      status: 'ok'
      width: number
      height: number
      /** RGBA8888 pixels, row-major, base64-encoded. */
      rgbaBase64: string
      objectTileset: number
    }
  | { status: 'unavailable'; reason: string }

export interface OverworldServiceClient {
  onWorkingCopyChanged(manifestPath: string): void
}

export interface OverworldService {
  setClient(client: OverworldServiceClient | undefined): void
  /** Throws when the project's ROM is not on this machine, like gfxSheet. */
  overworldL1(manifestPath: string): Promise<OverworldL1Dto>
}
