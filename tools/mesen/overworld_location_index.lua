-- overworld_location_index.lua
-- Tracks $7E0DFB and nearby bytes each frame during overworld mode.
-- $0DFB changed between 0x0B and 0x02 in the WRAM diff, suggesting it may be
-- the current overworld location index (indexing into the 96-entry tables at
-- $7E13BF and $7E1EA2).
--
-- If this IS the location index, then:
--   translevel = WRAM[$7E13BF + index * entrySize + offset_of_translevel]
--
-- Also watches the 96-byte flags table at $7E1EA2 and the location table $7E13BF.
--
-- HOW TO USE:
--   1. Load on the overworld screen.
--   2. Walk Mario to several different level icons (wait ~1 sec on each).
--   3. Check the log — the address that prints a different small integer for
--      each level icon you stand on IS the location index.

local BASE_FLAGS = 0x1EA2
local BASE_LOC   = 0x13BF

local function rb(addr) return emu.read(addr, emu.memType.wram) or 0 end
local function getMode() return rb(0x0100) end

-- Watch these addresses each frame
local candidates = {
  0x0DFA, 0x0DFB, 0x0DFC,
  0x0DC6, 0x0DC7,           -- Mario overworld X tile
  0x0DC8, 0x0DC9,           -- Mario overworld Y tile
  0x1B7E, 0x1B7F,
  0x1F1E, 0x1F1F,
}
local lastVals = {}
for _, addr in ipairs(candidates) do lastVals[addr] = rb(addr) end

local lastMode = -1
local locationLog = {}

emu.addEventCallback(function()
  local mode = getMode()
  if mode < 0x0C or mode > 0x12 then return end

  -- Check candidates for changes
  for _, addr in ipairs(candidates) do
    local v = rb(addr)
    if v ~= lastVals[addr] then
      emu.log(string.format("  $%04X: $%02X → $%02X  (mode $%02X)", addr, lastVals[addr], v, mode))
      lastVals[addr] = v
    end
  end

  -- Every 90 frames (~1.5s) log the current state
end, emu.eventType.endFrame)

-- Separate callback: on mode change entering overworld, dump the location table
emu.addEventCallback(function()
  local mode = getMode()
  if mode == lastMode then return end
  lastMode = mode

  if mode < 0x0C or mode > 0x12 then return end
  emu.log(string.format("=== Overworld mode $%02X ===", mode))

  -- Dump $0DFA-$0E00
  local s = "  $0DF0-$0DFF: "
  for i = 0, 15 do s = s .. string.format("%02X ", rb(0x0DF0 + i)) end
  emu.log(s)

  -- Check what's at $13BF[0DFB-value * stride] for common strides
  local idx = rb(0x0DFB)
  emu.log(string.format("  $0DFB = %d (0x%02X)", idx, idx))
  for stride = 1, 8 do
    local addr = BASE_LOC + idx * stride
    local s2 = string.format("  $13BF + %d*%d = $%04X: ", idx, stride, addr)
    for i = 0, 5 do s2 = s2 .. string.format("%02X ", rb(addr + i)) end
    emu.log(s2)
  end
end, emu.eventType.startFrame)

-- Periodic dump: every 180 frames, log current $0DFB and the flag byte it would index
local frameCount = 0
emu.addEventCallback(function()
  local mode = getMode()
  if mode < 0x0C or mode > 0x12 then return end
  frameCount = frameCount + 1
  if frameCount % 180 ~= 0 then return end

  local idx = rb(0x0DFB)
  local flag = rb(BASE_FLAGS + idx)
  emu.log(string.format("  [periodic] $0DFB=%d → flag[$7E1EA2+%d]=$%02X  (beaten=%s midway=%s)",
    idx, idx, flag,
    ((flag & 0x80) ~= 0) and "YES" or "no",
    ((flag & 0x40) ~= 0) and "YES" or "no"))

  -- Also check $13BF at this index with stride 2 and stride 3 (common entry sizes)
  for stride = 2, 5 do
    local addr = BASE_LOC + idx * stride
    local b0 = rb(addr)
    local b1 = rb(addr + 1)
    emu.log(string.format("    $13BF[%d*%d]=$%04X: %02X %02X (as LE word: $%04X)",
      idx, stride, addr, b0, b1, b0|(b1<<8)))
  end
end, emu.eventType.endFrame)

emu.log("overworld_location_index.lua loaded.")
emu.log("Walk to different level icons. Changes at candidate addresses will be logged.")
emu.log("Every 3s: reports $0DFB value and what it would index in the location tables.")
