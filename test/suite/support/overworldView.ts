/** An Overworld DTO as the browser paints it (OverworldComposite), shared by the view tests. */
import { compositeOverworld } from '../../../src/rom/render/OverworldComposite'
import type { OverworldDto } from '../../../theia/extension/src/common/gfx-protocol'

export const b64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'))

export function composeDto(dto: OverworldDto, show = { l1: true, l2: true }): Buffer {
  if (dto.status !== 'ok') throw new Error(dto.reason)
  const layer = (l: { rgbaBase64: string; prioBase64: string } | undefined) =>
    l
      ? {
          rgba: new Uint8ClampedArray(b64(l.rgbaBase64)),
          prio: b64(l.prioBase64),
          prioCell: dto.prioCell,
        }
      : null
  return Buffer.from(
    compositeOverworld(
      dto.width,
      dto.height,
      dto.backdrop,
      show.l2 ? layer(dto.l2) : null,
      show.l1 ? layer(dto.l1) : null,
    ),
  )
}
