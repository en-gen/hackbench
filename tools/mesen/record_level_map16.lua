-- Mesen 2 Lua: incremental Map16 fixture recorder (file-backed).
--
-- Writes dumps directly to a file on disk via Lua io. This bypasses the
-- Mesen Script Window log-buffer size limit (which truncates earlier
-- ticks when logs get long). An on-screen countdown tells you when the
-- next tick fires.
--
-- Usage:
--   1. Edit OUT_PATH below to wherever you want the file written.
--   2. Load SMW, enter level $001 (or any horizontal level), let fade-in finish.
--   3. Open this script in Mesen Script Window. Run.
--   4. Let one tick fire at spawn so the beginning is captured.
--   5. Walk Mario left-to-right at steady pace.
--   6. Keep going past the goal or end-of-level.
--   7. Stop the script. The file on disk has the full log.

local OUT_PATH    = "C:/Projects/frontend/tools/mesen/level_001_dumps.txt"
local TICK_FRAMES = 180   -- 3 seconds @ 60 fps between dumps
local LEFT_PAD    = 8
local RIGHT_PAD   = 20
local ROW_LO      = 0
local ROW_HI      = 26
local BYTES_PER_SCREEN = 0x1B0
local BYTES_PER_ROW    = 0x10

local MEM = emu.memType.snesMemory
local function r(addr) return emu.read(addr, MEM) end

-- Open for write (truncate). Fallback to emu.log if io is restricted.
local file, errmsg = io.open(OUT_PATH, "w")
local writeLine
if file then
  writeLine = function(s)
    file:write(s)
    file:write("\n")
  end
  emu.log("recording to file: " .. OUT_PATH)
else
  emu.log("io.open failed (" .. tostring(errmsg) .. "), falling back to log")
  writeLine = function(s) emu.log(s) end
end

local frames  = 0
local tickNum = 0

local function tileAt(col, row)
  local screen = col // 16
  local cs     = col % 16
  local off    = screen * BYTES_PER_SCREEN + row * BYTES_PER_ROW + cs
  return ((r(0x7FC800 + off) % 2) * 256) + r(0x7EC800 + off)
end

local function dumpAroundCol(marioCol)
  tickNum = tickNum + 1
  local lo = math.max(0, marioCol - LEFT_PAD)
  local hi = marioCol + RIGHT_PAD
  writeLine(string.format("=== tick %d  marioCol=%d  range=%d..%d ===",
    tickNum, marioCol, lo, hi))
  for row = ROW_LO, ROW_HI do
    local line = string.format("r%2d:", row)
    for col = lo, hi do
      local id = tileAt(col, row)
      if id == 0x25 then line = line .. " .  "
      else line = line .. string.format("%03x ", id) end
    end
    writeLine(line)
  end
  if file then file:flush() end
end

local function onFrame()
  frames = frames + 1
  local marioX   = r(0x7E0094) + r(0x7E0095) * 256
  local marioCol = marioX // 16
  local remaining = TICK_FRAMES - (frames % TICK_FRAMES)
  local secs = math.ceil(remaining / 60)

  emu.drawString(8, 8,  string.format("DUMP IN %ds", secs), 0xFFFFFF, 0x000000)
  emu.drawString(8, 18, string.format("col=%d tick=%d", marioCol, tickNum), 0xFFFFFF, 0x000000)

  if frames % TICK_FRAMES == 0 then
    dumpAroundCol(marioCol)
  end
end

emu.addEventCallback(onFrame, emu.eventType.endFrame)
writeLine(string.format("# recorder start  tick_frames=%d  out=%s", TICK_FRAMES, OUT_PATH))
if file then file:flush() end
