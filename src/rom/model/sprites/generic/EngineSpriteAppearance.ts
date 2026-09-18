/**
 * SCAFFOLDING. Adapter that lets `SpriteDrawEngine` draw into the map editor
 * next to the shipped appearance classes, so the two can be compared live.
 *
 * This exists to answer "does the engine look right", not to ship. It is
 * gated behind a toolbar toggle that is OFF by default, it persists nothing,
 * and when the engine becomes the only render path this file, the toggle and
 * the `Sprite.engineAppearance` field all delete together. See
 * `docs/sprite-engine-wiring.md`.
 *
 * It adds NO rendering capability. Every pixel decision is made by
 * `drawSpriteParts`; this file only supplies the live inputs (sprite X,
 * Mario X, game frame), resolves chars to pixels, and draws the editor
 * affordances. If output looks wrong, the engine is wrong.
 */

import type { RomFile } from '../../../RomFile'
import { bgr555ToRgba, type RgbaColor } from '../../../GraphicsDecoder'
import { readSpriteTileTables, type SpriteTileTables } from '../../../SpriteTileLoader'
import type { Char } from '../../chars/Char'
import type { PixelPos, RenderTarget } from '../../RenderTarget'
import { editorStore } from '../../stores/editorStore'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { Sprite } from '../Sprite'
import { CompositeSprite } from '../CompositeSprite'
import type { SpriteDrawDescriptor } from './SpriteDrawDescriptor'
import {
  drawSpriteParts, findDescriptor, unionExtents,
  ROM_FRAMES_PER_TICK, type EngineFailure, type EnginePart, type PaletteNote,
  type SpriteExtents,
} from './SpriteDrawEngine'
import {
  describeHandlerProvenance, provenanceMessage, type HandlerProvenance,
} from './SpriteHandlerProvenance'

/** Editor affordance, not sprite art: corner ticks in a fixed hue. The
 *  sprite's own pixels are never tinted, because colour is what is being
 *  compared. */
const MARK_ENGINE: [number, number, number, number] = [90, 200, 255, 255]
/** A handler this cart has repointed. The sprite is fine; our claim about it
 *  is not, and the shipped appearance is drawn instead. */
const MARK_UNVERIFIED: [number, number, number, number] = [255, 170, 40, 255]
/** The engine READ the cart and could not interpret what it found: an
 *  unmodelled tail call, an unknown draw routine, an unexpected opcode, a
 *  nudge naming an entry that was never written, or a read off the end.
 *
 *  A distinct colour because it is a distinct situation. Amber says "this
 *  cart changed the handler"; magenta says "this cart is stock as far as the
 *  pointers go, and the engine still could not render it", which is a gap in
 *  the engine or a partially rewritten handler and is actionable where the
 *  amber case is not. Sharing one colour made the two indistinguishable. */
const MARK_ENGINE_DECLINED: [number, number, number, number] = [235, 90, 220, 255]
const TICK_LEN = 3

function fill(target: RenderTarget, x: number, y: number, w: number, h: number, c: [number, number, number, number]): void {
  target.fillRect({ x, y } as PixelPos, { w, h }, c)
}

/** Four L-shaped corner ticks around a rect. Chosen over a full outline so
 *  the sprite is not boxed in and the marker cannot be mistaken for the
 *  tile-grid overlay. */
function drawCornerTicks(
  target: RenderTarget, x: number, y: number, w: number, h: number,
  c: [number, number, number, number],
): void {
  const r = x + w - 1, b = y + h - 1
  fill(target, x, y, TICK_LEN, 1, c);                 fill(target, x, y, 1, TICK_LEN, c)
  fill(target, r - TICK_LEN + 1, y, TICK_LEN, 1, c);  fill(target, r, y, 1, TICK_LEN, c)
  fill(target, x, b, TICK_LEN, 1, c);                 fill(target, x, b - TICK_LEN + 1, 1, TICK_LEN, c)
  fill(target, r - TICK_LEN + 1, b, TICK_LEN, 1, c);  fill(target, r, b - TICK_LEN + 1, 1, TICK_LEN, c)
}

/** Provenance warnings already emitted, by sprite ID. */
const warned = new Set<number>()
/** Render-failure warnings already emitted, keyed `spriteId:kind`. Keyed on
 *  the KIND as well as the sprite, because one sprite can fail differently on
 *  different frames and the second reason is the interesting one. Rendering
 *  runs per frame, so an unkeyed log would flood the console. */
const renderWarned = new Set<string>()

export class EngineSpriteAppearance implements SpriteAppearance {
  /**
   * Whether the engine can vouch for this sprite on THIS cart. Resolved once,
   * because the open ROM does not change under a loaded map. A non-vanilla
   * answer means the engine declines to draw and says so, rather than
   * rendering a confident wrong sprite.
   */
  readonly provenance: HandlerProvenance

  /** Free-running game-frame counter. Advanced by the editor's single sprite
   *  timer via `tickAnimation`, converted at `ROM_FRAMES_PER_TICK`, so engine
   *  sprites share the cadence of every other animated sprite. */
  private romFrame = 0

  /** Marker box, unioned over every frame and cached. Per-frame extents
   *  change size mid-animation when a part leaves the body's box, as $1F's
   *  wand does, so the affordance would jitter and a rect derived from one
   *  frame would clip on the others. */
  private extents?: SpriteExtents | null
  /** X the cached box was computed at, since facing depends on it. */
  private extentsAt = NaN

  /** Runtime-uploaded CGRAM colours, read from the cart once. Keyed by the
   *  note's resolved entry address so a descriptor change invalidates it. */
  private dynColors: RgbaColor[] = []
  private dynFrom = -1

  /** Reused composite row, so `render` allocates nothing per part. */
  private readonly rowScratch: RgbaColor[] = []

  constructor(
    private readonly rom: RomFile,
    private readonly tables: SpriteTileTables,
    private readonly descriptor: SpriteDrawDescriptor,
    private readonly chars: Map<number, Char>,
    private readonly placeholder: Char,
    /** The shipped appearance for this sprite. Drawn instead of engine
     *  output when the engine declines, so the map stays readable. */
    readonly fallback: SpriteAppearance,
  ) {
    this.provenance = describeHandlerProvenance(rom, descriptor.spriteId)
    if (this.provenance.kind !== 'vanilla' && !warned.has(descriptor.spriteId)) {
      warned.add(descriptor.spriteId)
      console.warn('[spriteEngine]', provenanceMessage(this.provenance))
    }
  }

  /** Hit-testing stays on the shipped rect so selection behaviour does not
   *  change with the toggle. */
  get hitRect(): HitRect { return this.fallback.hitRect }

  tickAnimation(): void { this.romFrame += ROM_FRAMES_PER_TICK }

  render(target: RenderTarget, x: number, y: number, behavior: SpriteBehavior, mapStore: MapStore): void {
    const marks = editorStore.spriteEngineMarkers
    if (this.provenance.kind !== 'vanilla') {
      this.fallback.render(target, x, y, behavior, mapStore)
      if (marks) this.markUnverified(target, x, y)
      return
    }

    const res = drawSpriteParts({
      rom: this.rom, tables: this.tables, descriptor: this.descriptor,
      spriteX: x,
      ctx: { marioX: mapStore.marioSpawnX, romFrame: this.romFrame },
    })
    if (!res.ok) {
      this.warnRenderFailure(res.failure)
      this.fallback.render(target, x, y, behavior, mapStore)
      if (marks) this.markDeclined(target, x, y)
      return
    }

    if (res.paletteNote) this.loadDynColors(res.paletteNote)
    for (const p of res.parts) {
      // A char absent from this level's sprite set draws as the placeholder
      // rather than failing the sprite. DELIBERATE, and the reason
      // `charsNotLoaded` is not reachable from this path: on a map, a sprite
      // whose chars are partly missing is still worth placing and still
      // worth seeing, and the missing tiles are exactly what the author
      // needs shown. `renderSpriteFrame` DOES report `charsNotLoaded`,
      // because a sprite picker drawing a thumbnail out of placeholders is
      // worse than one saying the sprite is unavailable in this level.
      const char = this.chars.get(p.charNum) ?? this.placeholder
      const row = this.rowFor(p.palette, res.paletteNote, mapStore)
      target.blit8x8(char.getPixels(), { x: x + p.dx, y: y + p.dy }, row, p.flipX, p.flipY)
    }
    const box = this.boundingBox(x, mapStore)
    if (marks && box) drawCornerTicks(target, x + box.x0, y + box.y0, box.x1 - box.x0, box.y1 - box.y0, MARK_ENGINE)
  }

  /**
   * The CGRAM row this part must be drawn with.
   *
   * The handler's DMA overwrites only PART of a row (8 of 16 colours, for
   * $1F), so the untouched columns still come from the level palette and the
   * two have to be spliced.
   *
   * No per-part row check: every part of one `drawSpriteParts` call carries
   * the same `pal.row`, and the cart tests assert that for $1F. A check for a
   * case the engine cannot produce is a branch no test can kill.
   */
  private rowFor(palette: number, note: PaletteNote | undefined, mapStore: MapStore): RgbaColor[] {
    const base = mapStore.palette.row(palette)
    if (!note || this.dynColors.length === 0) return base
    for (let i = 0; i < base.length; i++) this.rowScratch[i] = base[i]
    for (let i = 0; i < this.dynColors.length && note.firstCol + i < base.length; i++) {
      this.rowScratch[note.firstCol + i] = this.dynColors[i]
    }
    return this.rowScratch
  }

  /** Read the resting entry's BGR555 words from the cart, once per address. */
  private loadDynColors(note: PaletteNote): void {
    if (this.dynFrom === note.entryAddr) return
    this.dynFrom = note.entryAddr
    const bytes = this.rom.readAt(note.entryAddr, note.colors * 2)
    this.dynColors = bytes
      ? Array.from({ length: note.colors }, (_, i) => bgr555ToRgba(bytes[i * 2] | (bytes[i * 2 + 1] << 8)))
      : []
  }

  /** Union of every frame's parts at this sprite's own X, computed once.
   *  The X matters: facing decides which side the wand is on, so a union
   *  over both facings would be twice as wide as anything ever drawn. */
  private boundingBox(spriteX: number, mapStore: MapStore): SpriteExtents | null {
    if (this.extents !== undefined && this.extentsAt === spriteX) return this.extents
    this.extentsAt = spriteX
    const frames: EnginePart[][] = []
    for (let f = 0; f < this.descriptor.frames; f++) {
      const r = drawSpriteParts({
        rom: this.rom, tables: this.tables, descriptor: this.descriptor,
        spriteX, ctx: { marioX: mapStore.marioSpawnX, romFrame: 0 }, forceFrame: f,
      })
      if (r.ok) frames.push(r.parts)
    }
    this.extents = unionExtents(frames)
    return this.extents
  }

  private markUnverified(target: RenderTarget, x: number, y: number): void {
    this.markFallback(target, x, y, MARK_UNVERIFIED)
  }

  /** The engine read the cart and declined. Its own colour, so it is not
   *  mistaken for a repointed handler. */
  private markDeclined(target: RenderTarget, x: number, y: number): void {
    this.markFallback(target, x, y, MARK_ENGINE_DECLINED)
  }

  private markFallback(target: RenderTarget, x: number, y: number, c: RgbaColor): void {
    const hr = this.fallback.hitRect
    drawCornerTicks(target, x + hr.dx, y + hr.dy, hr.w, hr.h, c)
    // Filled pip so a fallback is distinguishable from "engine drew this"
    // without relying on hue alone.
    fill(target, x + hr.dx + 1, y + hr.dy + 1, 2, 2, c)
  }

  /**
   * Say WHY the engine declined, once per sprite per reason. Without it a
   * render failure degraded to the shipped appearance with no trace, and
   * with markers off was invisible. At least two of the five kinds are
   * engine gaps rather than cart properties, so they are worth a line.
   */
  private warnRenderFailure(failure: EngineFailure): void {
    const tag = `${failure.spriteId}:${failure.kind}`
    if (renderWarned.has(tag)) return
    renderWarned.add(tag)
    const id = `$${failure.spriteId.toString(16).toUpperCase().padStart(2, '0')}`
    console.warn('[spriteEngine]', `${id}: engine declined (${failure.kind})`, failure)
  }
}

/**
 * Attach an engine appearance to every sprite that has a traced descriptor.
 *
 * THIS IS THE SEAM. It is called from `rehydrate.buildGraph`, on the webview
 * side, because that is where the map the user looks at is actually built.
 * Returns the count so a caller (or a test) can assert the crossing happened
 * rather than assuming it. Sprites with no descriptor are left untouched and
 * keep rendering exactly as before.
 */
export function attachEngineAppearances(
  sprites: readonly Sprite[],
  rom: RomFile | null,
  chars: Map<number, Char>,
  placeholder: Char,
): number {
  if (!rom) return 0
  const tables = readSpriteTileTables(rom)
  if (!tables) return 0
  let attached = 0
  const visit = (s: Sprite): void => {
    const d = findDescriptor(s.id)
    if (d) {
      s.engineAppearance = new EngineSpriteAppearance(rom, tables, d, chars, placeholder, s.appearance)
      attached++
    }
    if (s instanceof CompositeSprite && s.secondary) visit(s.secondary)
  }
  for (const s of sprites) visit(s)
  return attached
}
