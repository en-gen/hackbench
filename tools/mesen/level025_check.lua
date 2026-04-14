-- level025_check.lua
-- Checks the L1 pointer table entry for level $025 and nearby slots,
-- showing the raw bytes so we can diagnose why $025 might be missing from the level list.
--
-- Also scans all 512 slots and prints every unique L1 pointer address found,
-- along with the first slot that claims it (to show dedup behavior).

local function readRomByte(snesAddr)
  return emu.read(snesAddr, emu.memType.prgRom) or 0
end

-- LoROM: banks $00-$3F with $8000-$FFFF → 32KB per bank
-- Convert SNES address to Mesen prgRom offset (linear ROM bytes)
-- prgRom in Mesen is direct ROM file offset (no SNES mapping needed for emu.read with prgRom type)
-- Actually emu.read with prgRom type uses the SNES address directly.

local LEVEL_L1_LOW  = 0x05E000
local LEVEL_L1_HIGH = 0x05E200
local LEVEL_L1_BANK = 0x05E400

local function getL1Pointer(index)
  local lo = readRomByte(LEVEL_L1_LOW  + index)
  local hi = readRomByte(LEVEL_L1_HIGH + index)
  local bk = readRomByte(LEVEL_L1_BANK + index)
  return (bk << 16) | (hi << 8) | lo, bk, hi, lo
end

local function getL1Bytes(ptr, count)
  local bytes = {}
  for i = 0, count - 1 do
    bytes[i] = emu.read(ptr + i, emu.memType.prgRom) or 0xFF
  end
  return bytes
end

local function hex2(v) return string.format("%02X", v) end
local function hex6(v) return string.format("%06X", v) end

emu.log("=== LEVEL POINTER CHECK ===")

-- Check a range of levels around $025
emu.log("\n--- Slots near $025 ---")
for idx = 0x020, 0x030 do
  local ptr, bk, hi, lo = getL1Pointer(idx)
  local b = getL1Bytes(ptr, 8)
  local levelMode = b[1] & 0x1F
  local levelLength = b[0] & 0x1F
  local firstObj = b[5]
  local marker = ""
  if idx == 0x025 then marker = " <--- THIS ONE" end
  emu.log(string.format("  $%03X: ptr=$%06X bk=%s hi=%s lo=%s  header[0-4]=%s %s %s %s %s  mode=%d len=%d obj[5]=%s%s",
    idx, ptr, hex2(bk), hex2(hi), hex2(lo),
    hex2(b[0]), hex2(b[1]), hex2(b[2]), hex2(b[3]), hex2(b[4]),
    levelMode, levelLength, hex2(firstObj), marker))
end

-- Full dedup scan: find which slot FIRST claims each unique pointer
emu.log("\n--- Dedup scan (all 512 slots) ---")
local seenPtrs = {}
local uniqueCount = 0
local slot025WouldShow = false

for idx = 0, 0x1FF do
  local ptr = getL1Pointer(idx)
  if ptr ~= 0 then
    local b = getL1Bytes(ptr, 8)
    local levelMode = b[1] & 0x1F
    local firstObj = b[5]
    local passesFilter = (levelMode <= 20) and (firstObj ~= 0xFF)

    if passesFilter then
      if not seenPtrs[ptr] then
        seenPtrs[ptr] = idx
        uniqueCount = uniqueCount + 1
        if idx == 0x025 then slot025WouldShow = true end
      else
        -- This slot is deduplicated away
        if idx == 0x025 then
          emu.log(string.format("  $025 is DEDUPLICATED: same ptr $%06X already claimed by slot $%03X",
            ptr, seenPtrs[ptr]))
        end
      end
    else
      if idx == 0x025 then
        emu.log(string.format("  $025 FILTERED OUT: mode=%d firstObj=$%02X  ptr=$%06X",
          levelMode, firstObj, ptr))
      end
    end
  else
    if idx == 0x025 then
      emu.log("  $025: ptr is zero or null")
    end
  end
end

if slot025WouldShow then
  emu.log("  $025 would appear in the list (passed filter, unique ptr).")
end
emu.log(string.format("\nTotal unique levels after dedup: %d", uniqueCount))
emu.log("=== END ===")
