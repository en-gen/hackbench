#!/usr/bin/env node
/**
 * SMW ROM Validator — Orchestrator
 *
 * Spawns Mesen2 with the SMW ROM, then watches for JSON dump files written
 * by validator.lua. For each dump, reads our ROM parser output and compares.
 *
 * Usage:
 *   node scripts/validate/orchestrate.js [--rom <path>] [--mesen <path>]
 *
 * Defaults (relative to project root):
 *   --rom    test/roms/Super Mario World (USA).vanilla.sfc
 *   --mesen  test/roms/Mesen.exe
 */

const fs    = require('fs')
const path  = require('path')
const { spawn } = require('child_process')

// ── Paths ─────────────────────────────────────────────────────────────────────

const ROOT       = path.resolve(__dirname, '../..')
const RESULTS    = path.join(__dirname, 'results')
const LEVELS_CFG = path.join(__dirname, 'levels.json')

const args = process.argv.slice(2)
function getArg(name, def) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : def
}

const ROM_PATH   = getArg('--rom',   path.join(ROOT, 'test/roms/Super Mario World (USA).vanilla.sfc'))
const MESEN_PATH = getArg('--mesen', path.join(ROOT, 'test/roms/Mesen.exe'))

// ── ROM parsing (require from compiled JS — run `npm run build` first, or use ts-node) ──
// We inline the critical logic here to avoid TypeScript build dependency.

function loromToOffset(snesAddr, hasHeader) {
  const bank   = (snesAddr >> 16) & 0xFF
  const offset = snesAddr & 0xFFFF
  if (offset < 0x8000) return null  // not ROM
  const fileOffset = (bank & 0x7F) * 0x8000 + (offset & 0x7FFF)
  return fileOffset + (hasHeader ? 512 : 0)
}

function readAt(buf, hasHeader, snesAddr, length) {
  const off = loromToOffset(snesAddr, hasHeader)
  if (off === null || off + length > buf.length) return null
  return buf.slice(off, off + length)
}

function readByte(buf, hasHeader, snesAddr) {
  const b = readAt(buf, hasHeader, snesAddr, 1)
  return b ? b[0] : null
}

const GFX_FGBG_TABLE   = 0x00A92B
const GFX_SPRITE_TABLE = 0x00A8C3
const GFX_BYTES_PER    = 4

function readGfxAssignment(buf, hasHeader, tilesetId, spriteSet) {
  const fg = readAt(buf, hasHeader, GFX_FGBG_TABLE   + tilesetId  * GFX_BYTES_PER, GFX_BYTES_PER)
  const sp = readAt(buf, hasHeader, GFX_SPRITE_TABLE + spriteSet  * GFX_BYTES_PER, GFX_BYTES_PER)
  return {
    fg1: fg?.[0] ?? null, fg2: fg?.[1] ?? null,
    fg3: fg?.[2] ?? null, an1: fg?.[3] ?? null,
    sp1: sp?.[0] ?? null, sp2: sp?.[1] ?? null,
    sp3: sp?.[2] ?? null, sp4: sp?.[3] ?? null,
  }
}

// BGR555 → {r,g,b}
function bgr555(word) {
  return {
    r: (word & 0x1F) << 3,
    g: ((word >> 5) & 0x1F) << 3,
    b: ((word >> 10) & 0x1F) << 3,
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateResult(romBuf, hasHeader, levelCfg, dump) {
  const errors  = []
  const notices = []

  // 1. GFX slot assignment
  const expected = readGfxAssignment(romBuf, hasHeader, levelCfg.tilesetId, levelCfg.spriteSet)
  const actual   = {
    fg1: dump.fg_gfx_files[0], fg2: dump.fg_gfx_files[1],
    fg3: dump.fg_gfx_files[2], an1: dump.fg_gfx_files[3],
    sp1: dump.sp_gfx_files[0], sp2: dump.sp_gfx_files[1],
    sp3: dump.sp_gfx_files[2], sp4: dump.sp_gfx_files[3],
  }

  const slots = ['fg1','fg2','fg3','an1','sp1','sp2','sp3','sp4']
  let gfxOk = true
  for (const slot of slots) {
    if (expected[slot] !== actual[slot]) {
      errors.push(`  GFX ${slot.toUpperCase()}: ROM parser says GFX${(expected[slot]??0).toString(16).toUpperCase().padStart(2,'0')}, Mesen says GFX${(actual[slot]??0).toString(16).toUpperCase().padStart(2,'0')}`)
      gfxOk = false
    }
  }
  if (gfxOk) {
    notices.push(`  GFX slots: OK — FG1=GFX${(actual.fg1).toString(16).toUpperCase().padStart(2,'0')} FG2=GFX${(actual.fg2).toString(16).toUpperCase().padStart(2,'0')} FG3=GFX${(actual.fg3).toString(16).toUpperCase().padStart(2,'0')} AN1=GFX${(actual.an1).toString(16).toUpperCase().padStart(2,'0')}`)
  }

  // 2. CGRAM spot-check: read BG row 0 (16 colors) directly from ROM ($00B0B0)
  //    and compare against what Mesen captured in CGRAM row 0.
  const BG0_ADDR = 0x00B0B0
  const romBg0 = readAt(romBuf, hasHeader, BG0_ADDR, 24)  // 12 colors × 2 bytes
  if (romBg0) {
    let cgOk = true
    // CGRAM row 0 = indices 0–15. ROM stores only colors 1–12 (color 0 is transparent).
    for (let col = 1; col <= 12; col++) {
      const romWord  = romBg0.readUInt16LE((col - 1) * 2)
      const mesenWord = dump.cgram[col]  // CGRAM is 0-indexed: col 0 = color 0
      if (romWord !== mesenWord) {
        const romC   = bgr555(romWord)
        const mesenC = bgr555(mesenWord)
        errors.push(`  CGRAM row 0 color ${col}: ROM=$${romWord.toString(16).padStart(4,'0')} (${romC.r},${romC.g},${romC.b}) Mesen=$${mesenWord.toString(16).padStart(4,'0')} (${mesenC.r},${mesenC.g},${mesenC.b})`)
        cgOk = false
      }
    }
    if (cgOk) notices.push('  CGRAM row 0 (BG palette): OK')
  }

  return { errors, notices }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Verify files exist
  if (!fs.existsSync(ROM_PATH))   { console.error('ROM not found:', ROM_PATH);   process.exit(1) }
  if (!fs.existsSync(MESEN_PATH)) { console.error('Mesen not found:', MESEN_PATH); process.exit(1) }
  if (!fs.existsSync(LEVELS_CFG)) { console.error('levels.json not found:', LEVELS_CFG); process.exit(1) }

  fs.mkdirSync(RESULTS, { recursive: true })

  const levels  = JSON.parse(fs.readFileSync(LEVELS_CFG, 'utf8'))
  const romBuf  = fs.readFileSync(ROM_PATH)
  const hasHeader = (romBuf.length % 1024) === 512

  console.log('SMW ROM Validator')
  console.log('ROM:', ROM_PATH, hasHeader ? '(has copier header)' : '')
  console.log('Levels to validate:', levels.length)
  console.log()

  // Launch Mesen2
  console.log('Launching Mesen2...')
  const mesen = spawn(MESEN_PATH, [ROM_PATH], { detached: true, stdio: 'ignore' })
  mesen.unref()

  console.log()
  console.log('─'.repeat(60))
  console.log('ACTION REQUIRED:')
  console.log('  1. In Mesen2: Debug → Script Window')
  console.log('  2. Load: scripts/validate/validator.lua')
  console.log('  3. Click Run')
  console.log('  The script will warp through', levels.length, 'levels automatically.')
  console.log('─'.repeat(60))
  console.log()
  console.log('Watching for results in:', RESULTS)
  console.log()

  // Watch for output files
  const pending  = new Set(levels.map(l => l.name))
  const resolved = new Set()
  let allPassed  = true

  const checkFile = (filename) => {
    if (!filename.endsWith('.json')) return
    const levelName = filename.replace('.json', '')
    if (!pending.has(levelName) || resolved.has(levelName)) return

    const filePath = path.join(RESULTS, filename)
    try {
      const dump      = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      const levelCfg  = levels.find(l => l.name === levelName)
      if (!levelCfg) return

      const { errors, notices } = validateResult(romBuf, hasHeader, levelCfg, dump)
      resolved.add(levelName)

      const status = errors.length === 0 ? 'PASS' : 'FAIL'
      if (errors.length > 0) allPassed = false

      console.log(`[${status}] ${levelCfg.name ?? levelName}`)
      for (const n of notices) console.log('\x1b[32m' + n + '\x1b[0m')
      for (const e of errors)  console.log('\x1b[31m' + e + '\x1b[0m')
      console.log()

      if (resolved.size === pending.size) {
        console.log('─'.repeat(60))
        console.log(allPassed ? '\x1b[32mAll checks passed.\x1b[0m' : '\x1b[31mSome checks failed — see above.\x1b[0m')
        watcher.close()
        process.exit(allPassed ? 0 : 1)
      }
    } catch (e) {
      // File may still be writing — ignore and wait
    }
  }

  // Also check for any files already present from a previous run
  for (const f of fs.readdirSync(RESULTS)) checkFile(f)

  const watcher = fs.watch(RESULTS, (event, filename) => {
    if (filename) checkFile(filename)
  })

  // Timeout after 5 minutes
  setTimeout(() => {
    console.error('Timeout — not all levels were dumped.')
    console.error('Missing:', [...pending].filter(n => !resolved.has(n)).join(', '))
    watcher.close()
    process.exit(1)
  }, 5 * 60 * 1000)
}

main().catch(e => { console.error(e); process.exit(1) })
