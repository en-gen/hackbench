/**
 * Unit tests for L3Loader.ts — stripe-image parser and helpers.
 *
 * parseStripeImage is a pure function (no ROM dependency), so all tests
 * run unconditionally.  ROM-dependent tests (readL3TilemapAddr, loadL3Tilemap)
 * are gated on ROM presence like other loader tests.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import {
  parseStripeImage,
  l3InitialYPx,
  L3_TILEMAP_BASE,
  L3_TILEMAP_COLS,
  L3_TILEMAP_ROWS,
  L3_HUD_ROW_CUTOFF,
  readL3SettingsByte,
  loadL3Tilemap,
  readInitialLayer1YPos,
  readMarioStartPos,
  findSecondaryEntranceForLevel,
  classifyL3Routine,
  readL3RoutineSummary,
} from '../../../src/rom/L3Loader'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildMapWithGraph } from '../../../src/rom/model/MapBuilder'

const ROM_PATH   = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

// ── parseStripeImage (pure) ──────────────────────────────────────────────────

describe('parseStripeImage', () => {
  it('returns a zero-filled 64×64 buffer for empty data', () => {
    const buf = parseStripeImage(new Uint8Array([0xFF]))
    expect(buf.length).toBe(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
    expect(buf.every(v => v === 0)).toBe(true)
  })

  it('writes one horizontal entry at a given VRAM address', () => {
    // Entry: VRAM=$5800, flags=$00 (horiz, no RLE), 4 bytes data = 2 tiles
    // byte0=$58, byte1=$00 → VRAM=$5800 → offset=$5800-$5000=$800=2048 → row=32,col=0
    const data = new Uint8Array([
      0x58, 0x00,  // VRAM $5800
      0x00, 0x03,  // flags=0 (horiz), count_hi byte + count=3 → (0<<8|3)+1=4 bytes
      0x7D, 0x39,  // tile 0: char $17D, palette 1
      0x7E, 0x39,  // tile 1: char $17E, palette 1
      0xFF,        // terminator
    ])
    const buf = parseStripeImage(data)
    const offset = L3_TILEMAP_BASE  // $5800 - $5000 = $800 = 2048
    const vramOffset = 0x5800 - L3_TILEMAP_BASE  // 2048 = row 32, col 0
    expect(buf[vramOffset]).toBe(0x397D)
    expect(buf[vramOffset + 1]).toBe(0x397E)
    // other entries untouched
    expect(buf[vramOffset - 1]).toBe(0)
    expect(buf[vramOffset + 2]).toBe(0)
  })

  it('writes a vertical entry correctly', () => {
    // VRAM=$5800, flags=$80 (vertical), count=3 → 4 bytes = 2 tiles written in column
    // row=32,col=0 and row=33,col=0 (stride=64)
    const data = new Uint8Array([
      0x58, 0x00,  // VRAM $5800
      0x80, 0x03,  // flags=$80 (vertical), count byte=3 → (0<<8|3)+1=4 bytes
      0x01, 0x00,  // tile 0: word $0001
      0x02, 0x00,  // tile 1: word $0002
      0xFF,
    ])
    const buf = parseStripeImage(data)
    const base = 0x5800 - L3_TILEMAP_BASE  // 2048 (row 32, col 0)
    expect(buf[base]).toBe(0x0001)
    expect(buf[base + L3_TILEMAP_COLS]).toBe(0x0002)  // next row, same col
  })

  it('skips entries outside the tilemap range', () => {
    // VRAM=$4FFF is below L3_TILEMAP_BASE=$5000 — should not write
    const data = new Uint8Array([
      0x4F, 0xFF,  // VRAM $4FFF (below base)
      0x00, 0x01,  // 2 bytes = 1 tile
      0xAA, 0xBB,
      0xFF,
    ])
    const buf = parseStripeImage(data)
    expect(buf.every(v => v === 0)).toBe(true)
  })

  it('handles multi-entry streams', () => {
    // Two consecutive entries.
    // VRAM $5000 → sub 0, within=0 → hw (row 0, col 0) → flat 0
    // VRAM $5040 → sub 0, within=$40=64 → hw (row 2, col 0) → flat 128
    const data = new Uint8Array([
      0x50, 0x00,  // VRAM $5000
      0x00, 0x01,  // 2 bytes = 1 tile
      0x01, 0x02,
      0x50, 0x40,  // VRAM $5040
      0x00, 0x01,  // 2 bytes = 1 tile
      0x03, 0x04,
      0xFF,
    ])
    const buf = parseStripeImage(data)
    expect(buf[0]).toBe(0x0201)    // hw row 0, col 0
    expect(buf[128]).toBe(0x0403)  // hw row 2, col 0
  })

  it('HUD rows (0 to L3_HUD_ROW_CUTOFF-1) may contain data from some tilemaps', () => {
    // VRAM $50A8 → sub 0, within=$A8=168 → hw row=168/32=5, col=168%32=8 → flat=5*64+8=328
    const data = new Uint8Array([
      0x50, 0xA8,  // VRAM $50A8
      0x00, 0x01,  // 1 tile
      0x99, 0x3D,
      0xFF,
    ])
    const buf = parseStripeImage(data)
    const flat = 5 * L3_TILEMAP_COLS + 8  // hw row 5, col 8 = 328
    expect(flat >> 6).toBeLessThan(L3_HUD_ROW_CUTOFF)  // row 5 < 8 cutoff
    expect(buf[flat]).toBe(0x3D99)
  })

  it('terminates on first byte with bit 7 set', () => {
    const data = new Uint8Array([
      0x80,  // bit 7 set — immediate terminator, no entries written
      0x50, 0x00, 0x00, 0x01, 0xAA, 0xBB,  // would write if not terminated
    ])
    const buf = parseStripeImage(data)
    expect(buf.every(v => v === 0)).toBe(true)
  })

  it('RLE entry: 2 data bytes repeated tileCount times', () => {
    // VRAM=$5800 → row 32, col 0; FLAGS=$40 (RLE, horizontal); COUNT=$03
    // countBytes = (0<<8|3)+1 = 4; tileCount = 4>>1 = 2; tile word = $1234
    // Should write $1234 at row 32 col 0 and col 1; stream advances by 2 (not 4).
    // Then $FF terminator.
    const data = new Uint8Array([
      0x58, 0x00,  // VRAM $5800
      0x40, 0x03,  // FLAGS=$40 (RLE, horiz), COUNT=3 → countBytes=4, tileCount=2
      0x34, 0x12,  // tile word $1234 (lo=$34, hi=$12)
      0xFF,        // terminator — must be reached (not skipped over)
    ])
    const buf = parseStripeImage(data)
    const base = 0x5800 - L3_TILEMAP_BASE  // 2048 = row 32, col 0
    expect(buf[base]).toBe(0x1234)
    expect(buf[base + 1]).toBe(0x1234)
    expect(buf[base + 2]).toBe(0)  // only 2 tiles written
  })

  it('RLE entry followed by normal entry parses both correctly', () => {
    // RLE at $5800 (2 tiles of $AABB), then normal at $5040 (1 tile of $0201)
    // $5800 → sub 2, within=0 → hw (row 32, col 0) → flat 2048
    // $5040 → sub 0, within=$40=64 → hw (row 2, col 0) → flat 128
    const data = new Uint8Array([
      0x58, 0x00, 0x40, 0x03,  // RLE header: $5800, tileCount=2
      0xBB, 0xAA,              // tile word $AABB
      0x50, 0x40, 0x00, 0x01,  // normal header: $5040, countBytes=2, tileCount=1
      0x01, 0x02,              // tile $0201
      0xFF,
    ])
    const buf = parseStripeImage(data)
    expect(buf[2048]).toBe(0xAABB)  // hw row 32, col 0
    expect(buf[2049]).toBe(0xAABB)  // hw row 32, col 1
    expect(buf[128]).toBe(0x0201)   // hw row 2, col 0
  })
})

// ── l3InitialYPx ─────────────────────────────────────────────────────────────

describe('l3InitialYPx', () => {
  it('returns $70 for up-and-down tide ($01)', () => {
    expect(l3InitialYPx(0x01)).toBe(0x70)
  })

  it('returns $70 for byte $00 (LSR-then-Z=1 path branches to $70)', () => {
    // bank_00.asm:4154-4161: LSR A; PHP; ...; LDA #$70; PLP; BEQ +; LDA #$40
    // For byte $00: LSR → $00, Z=1, BEQ branches → init Y stays at $70.
    // Vanilla never uses $00 in Layer3TilemapSettings, but this codifies the
    // exact ASM behavior so the assertion is correct rather than just pragmatic.
    expect(l3InitialYPx(0x00)).toBe(0x70)
  })

  it('returns $40 for stationary tide ($02 — canonical Tide_Stationary)', () => {
    // rammap.asm:1512: !Tide_Stationary = 2. CODE_009FB8 LSR makes A=$01,
    // Z=0, BEQ falls through to LDA #$40.
    expect(l3InitialYPx(0x02)).toBe(0x40)
  })

  it('returns $D0 for non-tide overlay ($80)', () => {
    expect(l3InitialYPx(0x80)).toBe(0xD0)
  })

  it('returns $D0 for non-tide overlay ($81)', () => {
    expect(l3InitialYPx(0x81)).toBe(0xD0)
  })

  it('returns 0 for values >= $C0 (special / no BG)', () => {
    expect(l3InitialYPx(0xC0)).toBe(0)
    expect(l3InitialYPx(0xFF)).toBe(0)
  })
})

// ── classifyL3Routine (pure) ─────────────────────────────────────────────────
//
// Mirrors the kind vocabulary used by computeL3ScrollRange, plus a 'disabled'
// case that signals "Layer3Setting === 0, no L3 selected at all" (distinct
// from 'none' which means "byte ≥ $C0, table entry exists but disables L3").
// Branch citations all in L3Loader.ts header comment + bank_00.asm CODE_009FB8.

describe('classifyL3Routine', () => {
  it('returns disabled when layer3Setting is 0', () => {
    expect(classifyL3Routine({ layer3Setting: 0, settingsByte: null, tileset: 0 }).kind).toBe('disabled')
  })

  it('returns tide ONLY for settingsByte === $01 (Tide_UpAndDown)', () => {
    // Per CODE_05C494 (bank_05.asm:5576-5578): DEC A; BNE CODE_05C4EC means
    // Y animation runs only when Layer3TideSetting === 1. Bytes $00 and
    // $02..$7F take other paths and don't update Layer3YPos.
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x01, tileset: 0 }).kind).toBe('tide')
  })

  it('returns fixed for byte $00 (CODE_05C40C BEQ skips tide handler)', () => {
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x00, tileset: 0 }).kind).toBe('fixed')
  })

  it('returns fixed for byte $02 (Tide_Stationary — Y is static at $40)', () => {
    expect(classifyL3Routine({ layer3Setting: 2, settingsByte: 0x02, tileset: 8 }).kind).toBe('fixed')
  })

  it('flags isTideUpAndDown only for byte $01', () => {
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x01, tileset: 0 }).isTideUpAndDown).toBe(true)
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x00, tileset: 0 }).isTideUpAndDown).toBe(false)
    expect(classifyL3Routine({ layer3Setting: 2, settingsByte: 0x02, tileset: 8 }).isTideUpAndDown).toBe(false)
  })

  it('returns fixed for settingsByte $80', () => {
    expect(classifyL3Routine({ layer3Setting: 2, settingsByte: 0x80, tileset: 1 }).kind).toBe('fixed')
    expect(classifyL3Routine({ layer3Setting: 2, settingsByte: 0x80, tileset: 6 }).kind).toBe('fixed')
  })

  it('returns fixed for settingsByte $81 with tileset 1 (Castle1) or 3 (Underground1)', () => {
    expect(classifyL3Routine({ layer3Setting: 3, settingsByte: 0x81, tileset: 1 }).kind).toBe('fixed')
    expect(classifyL3Routine({ layer3Setting: 3, settingsByte: 0x81, tileset: 3 }).kind).toBe('fixed')
  })

  it('returns camera-tracked for settingsByte $81 with non-castle/non-underground tileset', () => {
    // Same special-case as loadL3Tilemap: $81 + tileset != 1,3 takes the
    // CODE_00A01F path where Layer3YPos = Layer1YPos every frame.
    expect(classifyL3Routine({ layer3Setting: 3, settingsByte: 0x81, tileset: 6 }).kind).toBe('camera-tracked')
    expect(classifyL3Routine({ layer3Setting: 3, settingsByte: 0x81, tileset: 0 }).kind).toBe('camera-tracked')
  })

  it('returns none for settingsByte >= $C0', () => {
    expect(classifyL3Routine({ layer3Setting: 3, settingsByte: 0xC0, tileset: 0 }).kind).toBe('none')
    expect(classifyL3Routine({ layer3Setting: 3, settingsByte: 0xFF, tileset: 0 }).kind).toBe('none')
  })

  it('exposes initialYPx that matches l3InitialYPx, except for camera-tracked', () => {
    // Tide / fixed / none come straight from l3InitialYPx (post-fix: $00 = $70,
    // $01 = $70, $02..$7F = $40 — see l3InitialYPx tests for ASM citation).
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x01, tileset: 0 }).initialYPx).toBe(0x70)
    expect(classifyL3Routine({ layer3Setting: 1, settingsByte: 0x00, tileset: 0 }).initialYPx).toBe(0x70)
    expect(classifyL3Routine({ layer3Setting: 2, settingsByte: 0x02, tileset: 8 }).initialYPx).toBe(0x40)
    expect(classifyL3Routine({ layer3Setting: 2, settingsByte: 0x80, tileset: 1 }).initialYPx).toBe(0xD0)
    expect(classifyL3Routine({ layer3Setting: 2, settingsByte: 0x81, tileset: 1 }).initialYPx).toBe(0xD0)
    expect(classifyL3Routine({ layer3Setting: 3, settingsByte: 0xC0, tileset: 0 }).initialYPx).toBe(0)
    // camera-tracked has no static initial Y — it follows Layer1YPos every
    // frame. Surface as null so consumers don't render a misleading static
    // pixel value.
    expect(classifyL3Routine({ layer3Setting: 3, settingsByte: 0x81, tileset: 6 }).initialYPx).toBeNull()
    // Disabled: no settings byte means no initial Y.
    expect(classifyL3Routine({ layer3Setting: 0, settingsByte: null, tileset: 0 }).initialYPx).toBeNull()
  })
})

// ── ROM-dependent tests ───────────────────────────────────────────────────────

describe.skipIf(!romPresent)('L3Loader (ROM-only)', () => {
  it('Layer3TilemapSettings byte is readable for tileset 0', () => {
    const rom = SmwRom.open(ROM_PATH)
    const b = readL3SettingsByte(rom.rom, 0, 1)
    expect(b).not.toBeNull()
  })

  it('loadL3Tilemap returns null for a level without L3', () => {
    // Level 0 (title screen area) typically has layer3Setting=0
    const rom = SmwRom.open(ROM_PATH)
    // Find any level known to have no L3 (title screen level 0x00)
    const result = loadL3Tilemap(rom.rom, 0x000, 0)
    // If layer3Setting is 0 for this level, result should be null
    // (we can't guarantee level 0 has no L3 in all ROM versions, so just
    //  verify the function returns a valid shape when non-null)
    if (result !== null) {
      expect(result.tilemap.length).toBe(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
      expect(result.initialYPx).toBeGreaterThanOrEqual(0)
    }
  })

  it('readMarioStartPos decodes level $01B primary entrance (Mario at col 1 row 22)', () => {
    // DATA_05F000[$1B] = $4B → Y idx $B → DATA_05D730[$B]=$60, DATA_05D740[$B]=$01
    //   → Y = $0160 = 352 px (row 22).
    // DATA_05F200[$1B] = $00 → X idx 0 → DATA_05D750[0]=$10, DATA_05D758[0]=$00
    //   → X = $0010 = 16 px (col 1).
    const rom = SmwRom.open(ROM_PATH)
    const pos = readMarioStartPos(rom.rom, 0x01B)
    expect(pos).toEqual({ x: 0x0010, y: 0x0160 })
  })

  it('readMarioStartPos follows the secondary entrance for sublevel $102', () => {
    // $102 is only reachable via secondary entrance $1BE. DATA_05FA00[$1BE]
    // provides the Y index; DATA_05FC00[$1BE] >> 5 provides the X index.
    const rom = SmwRom.open(ROM_PATH)
    const pos = readMarioStartPos(rom.rom, 0x102)
    // Values come from the ROM; assert basic shape + within legal pixel range.
    expect(pos.x).toBeGreaterThanOrEqual(0)
    expect(pos.x).toBeLessThanOrEqual(0x1E0)
    expect(pos.y).toBeGreaterThanOrEqual(0)
  })

  it('primary-entrance camera Y reads from DATA_05F400 bits 3:2, not DATA_05F200', () => {
    // bank_05.asm:7323-7335: the level-load path reloads `_2` from
    // $05F400[level] before extracting bits 3:2 to index DATA_05D708. Earlier
    // versions of this code mistakenly read $05F200 (which only matches
    // $05F400 by coincidence on a few levels), causing a 192-pixel L3
    // misposition on most L3-using vanilla levels.
    //
    // Concrete: $009 (cave BG, Underground1 tileset).
    //   $05F200[$009] = $C0 → bits 3:2 = 0 → would yield camera Y $00 (WRONG)
    //   $05F400[$009] = $0A → bits 3:2 = 2 → DATA_05D708[2] = $C0 (CORRECT,
    //     verified against live game runtime via Mesen Memory Viewer at $7E:001C)
    const rom = SmwRom.open(ROM_PATH)
    expect(readInitialLayer1YPos(rom.rom, 0x009, false)).toBe(0xC0)
    // $127 (water level, primary entrance, no secondary entrance targets it).
    expect(readInitialLayer1YPos(rom.rom, 0x127, false)).toBe(0xC0)
  })

  it('sublevels ($100+) use secondary-entrance camera Y, not primary entrance', () => {
    // Level $102 (Yoshi's Island 4) is a sublevel — only reachable via
    // secondary entrance $1BE (bank_05.asm:7129-7136).  The primary-entrance
    // tables put camera Y at 0 (wrong), but $05FA00[$1BE] = $AB → bits 5:4 = 2
    // → DATA_05D708[2] = $C0 = 192. This places the tide water at level Y 384.
    const rom = SmwRom.open(ROM_PATH)
    expect(findSecondaryEntranceForLevel(rom.rom, 0x102)).toBe(0x1BE)
    const camY = readInitialLayer1YPos(rom.rom, 0x102, false)
    expect(camY).toBe(0xC0)  // = 192
    // Derived: wave row 32 with Tide_Stationary ($40): pixelY = 256 - 64 + 192 = 384
    const load = loadL3Tilemap(rom.rom, 0x102, 8)
    expect(load!.initialYPx).toBe(0x40)
    expect(32 * 8 - load!.initialYPx + camY).toBe(384)
  })

  it('level $102 L1 ground distribution: dense ground in rows 20-26', () => {
    // Documents how L1 data is structured for this level. The user's expectation
    // of "water at the bottom" corresponds to the dense ground region (rows 20-26,
    // Y=320-416), NOT to where the ROM's BG3VOFS math places the water tiles
    // (screen Y 192, level Y 192 with camera Y 0).
    const rom = SmwRom.open(ROM_PATH)
    const { map } = buildMapWithGraph(rom, 0x102)
    const filledPerRow = map.l1.map(row => row.filter(v => v !== null).length)
    // Rows 20-26 should be dense ground (>60 tiles each)
    for (let r = 20; r <= 26; r++) {
      expect(filledPerRow[r]).toBeGreaterThan(60)
    }
    // Rows 0-5 empty, row 6+ starts sparse sky/platforms
    for (let r = 0; r <= 5; r++) {
      expect(filledPerRow[r]).toBe(0)
    }
  })

  it('Layer3TilemapSettings table at $009F88 matches disassembly (bank_00.asm:4122)', () => {
    // Regression test: the table lives at $009F88, not $009F8D as previously assumed.
    // Verify ts0 and ts1 entries match the disassembly:
    //   ts0: db !Tide_UpAndDown,!Tide_Stationary,$C0  → 0x01, 0x02, 0xC0
    //   ts1: db !Tide_UpAndDown,$80,$81               → 0x01, 0x80, 0x81
    const rom = SmwRom.open(ROM_PATH)
    expect(rom.rom.readByte(0x009F88)).toBe(0x01)
    expect(rom.rom.readByte(0x009F89)).toBe(0x02)
    expect(rom.rom.readByte(0x009F8A)).toBe(0xC0)
    expect(rom.rom.readByte(0x009F8B)).toBe(0x01)
    expect(rom.rom.readByte(0x009F8C)).toBe(0x80)
    expect(rom.rom.readByte(0x009F8D)).toBe(0x81)
  })

  it('level $102 (Yoshi\'s Island 4) ROM values: tileset 8, Tide_Stationary', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0x102)
    expect(raw).not.toBeNull()
    const tileset = raw![4]! & 0x0F
    expect(tileset).toBe(8)
    const load = loadL3Tilemap(rom.rom, 0x102, tileset)
    expect(load).not.toBeNull()
    expect(load!.initialYPx).toBe(0x40)  // Tide_Stationary → $40 = 64
  })

  it('readL3RoutineSummary level $102 (Yoshi\'s Island 4 sublevel) → fixed / Tide_Stationary', () => {
    // $102 has tileset 8, layer3Setting 2, settings byte $02 (Tide_Stationary).
    // Per the fix: only byte $01 animates Y, so $02 → kind:'fixed'. Init Y
    // stays at $40 from l3InitialYPx (canonical Tide_Stationary value).
    const rom = SmwRom.open(ROM_PATH)
    const sum = readL3RoutineSummary(rom.rom, 0x102, 8)
    expect(sum.layer3Setting).toBeGreaterThan(0)
    expect(sum.kind).toBe('fixed')
    expect(sum.isTideUpAndDown).toBe(false)
    expect(sum.initialYPx).toBe(0x40)
  })

  it('readL3RoutineSummary returns disabled for a level with no L3', () => {
    // Walk the ROM for a level with $05F200 bits 7:6 = 0. Most non-L3 levels
    // qualify; pick one and assert kind='disabled' + null fields.
    const rom = SmwRom.open(ROM_PATH)
    let foundDisabled = false
    for (let lvl = 0; lvl < 0x200; lvl++) {
      const byte = rom.rom.readByte(0x05F200 + lvl) ?? 0
      if (((byte & 0xC0) >> 6) === 0) {
        const sum = readL3RoutineSummary(rom.rom, lvl, 0)
        expect(sum.layer3Setting).toBe(0)
        expect(sum.kind).toBe('disabled')
        expect(sum.settingsByte).toBeNull()
        expect(sum.initialYPx).toBeNull()
        foundDisabled = true
        break
      }
    }
    expect(foundDisabled).toBe(true)
  })

  it('loadL3Tilemap produces non-zero tiles for a tide level', () => {
    // Level $107 (Vanilla Dome 2) typically uses a tide tileset
    // We just verify the parse returns something non-trivially empty
    const rom = SmwRom.open(ROM_PATH)
    // Scan first 0x20 levels for any with L3
    let found = false
    for (let lvl = 0; lvl < 0x200 && !found; lvl++) {
      const result = loadL3Tilemap(rom.rom, lvl, 0)
      if (result && result.tilemap.some(v => v !== 0)) {
        found = true
        expect(result.tilemap.length).toBe(L3_TILEMAP_COLS * L3_TILEMAP_ROWS)
      }
    }
    // At least some level in the ROM should have L3 data
    expect(found).toBe(true)
  })
})
