--[[
  SMW ROM Validator — Mesen2 Lua Script

  Warps through a list of SMW levels, dumps CGRAM + GFX slot data per level,
  writes JSON to scripts/validate/results/<levelName>.json.

  Usage:
    1. Open Mesen2 with Super Mario World (USA).sfc
    2. Start any level (or title screen is fine)
    3. Debug → Script Window → load this file → Run
    4. Script runs automatically, exits Mesen2 when done.

  Output files are written relative to the Mesen2 working directory.
  If results land in the wrong place, update OUTPUT_DIR below.
]]

-- ── Config ────────────────────────────────────────────────────────────────────

local OUTPUT_DIR = "scripts/validate/results/"
local WAIT_FRAMES = 240   -- frames to wait after warp before dumping (4 seconds)

-- Levels to validate: translevel numbers + metadata
-- translevel is the value written to $7E:13BF; it selects the level room.
-- Confirmed via Mesen2 $7E:13BF: YI1=0x029
local LEVELS = {
  { name = "yoshis_island_1",  translevel = 0x029, tilesetId = 7, spriteSet = 8 },
  { name = "donut_plains_1",   translevel = 0x006, tilesetId = 2, spriteSet = 2 },
  { name = "vanilla_dome_1",   translevel = 0x014, tilesetId = 5, spriteSet = 5 },
}

-- ── SMW RAM addresses ─────────────────────────────────────────────────────────

local ADDR_GAME_MODE    = 0x0100   -- $7E:0100 — main game mode (we set to level load)
local ADDR_LEVEL_NUM    = 0x13BF   -- $7E:13BF — translevel number
local ADDR_FG_GFX       = 0x0105   -- $7E:0105 — 4 bytes: FG1,FG2,FG3,AN1 GFX file indices
local ADDR_SP_GFX       = 0x0101   -- $7E:0101 — 4 bytes: SP1,SP2,SP3,SP4 GFX file indices

-- ── State machine ─────────────────────────────────────────────────────────────

local state      = "INIT"
local levelIdx   = 1
local frameCount = 0

-- ── Helpers ───────────────────────────────────────────────────────────────────

local function readWorkRam(addr)
  return emu.read(addr, emu.memType.snesWorkRam)
end

local function writeWorkRam(addr, val)
  emu.write(addr, val, emu.memType.snesWorkRam)
end

local function readCgRam(addr)
  return emu.read(addr, emu.memType.snesCgRam)
end

local function readVRam(addr)
  return emu.read(addr, emu.memType.snesVRam)
end

-- Serialize a Lua table to a compact JSON string (no nested tables deeper than 2)
local function toJson(t)
  local parts = {}
  for k, v in pairs(t) do
    local key = '"' .. tostring(k) .. '"'
    local val
    if type(v) == "table" then
      local inner = {}
      for i, x in ipairs(v) do inner[i] = tostring(x) end
      val = "[" .. table.concat(inner, ",") .. "]"
    elseif type(v) == "number" then
      val = tostring(v)
    else
      val = '"' .. tostring(v) .. '"'
    end
    parts[#parts + 1] = key .. ":" .. val
  end
  return "{" .. table.concat(parts, ",") .. "}"
end

-- Dump all relevant data for the current level to a JSON file
local function dumpLevel(level)
  local data = {}
  data["name"]        = level.name
  data["translevel"]  = level.translevel
  data["tilesetId"]   = level.tilesetId
  data["spriteSet"]   = level.spriteSet

  -- GFX slot indices from RAM
  local fg = {}
  for i = 0, 3 do fg[i + 1] = readWorkRam(ADDR_FG_GFX + i) end
  data["fg_gfx_files"] = fg   -- [FG1, FG2, FG3, AN1]

  local sp = {}
  for i = 0, 3 do sp[i + 1] = readWorkRam(ADDR_SP_GFX + i) end
  data["sp_gfx_files"] = sp   -- [SP1, SP2, SP3, SP4]

  -- CGRAM: all 512 bytes as flat array of raw BGR555 words (256 entries)
  local cgram = {}
  for i = 0, 255 do
    local lo = readCgRam(i * 2)
    local hi = readCgRam(i * 2 + 1)
    cgram[i + 1] = lo + hi * 256
  end
  data["cgram"] = cgram

  -- VRAM: chars $000–$0FF (256 tiles × 16 words × 2 bytes = 8192 bytes)
  -- Each char in 4BPP = 16 words. We store raw bytes flat.
  local vram = {}
  for i = 0, 8191 do
    vram[i + 1] = readVRam(i)
  end
  data["vram_chars_000_0ff"] = vram

  -- Write to file
  local path = OUTPUT_DIR .. level.name .. ".json"
  local f = io.open(path, "w")
  if f then
    -- Write manually to avoid huge single-line; fields one per line
    f:write("{\n")
    f:write(string.format('  "name": "%s",\n', data.name))
    f:write(string.format('  "translevel": %d,\n', data.translevel))
    f:write(string.format('  "tilesetId": %d,\n', data.tilesetId))
    f:write(string.format('  "spriteSet": %d,\n', data.spriteSet))

    local fgStr = table.concat(data.fg_gfx_files, ",")
    f:write(string.format('  "fg_gfx_files": [%s],\n', fgStr))

    local spStr = table.concat(data.sp_gfx_files, ",")
    f:write(string.format('  "sp_gfx_files": [%s],\n', spStr))

    local cgramParts = {}
    for _, v in ipairs(data.cgram) do cgramParts[#cgramParts + 1] = tostring(v) end
    f:write(string.format('  "cgram": [%s],\n', table.concat(cgramParts, ",")))

    local vramParts = {}
    for _, v in ipairs(data.vram_chars_000_0ff) do vramParts[#vramParts + 1] = tostring(v) end
    f:write(string.format('  "vram_chars_000_0ff": [%s]\n', table.concat(vramParts, ",")))

    f:write("}\n")
    f:close()
    emu.log("[validator] Wrote " .. path)
  else
    emu.log("[validator] ERROR: could not open " .. path)
  end
end

-- Trigger a level warp by writing the translevel number and forcing a reload.
-- SMW game mode $14 = "Load level". We also write to $13BF so SMW picks it up.
local function warpTo(translevel)
  -- Write the level number to the stack (first 2 bytes = current level in most builds)
  writeWorkRam(0x010B, translevel & 0xFF)
  writeWorkRam(0x010C, (translevel >> 8) & 0xFF)
  -- Write translevel mirror
  writeWorkRam(ADDR_LEVEL_NUM, translevel & 0xFF)
  -- Set game mode to level init ($14 = level load in SMW)
  writeWorkRam(ADDR_GAME_MODE, 0x14)
  emu.log(string.format("[validator] Warping to translevel $%03X", translevel))
end

-- ── Frame callback ────────────────────────────────────────────────────────────

local function onFrame()
  if state == "INIT" then
    -- Kick off first warp on frame 1
    emu.log("[validator] Starting validation run — " .. #LEVELS .. " levels")
    warpTo(LEVELS[levelIdx].translevel)
    frameCount = 0
    state = "WAIT"

  elseif state == "WAIT" then
    frameCount = frameCount + 1
    if frameCount >= WAIT_FRAMES then
      state = "DUMP"
    end

  elseif state == "DUMP" then
    local level = LEVELS[levelIdx]
    emu.log(string.format("[validator] Dumping level %d/%d: %s", levelIdx, #LEVELS, level.name))
    dumpLevel(level)
    levelIdx = levelIdx + 1
    if levelIdx > #LEVELS then
      state = "DONE"
    else
      warpTo(LEVELS[levelIdx].translevel)
      frameCount = 0
      state = "WAIT"
    end

  elseif state == "DONE" then
    emu.log("[validator] All levels dumped. Stopping emulator.")
    emu.removeEventCallback(onFrame, emu.eventType.endFrame)
    emu.stop()
  end
end

emu.addEventCallback(onFrame, emu.eventType.endFrame)
emu.log("[validator] Loaded. Waiting for first frame...")
