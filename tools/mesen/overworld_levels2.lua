-- overworld_levels2.lua
-- Reads the WRAM translevel table during the overworld screen.
-- SMW decompresses the overworld tile/event data into WRAM at runtime.
-- The "translevel" for each overworld event (which level you enter when
-- pressing A) is stored at $7E0D9F and surrounding addresses.
--
-- HOW TO USE:
--   1. Load the script in Mesen2 while on the OVERWORLD screen (not in a level).
--   2. Walk the cursor over every level icon on every sub-map.
--   3. The log will collect unique level numbers as you highlight them.
--   4. After visiting all levels, check the final unique list in the log.
--
-- The level number under the cursor is written to $7E1EA2 (2-byte, LE)
-- each time a new tile is highlighted.

local collected = {}
local count = 0
local lastLevel = -1

local function getGameMode()
  return emu.read(0x0100, emu.memType.wram)
end

local function getCurrentOverworldLevel()
  -- $7E1EA2: 2-byte little-endian level number currently highlighted
  local lo = emu.read(0x1EA2, emu.memType.wram)
  local hi = emu.read(0x1EA3, emu.memType.wram)
  return lo | (hi << 8)
end

emu.addEventCallback(function()
  local mode = getGameMode()
  -- Overworld walking modes: $0E (normal), $0F (entering level), $10 (submap transition)
  if mode < 0x0C or mode > 0x12 then return end

  local lvl = getCurrentOverworldLevel()
  if lvl == lastLevel then return end
  lastLevel = lvl

  -- Sanity check: valid level indices are $000–$1FF
  if lvl > 0x1FF then return end

  if not collected[lvl] then
    collected[lvl] = true
    count = count + 1
    emu.log(string.format("Found level $%03X  (total so far: %d)", lvl, count))
  end
end, emu.eventType.endFrame)

-- Also dump a summary every 300 frames (~5 seconds)
local frameCount = 0
emu.addEventCallback(function()
  frameCount = frameCount + 1
  if frameCount % 300 ~= 0 then return end
  if count == 0 then return end

  local sorted = {}
  for lvl in pairs(collected) do sorted[#sorted+1] = lvl end
  table.sort(sorted)

  local line = string.format("=== %d unique levels found so far ===\n", count)
  local chunk = ""
  for i, v in ipairs(sorted) do
    chunk = chunk .. string.format("$%03X ", v)
    if i % 16 == 0 then line = line .. chunk .. "\n"; chunk = "" end
  end
  if chunk ~= "" then line = line .. chunk end
  emu.log(line)
end, emu.eventType.endFrame)

emu.log("overworld_levels2.lua loaded.")
emu.log("Walk the cursor over every level on every world map.")
emu.log("Level numbers will be logged as you highlight them.")
