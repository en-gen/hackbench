import type { Char } from './chars/Char'
import type { L2Layer } from './L2Layer'
import type { Tile } from './tiles/Tile'

export class SmwRomData {
  constructor(
    readonly chars: Map<number, Char>,
    readonly tiles: Map<number, Tile>,
    readonly l2Presets: Map<number, L2Layer>,
  ) {}
}
