import type { OverworldAreasDto } from '../common/gfx-protocol'

/** One child row under the Overworld row. `invalid` is the reason the camera table cannot place it. */
export interface AreaRow {
  area: number
  /** UI name: layer and tile numbers stay out of it. */
  name: string
  invalid?: string
}

/**
 * What the Overworld row and its children show, from the backend's area list. A refused derivation
 * (or a failed call, `dto` undefined with `error`) gives no children and a reason for the
 * Overworld row's tooltip; the hub still draws.
 */
export function overworldRows(
  dto: OverworldAreasDto | undefined,
  error?: string,
): { areas: AreaRow[]; note?: string } {
  if (dto?.status === 'ok') {
    return {
      areas: dto.areas.map(a => ({
        area: a.area,
        name: `Area ${a.area}`,
        ...(a.invalid ? { invalid: a.invalid } : {}),
      })),
    }
  }
  return { areas: [], note: `Areas unavailable: ${dto?.reason ?? error ?? 'not loaded'}` }
}

/** An invalid area opens nothing: there is no window to draw. */
export const opensArea = (row: AreaRow): boolean => !row.invalid
