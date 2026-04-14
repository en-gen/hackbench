-- overworld_levels.lua
-- Reads the overworld exit-path destination tables from ROM (no game state needed).
-- These tables list the level slot index that each overworld exit path leads to.
--
-- ROM addresses (LoROM, bank $04):
--   $0499AA  Main exit path destinations (each byte = level index)
--   $0499F0  Extra exit path destinations
--
-- Run this in Mesen2 — the output appears immediately in the script log.
-- The unique level indices found = the set of overworld-accessible levels.

local function readRomByte(snesAddr)
  return emu.read(snesAddr, emu.memType.prgRom)
end

-- Read a contiguous block from ROM, stopping at 0xFF or maxLen
local function readTable(startAddr, maxLen)
  local entries = {}
  for i = 0, maxLen - 1 do
    local v = readRomByte(startAddr + i)
    if v == nil then break end
    entries[#entries + 1] = v
  end
  return entries
end

emu.log("=== OVERWORLD LEVEL SCAN ===")

-- Main exit path destination table: $0499AA
-- Size: $0499F0 - $0499AA = $46 = 70 bytes
local mainTable  = readTable(0x0499AA, 70)

-- Extra exit path destinations: $0499F0, scan up to 64 bytes
local extraTable = readTable(0x0499F0, 64)

-- Collect all unique level indices from both tables
local seen = {}
local unique = {}

local function addEntries(tbl, label)
  local hex = label .. ": "
  for _, v in ipairs(tbl) do
    hex = hex .. string.format("%02X ", v)
    if not seen[v] then
      seen[v] = true
      unique[#unique + 1] = v
    end
  end
  emu.log(hex)
end

addEntries(mainTable,  "Main  $0499AA")
addEntries(extraTable, "Extra $0499F0")

table.sort(unique)

emu.log(string.format("Unique level indices (%d total):", #unique))
local line = ""
for i, v in ipairs(unique) do
  line = line .. string.format("$%03X ", v)
  if i % 16 == 0 then emu.log(line); line = "" end
end
if line ~= "" then emu.log(line) end

emu.log("=== END ===")
