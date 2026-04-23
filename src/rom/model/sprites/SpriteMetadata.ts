export interface SpriteMetadata {
  displayName?: string
  spawns?: number
  isGenerator?: boolean
}

const SPRITE_METADATA: Record<number, SpriteMetadata> = {
  0x1E: { displayName: 'Lakitu' },
  0x3E: { displayName: 'P-Switch' },
  0x9F: { displayName: 'Banzai Bill' },

  0xC9: { displayName: 'Eerie Generator', isGenerator: true, spawns: 0x38 },
  0xCA: { displayName: 'Para-Enemy Generator', isGenerator: true },
  0xD3: { displayName: 'Bullet Bill Shooter', isGenerator: true, spawns: 0x1C },
  0xD4: { displayName: 'Dolphin Generator', isGenerator: true, spawns: 0x41 },
}

export function getSpriteMetadata(id: number): SpriteMetadata | undefined {
  return SPRITE_METADATA[id]
}
