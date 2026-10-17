/**
 * What the Properties view is showing (#984). A SUBJECT, so the view takes more kinds without rework: the
 * map description (#1023) is another `kind` here plus a renderer registered in properties-widget.tsx
 * (`registerSubjectRenderer`). Not Theia's @theia/property-view: it is not a dependency (adding it churns the lockfile), and a
 * selection-service round trip would lose the owner rule below.
 *
 * Several map tabs share one view. Each publishes as its own `owner`; only the owner's clear takes effect,
 * so closing or hiding a background map never wipes the sprite of the map in front (same rule as the
 * status bar entry, SpriteStatusOwner).
 */
import type { MapSpriteDto } from '../common/project-protocol'
import type { FrameSource } from './sprite-frames'

/** `source` is where the sprite's frames can be asked for; absent, the panel shows the one pose. */
export type PropertiesSubject =
  | { kind: 'none' }
  | { kind: 'sprite'; sprite: MapSpriteDto; source?: Omit<FrameSource, 'spriteIndex'> }

const NONE: PropertiesSubject = { kind: 'none' }

export class PropertiesModel {
  private current: PropertiesSubject = NONE
  private owner: object | undefined
  private readonly listeners = new Set<(s: PropertiesSubject) => void>()

  get subject(): PropertiesSubject {
    return this.current
  }

  onChange(fn: (s: PropertiesSubject) => void): { dispose(): void } {
    this.listeners.add(fn)
    return { dispose: () => this.listeners.delete(fn) }
  }

  /** `owner` becomes the owner, even with nothing to show. */
  publish(owner: object, subject: PropertiesSubject): void {
    this.owner = owner
    this.set(subject)
  }

  clear(owner: object): void {
    if (this.owner !== owner) return
    this.owner = undefined
    this.set(NONE)
  }

  private set(subject: PropertiesSubject): void {
    this.current = subject
    for (const l of [...this.listeners]) l(subject)
  }
}
