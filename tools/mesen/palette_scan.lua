-- palette_scan.lua
-- Waits until in-game (YI1 or any level), then:
--   1. Reads CGRAM rows 0 and 1 (32 bytes, colors 0-15 × 2 bytes each)
--   2. Scans ROM $B0B0-$B1D0 in 24-byte chunks (colors 1-12, skipping color 0)
--   3. Reports which ROM chunk best matches each CGRAM row
-- Run this in Mesen2 (Lua scripting panel) while a level is loaded.

local done = false

local function toHex(v)
  return string.format("%04X", v)
end

local function readCgramRow(rowIdx)
  -- CGRAM is 512 bytes, 2 bytes per color, 16 colors per row
  local base = rowIdx * 32  -- byte offset in CGRAM
  local words = {}
  for c = 0, 15 do
    local lo = emu.read(base + c*2,     emu.memType.cgram)
    local hi = emu.read(base + c*2 + 1, emu.memType.cgram)
    words[c] = lo | (hi << 8)
  end
  return words
end

local function readRomChunk(snesAddr)
  -- Read 24 bytes (12 colors, indices 1-12)
  local words = {}
  for i = 0, 11 do
    local lo = emu.read(snesAddr + i*2,     emu.memType.prgRom)
    local hi = emu.read(snesAddr + i*2 + 1, emu.memType.prgRom)
    words[i+1] = lo | (hi << 8)
  end
  return words
end

local function matchScore(cgram, romChunk)
  -- Compare cgram colors 1-12 with romChunk colors 1-12
  local score = 0
  for i = 1, 12 do
    if cgram[i] == romChunk[i] then score = score + 1 end
  end
  return score
end

local function printRow(label, words)
  local s = label .. ": "
  for i = 0, 15 do
    s = s .. toHex(words[i] or 0) .. " "
  end
  emu.log(s)
end

local function scan()
  -- WRAM $0100 = game mode; 0x11 = in-level, 0x14 = in-level (transition)
  local gameMode = emu.read(0x0100, emu.memType.wram)
  if gameMode ~= 0x11 and gameMode ~= 0x14 then return end
  if done then return end
  done = true

  emu.log("=== PALETTE SCAN ===")
  emu.log("Game mode: " .. string.format("%02X", gameMode))

  local row0 = readCgramRow(0)
  local row1 = readCgramRow(1)
  printRow("CGRAM row0", row0)
  printRow("CGRAM row1", row1)

  -- bgPalette from level RAM ($1925 if available, else try $0D9F)
  local bgPal = emu.read(0x1925, emu.memType.wram)
  emu.log("RAM $1925 (bg palette): " .. string.format("%02X", bgPal))

  -- Scan ROM $B0B0 to $B1D0 in 24-byte steps (each step = one palette row entry)
  emu.log("--- ROM scan $B0B0 to $B1D0 ---")
  local bestAddr0, bestScore0 = 0, -1
  local bestAddr1, bestScore1 = 0, -1

  for offset = 0, 0x120, 0x18 do   -- 0x18 = 24 bytes per entry
    local addr = 0x00B0B0 + offset
    local chunk = readRomChunk(addr)
    local s0 = matchScore(row0, chunk)
    local s1 = matchScore(row1, chunk)

    local line = string.format("$%05X (offset +%03X): row0_match=%d row1_match=%d  [",
      addr, offset, s0, s1)
    for i = 1, 12 do line = line .. toHex(chunk[i]) .. " " end
    line = line .. "]"
    emu.log(line)

    if s0 > bestScore0 then bestScore0 = s0; bestAddr0 = addr end
    if s1 > bestScore1 then bestScore1 = s1; bestAddr1 = addr end
  end

  emu.log(string.format("BEST match for CGRAM row0: $%05X (score %d/12)", bestAddr0, bestScore0))
  emu.log(string.format("BEST match for CGRAM row1: $%05X (score %d/12)", bestAddr1, bestScore1))
  emu.log("=== END ===")
end

emu.addEventCallback(scan, emu.eventType.endFrame)
emu.log("palette_scan.lua loaded — waiting for in-game state...")
