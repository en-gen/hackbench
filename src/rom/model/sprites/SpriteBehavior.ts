import type { LineGuideAttachment } from '../../LineGuide'

export interface SpriteBehavior {
  readonly kind: string
  readonly displayName?: string
  readonly spawns?: number
  readonly isGenerator?: boolean
  /**
   * Vertical reach in pixels from the top of the sprite's body through the
   * bottom of where it can interact — e.g. a Thwomp's fall path down to the
   * first solid row. Null/absent for sprites without a directional reach.
   * Cursor-aware appearances gate their Y reactivity by this value so they
   * stay idle when the cursor is outside the sprite's effective range.
   */
  readonly reactRangeDy?: number
  /**
   * Line-guide attachment resolved at level load for sprite IDs $62-$68
   * (see src/rom/LineGuide.ts). Null when the sprite's spawn position does
   * not probe a line-guide Map16 tile. The inspector surfaces the direction
   * toggle and the editor overlay highlights the attached track cell.
   */
  readonly lineGuide?: LineGuideAttachment | null
}
