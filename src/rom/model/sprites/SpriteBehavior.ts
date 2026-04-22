export interface SpriteBehavior {
  readonly kind: string
  readonly displayName?: string
  readonly spawns?: number
  readonly isGenerator?: boolean
}
