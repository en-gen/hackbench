-- wram_diff2.lua
-- Extended snapshot-diff, scanning $D000-$FFFF (high WRAM, bank $7E).
-- SMW decompresses overworld event/translevel data into this range.
-- Also separately watches $1926 (known "current level" address) and $1B7E.
--
-- HOW TO USE:
--   1. On the overworld, stand on one level icon.
--   2. Press SELECT → snapshot A.
--   3. Move to a DIFFERENT level icon, wait for Mario to stop.
--   4. Press SELECT → snapshot B (diff printed).
--   Repeat step 3-4 across several icons.

local SCAN_START = 0xD000
local SCAN_END   = 0xFFFF
local SCAN_LEN   = SCAN_END - SCAN_START + 1

local snapshotA  = nil
local phase      = 0
local lastSelect = 0

-- Specific addresses to always report (not just on diff)
local WATCH = {
  { addr=0x1926, label="$1926 levelNum_lo" },
  { addr=0x1927, label="$1927 levelNum_hi" },
  { addr=0x1B7D, label="$1B7D" },
  { addr=0x1B7E, label="$1B7E" },
  { addr=0x1B7F, label="$1B7F" },
}

local function takeSnapshot()
  local snap = {}
  for i = 0, SCAN_LEN - 1 do
    snap[i] = emu.read(SCAN_START + i, emu.memType.wram) or 0
  end
  return snap
end

local function diffSnapshots(a, b)
  local diffs = {}
  for i = 0, SCAN_LEN - 1 do
    if a[i] ~= b[i] then
      diffs[#diffs+1] = { addr = SCAN_START + i, before = a[i], after = b[i] }
    end
  end
  return diffs
end

local function getGameMode()
  return emu.read(0x0100, emu.memType.wram) or 0
end

local function logWatchAddresses(label)
  local parts = label .. " watch: "
  for _, w in ipairs(WATCH) do
    local v = emu.read(w.addr, emu.memType.wram) or 0
    parts = parts .. string.format("%s=$%02X  ", w.label, v)
  end
  emu.log(parts)
end

emu.addEventCallback(function()
  local mode = getGameMode()
  if mode < 0x0C or mode > 0x12 then return end

  local joyLow  = emu.read(0x0015, emu.memType.wram) or 0
  local selectBtn = (joyLow >> 5) & 1

  if selectBtn == 1 and lastSelect == 0 then
    if phase == 0 then
      snapshotA = takeSnapshot()
      logWatchAddresses("Snapshot A")
      emu.log("=== Snapshot A ($D000-$FFFF). Move to another level icon, press SELECT. ===")
      phase = 1
    else
      local snapB = takeSnapshot()
      logWatchAddresses("Snapshot B")
      local diffs = diffSnapshots(snapshotA, snapB)
      emu.log(string.format("=== %d addresses changed in $D000-$FFFF: ===", #diffs))
      -- Only print first 60 to keep log readable
      for i = 1, math.min(#diffs, 60) do
        local d = diffs[i]
        emu.log(string.format("  $%04X: $%02X → $%02X", d.addr, d.before, d.after))
      end
      if #diffs > 60 then
        emu.log(string.format("  ... and %d more", #diffs - 60))
      end
      emu.log("=== (move to another icon and press SELECT again) ===")
      snapshotA = snapB
    end
  end
  lastSelect = selectBtn
end, emu.eventType.endFrame)

-- Also: watch $1926 every frame for any change
local last1926 = -1
emu.addEventCallback(function()
  local mode = getGameMode()
  if mode < 0x0C or mode > 0x12 then return end
  local lo = emu.read(0x1926, emu.memType.wram) or 0
  local hi = emu.read(0x1927, emu.memType.wram) or 0
  local v = lo | (hi << 8)
  if v ~= last1926 then
    emu.log(string.format("$1926 changed → $%04X (%d)", v, v))
    last1926 = v
  end
end, emu.eventType.endFrame)

emu.log("wram_diff2.lua loaded. Scanning $D000-$FFFF on SELECT presses.")
emu.log("Also watching $1926 every frame for level number changes.")
