-- Mesen 2 Lua: WRAM trace for finding the "current sublevel" RAM address.
--
-- Dumps candidate regions of $7E WRAM to a text file every SAMPLE_EVERY
-- frames while in live level play. Then an offline analyzer diffs samples
-- from main-area periods vs sub-area periods to find the byte positions
-- that stably differ between the two.
--
-- Usage
--   1. Set OUT_PATH below if desired.
--   2. Open in Mesen Script Window → Run.
--   3. Enter main area (e.g. $106). Let a few samples fire.
--   4. Pipe into sub-area ($1CD). Let a few samples fire.
--   5. Exit back. Repeat main↔sub a few times so we have multiple
--      same-session readings on both sides.
--   6. Stop script. Analyze `ram_trace.txt` offline:
--        python tools/scripts/analyze_ram_trace.py tools/mesen/ram_trace.txt
--
-- Trace format: one block per sample, with a header line + one hex-dump
-- line per named range. Non-level-play samples are tagged so the analyzer
-- can segment by "level session".

local OUT_PATH     = "C:/Projects/frontend/tools/mesen/ram_trace.txt"
local SAMPLE_EVERY = 30   -- frames between samples (~2 Hz at 60 fps)

local MEM = emu.memType.snesMemory
local function r(addr) return emu.read(addr, MEM) end

-- Candidate ranges, kept deliberately broad. These cover the zeropage
-- pointers ($65-67, $68-6A), the classic "level number" cluster at $0100-01FF,
-- plus the $13xx and $17xx blocks where TranslevelNo, SublevelCount, and
-- LoadingLevelNumber live.
local RANGES = {
  { "zp",     0x7E0000, 0x7E00FF },  -- zero page (incl. Layer1/2 DataPtr at $65-6A)
  { "r0100",  0x7E0100, 0x7E01FF },  -- GameMode + level scratch
  { "r1300",  0x7E1300, 0x7E14FF },  -- TranslevelNo, SublevelCount
  { "r1700",  0x7E1700, 0x7E18FF },  -- LoadingLevelNumber area
  { "r1E00",  0x7E1E00, 0x7E1EFF },  -- ExitTables etc.
}

local file, err = io.open(OUT_PATH, "w")
if not file then
  emu.log("ram_trace: io.open failed: " .. tostring(err))
  return
end
file:write("# SMW RAM trace\n")
file:write(string.format("# sample_every=%d frames\n", SAMPLE_EVERY))
for _, range in ipairs(RANGES) do
  file:write(string.format("# range %-6s $%06X..$%06X (%d bytes)\n",
    range[1], range[2], range[3], range[3] - range[2] + 1))
end
file:write("#\n")
file:write("# Per-sample format:\n")
file:write("#   === sample N frames=F gameMode=GM ===\n")
file:write("#   <range>: XX XX XX XX ...\n")
file:write("#\n")
file:flush()

local frames  = 0
local samples = 0

local function onFrame()
  frames = frames + 1
  if frames % SAMPLE_EVERY ~= 0 then return end
  samples = samples + 1

  local gameMode = r(0x7E0100)
  file:write(string.format("\n=== sample %d  frames=%d  gameMode=%02X ===\n",
    samples, frames, gameMode))
  for _, range in ipairs(RANGES) do
    local name, start, stop = range[1], range[2], range[3]
    local parts = { name .. ":" }
    for a = start, stop do
      parts[#parts+1] = string.format("%02X", r(a))
    end
    file:write(table.concat(parts, " "))
    file:write("\n")
  end
  file:flush()

  emu.drawString(8, 8,  string.format("RAM TRACE  sample=%d", samples), 0xFFFFFF, 0x000000)
  emu.drawString(8, 18, string.format("gameMode=%02X  frames=%d", gameMode, frames), 0xFFFFFF, 0x000000)
end

emu.addEventCallback(onFrame, emu.eventType.endFrame)
emu.log("ram_trace started: " .. OUT_PATH)
