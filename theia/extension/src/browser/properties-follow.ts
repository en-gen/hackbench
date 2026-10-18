/**
 * Keeps the frame preview on whatever the Properties model holds (#984). Plain TS, so the widget/model
 * handshake is unit tested without Theia: the model publishes BEFORE the reveal command creates the widget
 * (a click publishes, then opens the panel), so a widget that only listened for later changes would never see
 * the sprite that caused it to open. Following therefore starts with the current subject, then each change.
 */
import type { PropertiesModel } from './properties-model'
import type { FramePlayer } from './sprite-frames'

export function followSubject(
  model: Pick<PropertiesModel, 'subject' | 'onChange'>,
  player: Pick<FramePlayer, 'select'>,
  repaint: () => void,
): { dispose(): void } {
  // Only a new sprite or map (not a re-publish of the same one) restarts the loop.
  let shown: unknown
  let shownSource: string | undefined
  const apply = (s: PropertiesModel['subject']): void => {
    const sprite = s.kind === 'sprite' ? s.sprite : undefined
    // The same sprite index on another map is a different sprite: the map is part of what is shown.
    const source =
      s.kind === 'sprite' && s.source ? `${s.source.manifestPath}:${s.source.index}` : undefined
    if (sprite !== shown || source !== shownSource) {
      shown = sprite
      shownSource = source
      player.select(s.kind === 'sprite' && s.source ? { ...s.source, spriteIndex: s.sprite.index } : undefined) // prettier-ignore
    }
    repaint()
  }
  const sub = model.onChange(apply)
  apply(model.subject)
  return sub
}
