/**
 * Diagnostic test for AnimationLoader — tracing berry tile placement.
 *
 * The berry animation (tileIdx 5) DMA's 4 tiles to VRAM char $080.
 * This test verifies the charBase, buffer offset, and tile data
 * to diagnose why the bottom half appears shifted in the 8x8 viewer.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import { loadAnimationData } from '../../../src/rom/AnimationLoader'
import { loadVram, VRAM_SLOT_NAMES, VRAM_CHAR_BASE, getCharPixels } from '../../../src/rom/GfxLoader'

const ROM_PATH  = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent  = existsSync(ROM_PATH)

describe('AnimationLoader berry tiles', () => {
  if (!romPresent) {
    it.skip('ROM not available', () => {})
    return
  }

  const rom = SmwRom.open(ROM_PATH)

  it('loads animation data for tileset 0', () => {
    const animData = loadAnimationData(rom.rom, 0)
    expect(animData).not.toBeNull()
    expect(animData!.frameCount).toBe(4)
    expect(animData!.frames.length).toBe(4)
  })

  it('frame 0: berry splits into $080-$081 and $090-$091', () => {
    const animData = loadAnimationData(rom.rom, 0)!
    const frame0 = animData.frames[0]

    const slot1 = frame0.find(s => s.charBase === 0x080)!
    const slot2 = frame0.find(s => s.charBase === 0x090)!
    expect(slot1.tiles.length).toBe(2)
    expect(slot2.tiles.length).toBe(2)

    for (let t = 0; t < 2; t++) {
      const nonZero = slot1.tiles[t].filter(p => p !== 0).length
      console.log(`  berry TL/BL tile[${t}] → char $${(0x080 + t).toString(16).padStart(3, '0')}: ${nonZero}/64 non-zero pixels`)
    }
    for (let t = 0; t < 2; t++) {
      const nonZero = slot2.tiles[t].filter(p => p !== 0).length
      console.log(`  berry TR/BR tile[${t}] → char $${(0x090 + t).toString(16).padStart(3, '0')}: ${nonZero}/64 non-zero pixels`)
    }
  })

  it('dump all frame 0 animation char positions (sorted)', () => {
    const animData = loadAnimationData(rom.rom, 0)!
    const frame0 = animData.frames[0]

    // Collect all char positions
    const allChars: { charBase: number; count: number }[] = []
    for (const slot of frame0) {
      allChars.push({ charBase: slot.charBase, count: slot.tiles.length })
    }
    allChars.sort((a, b) => a.charBase - b.charBase)

    console.log('\nFrame 0 animation slots (tileset 0):')
    for (const { charBase, count } of allChars) {
      const end = charBase + count - 1
      console.log(`  chars $${charBase.toString(16).padStart(3,'0')}-$${end.toString(16).padStart(3,'0')} (${count} tiles)`)
    }
  })

  it('berry split: tiles at $080-$081 and $090-$091', () => {
    const animData = loadAnimationData(rom.rom, 0)!
    const frame0 = animData.frames[0]

    // After the fix, berry should produce TWO slots:
    // $080-$081 (first 2 tiles) and $090-$091 (second 2 tiles)
    const berrySlot1 = frame0.find(s => s.charBase === 0x080)
    const berrySlot2 = frame0.find(s => s.charBase === 0x090)

    expect(berrySlot1).toBeDefined()
    expect(berrySlot1!.tiles.length).toBe(2)
    console.log(`  Berry slot 1: char $080-$081, ${berrySlot1!.tiles.length} tiles`)

    expect(berrySlot2).toBeDefined()
    expect(berrySlot2!.tiles.length).toBe(2)
    console.log(`  Berry slot 2: char $090-$091, ${berrySlot2!.tiles.length} tiles`)

    // No slot should write to $082-$083 (those stay as FG2 base data)
    const rogue = frame0.find(s => s.charBase === 0x082 || s.charBase === 0x083)
    expect(rogue).toBeUndefined()
  })

  it('berry chars $080-$081 and $090-$091 in override map, $082-$083 NOT', () => {
    const animData = loadAnimationData(rom.rom, 0)!

    const overrides = new Map<number, Uint8Array>()
    for (const slot of animData.frames[0]) {
      for (let i = 0; i < slot.tiles.length; i++) {
        overrides.set(slot.charBase + i, slot.tiles[i])
      }
    }

    // Berry first half: $080-$081
    expect(overrides.has(0x080)).toBe(true)
    expect(overrides.has(0x081)).toBe(true)
    // Berry second half: $090-$091
    expect(overrides.has(0x090)).toBe(true)
    expect(overrides.has(0x091)).toBe(true)
    // $082-$083 should NOT be overridden (keep FG2 base data)
    expect(overrides.has(0x082)).toBe(false)
    expect(overrides.has(0x083)).toBe(false)
  })

  it('berry tile pixel patterns (2×2 split layout)', () => {
    const animData = loadAnimationData(rom.rom, 0)!
    const slot1 = animData.frames[0].find(s => s.charBase === 0x080)!
    const slot2 = animData.frames[0].find(s => s.charBase === 0x090)!

    const allTiles = [
      { label: 'TL ($080)', tile: slot1.tiles[0] },
      { label: 'BL ($081)', tile: slot1.tiles[1] },
      { label: 'TR ($090)', tile: slot2.tiles[0] },
      { label: 'BR ($091)', tile: slot2.tiles[1] },
    ]
    for (const { label, tile } of allTiles) {
      console.log(`\n  ${label}:`)
      for (let y = 0; y < 8; y++) {
        const row = Array.from({ length: 8 }, (_, x) => {
          const p = tile[y * 8 + x]
          return p === 0 ? '.' : p.toString(16)
        }).join('')
        console.log(`    ${row}`)
      }
    }
  })

  it('compare water tile position with berry', () => {
    const animData = loadAnimationData(rom.rom, 0)!
    const frame0 = animData.frames[0]

    // Water tiles are tileset-dependent (behavior 2).
    // For tileset 0, find slots near berry ($080) to check ordering
    const slotsNearBerry = frame0
      .filter(s => s.charBase >= 0x040 && s.charBase <= 0x0FF)
      .sort((a, b) => a.charBase - b.charBase)

    console.log('\nAnimation slots near berry (chars $040-$0FF):')
    for (const slot of slotsNearBerry) {
      const end = slot.charBase + slot.tiles.length - 1
      const nonZeroCounts = slot.tiles.map(t => t.filter(p => p !== 0).length)
      console.log(`  $${slot.charBase.toString(16).padStart(3,'0')}-$${end.toString(16).padStart(3,'0')}: pixels=[${nonZeroCounts.join(',')}]`)
    }
  })

  it('A/B compare our VRAM chars $060-$090 vs Mesen dump', () => {
    const mesenPath = resolve(__dirname, '../../../tools/mesen/Debugger/Super Mario World (USA) - SnesVideoRam.dmp')
    if (!existsSync(mesenPath)) { console.log('Mesen VRAM dump not found'); return }

    const mesenVram = readFileSync(mesenPath)
    const animData = loadAnimationData(rom.rom, 0)!
    const vram = loadVram(rom.rom, 0, 0)

    // Apply frame 0 overrides to VRAM
    for (const slot of animData.frames[0]) {
      for (let i = 0; i < slot.tiles.length; i++) {
        const charNum = slot.charBase + i
        // Write into the correct VRAM slot
        for (const slotName of VRAM_SLOT_NAMES) {
          const base = VRAM_CHAR_BASE[slotName]
          const sheet = vram[slotName]
          if (!sheet) continue
          if (charNum >= base && charNum < base + sheet.length) {
            sheet[charNum - base] = slot.tiles[i]
          }
        }
      }
    }

    // Compare chars in the animated region ($040-$090) — covers berry area
    // Mesen VRAM is 64KB of raw bytes. 4bpp: 32 bytes per tile, at word address * 2
    console.log('\nChar comparison (our vs Mesen) for chars $040-$090:')
    let mismatches = 0
    for (let charNum = 0x040; charNum <= 0x090; charNum++) {
      const ourPixels = getCharPixels(vram, charNum)

      // Mesen: char in BG space, byte offset = charNum * 32 (4bpp, 32 bytes per tile)
      const mesenOff = charNum * 32
      // Decode Mesen's 4bpp raw bytes to pixel indices
      const mesenPixels = new Uint8Array(64)
      for (let row = 0; row < 8; row++) {
        const p0lo = mesenVram[mesenOff + row * 2]
        const p0hi = mesenVram[mesenOff + row * 2 + 1]
        const p1lo = mesenVram[mesenOff + 16 + row * 2]
        const p1hi = mesenVram[mesenOff + 16 + row * 2 + 1]
        for (let col = 0; col < 8; col++) {
          const bit = 7 - col
          mesenPixels[row * 8 + col] =
            ((p0lo >> bit) & 1) |
            (((p0hi >> bit) & 1) << 1) |
            (((p1lo >> bit) & 1) << 2) |
            (((p1hi >> bit) & 1) << 3)
        }
      }

      // Compare
      let match = true
      if (!ourPixels) {
        match = mesenPixels.every(p => p === 0)
      } else {
        for (let p = 0; p < 64; p++) {
          if ((ourPixels[p] ?? 0) !== mesenPixels[p]) { match = false; break }
        }
      }
      if (!match) {
        mismatches++
        const ourRow0 = ourPixels ? Array.from(ourPixels.slice(0,8)).map(p => p.toString(16)).join('') : '(null)'
        const mesRow0 = Array.from(mesenPixels.slice(0,8)).map(p => p.toString(16)).join('')
        console.log(`  MISMATCH char $${charNum.toString(16).padStart(3,'0')}: our=[${ourRow0}] mesen=[${mesRow0}]`)
      }
    }
    console.log(`  ${mismatches} mismatches out of ${0x090 - 0x040 + 1} chars`)
  })

  it('check FG2 base tiles near berry position ($080-$08F)', async () => {
    const vram = loadVram(rom.rom, 0, 0)
    const { readGfxAssignment } = await import('../../../src/rom/GfxLoader')
    const assignment = readGfxAssignment(rom.rom, 0, 0)
    console.log(`\nTileset 0 GFX assignment: fg1=GFX${assignment.fg1?.toString(16).padStart(2,'0')}, fg2=GFX${assignment.fg2?.toString(16).padStart(2,'0')}, fg3=GFX${assignment.fg3?.toString(16).padStart(2,'0')}, an1=GFX${assignment.an1?.toString(16).padStart(2,'0')}`)

    // Check FG2 tiles 0-15 (chars $080-$08F) — the berry goes to chars $080-$083
    const fg2Sheet = vram['fg2']
    if (!fg2Sheet) { console.log('  FG2 not loaded!'); return }
    console.log(`  FG2 sheet: ${fg2Sheet.length} tiles`)

    for (let t = 0; t < Math.min(16, fg2Sheet.length); t++) {
      const nonZero = fg2Sheet[t].filter(p => p !== 0).length
      const row0 = Array.from(fg2Sheet[t].slice(0, 8)).map(p => p.toString(16)).join('')
      console.log(`  FG2[${t}] (char $${(0x080+t).toString(16).padStart(3,'0')}): ${nonZero.toString().padStart(2)}/64 px  row0=[${row0}]`)
    }
  })

  it('compare berry across all 4 frames', () => {
    const animData = loadAnimationData(rom.rom, 0)!

    for (let frame = 0; frame < 4; frame++) {
      const berrySlot = animData.frames[frame].find(s => s.charBase === 0x080)
      if (!berrySlot) {
        console.log(`  frame ${frame}: NO berry slot at char $080!`)
        continue
      }
      const tileSummary = berrySlot.tiles.map((t, i) => {
        const nonZero = t.filter(p => p !== 0).length
        return `tile${i}=${nonZero}px`
      }).join(', ')
      console.log(`  frame ${frame}: ${tileSummary}`)
    }
  })
})
