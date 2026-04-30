-- Mesen 2 Lua: Layer 2 ground-truth recorder.
--
-- Designed to run alongside `l1_dump.lua` (L1 fixture pipeline) and
-- `l3_dump.lua`. Mesen 2 supports multiple loaded scripts simultaneously and
-- frame numbers are emulator-global, so frame N in this script's CSV refers
-- to the same emulator frame as the L1/L3 dumps.
--
-- HUD row convention (avoid overlapping other capture scripts):
--   l1_dump.lua → top of screen (existing)
--   l2_dump.lua     → row Y=20  ← THIS SCRIPT
--   l3_dump.lua     → row Y=30
--
-- Outputs (under the same OneDrive `maps/<id>/` folder as L1 dumps):
--   <id>/l2_scroll.csv     per-frame Layer2XPos / Layer2YPos
--   <id>/l2_tilemap.bin    1024 bytes of Layer2TilemapLow, captured once
--                          on level-entry (matches l1_dump workflow — no
--                          manual hotkey)
--   <id>/l2_tilemap.json   sidecar describing the slice
--
-- Controls: none. Capture starts when game-mode hits $14 (Level play) and
-- closes when it leaves. Same convention as l1_dump.lua.
--
-- ROM addresses (verified against C:\Projects\SMWDisX\rammap.asm):
--   Layer2XPos       = $7E:001E   (rammap.asm:166)
--   Layer2YPos       = $7E:0020   (rammap.asm:172)
--   Layer2TilemapLow = $7E:B900   (rammap.asm:2094, derived: $7E2000 +
--                                  MarioGraphics(23808=$5D00) +
--                                  AnimatedTiles(15360=$3C00) = $7EB900)
--
-- Workflow:
--   1. Load this in Mesen's Script window alongside l1_dump.lua.
--   2. Enter a level. Per-frame CSV starts on game-mode → $14.
--   3. Optional: hit F2 to snapshot the L2 tilemap once positioned.
--   4. Leaving the level closes the CSV. Re-entering opens a new file.

-- OneDrive-synced fixture root, mirrors l1_dump.lua. Per-level subfolder
-- is created on demand so L1/L2/L3 artifacts for the same level live in
-- one place.
local DUMPS_DIR = "C:/Users/engenb/OneDrive/hackbench-fixtures/maps"
local HUD_ROW   = 20  -- HUD-row convention (see header)

local MEM = emu.memType.snesMemory
-- WRAM-direct memType (mirrors Mesen Memory Viewer "Work RAM" view). Some
-- rapidly-changing values may differ between snesMemory bus reads at
-- endFrame and the live WRAM state — capturing both lets us spot the gap.
local WRAM_MEM = nil
for _, name in ipairs({ "snesWorkRam", "snesWorkRAM", "workRam", "wram" }) do
  local v = emu.memType[name]
  if v ~= nil then WRAM_MEM = v; break end
end

local function r(addr) return emu.read(addr, MEM) end
local function rWramByte(addr)
  if WRAM_MEM == nil then return r(addr) end
  return emu.read(addr - 0x7E0000, WRAM_MEM)
end
local function rWramWord(addr)
  if WRAM_MEM == nil then return r(addr) + r(addr+1)*256 end
  local off = addr - 0x7E0000
  return emu.read(off, WRAM_MEM) + emu.read(off + 1, WRAM_MEM) * 256
end

-- ── Address constants ─────────────────────────────────────────────────────
local LAYER1_XPOS_LO  = 0x7E001A   -- camera X (rammap.asm)
local LAYER1_YPOS_LO  = 0x7E001C   -- camera Y (rammap.asm:160)
local LAYER2_XPOS_LO  = 0x7E001E
local LAYER2_YPOS_LO  = 0x7E0020
local LAYER2_TILEMAP  = 0x7EB900   -- 1024 bytes
local LAYER2_TILEMAP_BYTES = 1024

local TRANSLEVEL_LO   = 0x7E13BF
local TRANSLEVEL_HI   = 0x7E13C0
local L1PTR_LO        = 0x7E0065
local L1PTR_HI        = 0x7E0066
local L1PTR_BK        = 0x7E0067
local GAME_MODE       = 0x7E0100
local GM_LEVEL        = 0x14

-- ── Helpers ──────────────────────────────────────────────────────────────
local function readWord(loAddr) return r(loAddr) + r(loAddr + 1) * 256 end

-- Map-id we tag dumps with. TranslevelNo when present (overworld-entered);
-- otherwise a hash of L1Ptr (catches sub-areas without rebuilding the L1
-- pointer-table cache). User can rename files afterward if a sublevel needs
-- a more specific id; this just gives stable per-room separation.
local function currentMapId()
  local tl = readWord(TRANSLEVEL_LO)
  if tl ~= 0 then
    if tl >= 0x25 then return (tl - 0x24) + 0x100 end
    return tl
  end
  local key = r(L1PTR_BK) * 0x10000 + r(L1PTR_HI) * 0x100 + r(L1PTR_LO)
  return key  -- raw 24-bit pointer; user renames if needed
end

local function mapIdStr(id)
  if id < 0x1000 then return string.format("%03x", id) end
  return string.format("p%06x", id)  -- "p" prefix marks a raw L1Ptr fallback
end

-- ── State ────────────────────────────────────────────────────────────────
local csvFile        = nil
local currentMap     = nil
local frame          = 0
local framesInLevel  = 0
local snapshotFlash  = 0   -- frames left to flash "saved tilemap" message

local function levelDir(id) return DUMPS_DIR .. "/" .. mapIdStr(id) end
local function ensureDir(dir)
  pcall(os.execute, string.format('if not exist "%s" mkdir "%s"',
    dir:gsub("/", "\\"), dir:gsub("/", "\\")))
end
local function csvPath(id)  return levelDir(id) .. "/l2_scroll.csv" end
local function binPath(id)  return levelDir(id) .. "/l2_tilemap.bin" end
local function jsonPath(id) return levelDir(id) .. "/l2_tilemap.json" end

local function openCsv(id)
  if csvFile then csvFile:close() end
  ensureDir(levelDir(id))
  local f, err = io.open(csvPath(id), "w")
  if not f then
    emu.log(string.format("[l2_dump] failed to open %s: %s", csvPath(id), tostring(err)))
    csvFile = nil
    return
  end
  f:write("frame,l2x,l2y,l2y_wram,l2y_lastWrite,l2y_writeCount,l1x,l1y\n")
  csvFile = f
  framesInLevel = 0
  emu.log(string.format("[l2_dump] opened %s", csvPath(id)))
end

local function closeCsv()
  if csvFile then
    csvFile:close()
    csvFile = nil
  end
end

local function snapshotTilemap(id)
  -- Read 1024 bytes of Layer2TilemapLow as raw binary.
  local bytes = {}
  for i = 0, LAYER2_TILEMAP_BYTES - 1 do
    bytes[i + 1] = string.char(r(LAYER2_TILEMAP + i))
  end
  local bin = io.open(binPath(id), "wb")
  if not bin then
    emu.log(string.format("[l2_dump] failed to open %s for write", binPath(id)))
    return false
  end
  bin:write(table.concat(bytes))
  bin:close()

  local jsn = io.open(jsonPath(id), "w")
  if jsn then
    jsn:write(string.format(
      '{"map":"$%s","source":"Layer2TilemapLow","snesAddr":"$7E:B900",' ..
      '"bytes":%d,"frame":%d,"l2x":%d,"l2y":%d,"note":"32x32 BG2 Map16-low byte grid"}\n',
      mapIdStr(id), LAYER2_TILEMAP_BYTES, framesInLevel,
      readWord(LAYER2_XPOS_LO), readWord(LAYER2_YPOS_LO)))
    jsn:close()
  end
  emu.log(string.format("[l2_dump] snapshot saved: %s", binPath(id)))
  return true
end

-- ── HUD ──────────────────────────────────────────────────────────────────
local COLOR_ON   = 0x88FFAA  -- soft green = capturing
local COLOR_IDLE = 0x808080  -- grey = waiting / not in level
local COLOR_FLASH = 0xFFEE66  -- yellow = snapshot just saved

local function drawHud()
  local gm = r(GAME_MODE)
  local inLevel = (gm == GM_LEVEL) and (csvFile ~= nil)
  local mapStr  = currentMap and mapIdStr(currentMap) or "----"
  local color, msg
  if snapshotFlash > 0 then
    color = COLOR_FLASH
    msg = string.format("[L2] map $%s -- saved tilemap", mapStr)
    snapshotFlash = snapshotFlash - 1
  elseif inLevel then
    color = COLOR_ON
    msg = string.format("[L2] map $%s -- cap on (frame %d)", mapStr, framesInLevel)
  else
    color = COLOR_IDLE
    msg = "[L2] idle (waiting for level)"
  end
  emu.drawString(8, HUD_ROW, msg, color, 0x000000)
  -- Live read of $7E:0020 alongside emu.read at endFrame, so the user can
  -- compare against Mesen's Memory Viewer at the same instant.
  if inLevel then
    local liveL2Y = readWord(LAYER2_YPOS_LO)
    emu.drawString(8, HUD_ROW + 30, string.format(
      "[L2] Lua: l2y=$%02X writes=%d  (compare to Mem Viewer @\\$7E:0020)",
      liveL2Y, _G.l2yWriteCount or 0),
      0xFFFFAA, 0x000000)
  end
end

-- ── Main loop ────────────────────────────────────────────────────────────
local function onFrame()
  frame = frame + 1
  local gm = r(GAME_MODE)

  if gm == GM_LEVEL then
    local id = currentMapId()
    local entered = (csvFile == nil) or (id ~= currentMap)
    if entered then
      currentMap = id
      openCsv(id)
      -- Snapshot the L2 tilemap once on level-entry. Wait one frame so the
      -- game-mode-$14 transition completes its tilemap setup before we
      -- read; in practice the tilemap is ready as of the first $14 frame
      -- but a small flash here gives visual feedback regardless.
      if snapshotTilemap(currentMap) then snapshotFlash = 60 end
    end
    if csvFile then
      framesInLevel = framesInLevel + 1
      csvFile:write(string.format("%d,%d,%d,%d,%d,%d,%d,%d\n",
        framesInLevel,
        readWord(LAYER2_XPOS_LO),
        readWord(LAYER2_YPOS_LO),       -- via snesMemory (CPU bus)
        rWramWord(LAYER2_YPOS_LO),      -- via WRAM-direct
        _G.lastL2YWrite,                -- last write observed via callback
        _G.l2yWriteCount,               -- total writes since script load
        readWord(LAYER1_XPOS_LO),       -- camera X (auto-scrollers move it)
        readWord(LAYER1_YPOS_LO)))      -- camera Y
    end
  else
    -- Left the level: close the CSV so the next entry opens a fresh one.
    if csvFile ~= nil then
      emu.log(string.format("[l2_dump] closed (gameMode=%02X)", gm))
      closeCsv()
      currentMap = nil
    end
  end

  drawHud()
end

emu.addEventCallback(onFrame, emu.eventType.endFrame)

-- ── Write trace on $7E:0020 (Layer2YPos low byte) ────────────────────────
-- Mirror of l3_dump's tide diagnostic. Captures every CPU write to
-- $7E:0020 along with the value, surfaced in the per-frame CSV.
_G.lastL2YWrite  = -1
_G.l2yWriteCount = 0
local writeCallbackOk = false
local function onLayer2YPosWrite(addr, value)
  _G.lastL2YWrite = value
  _G.l2yWriteCount = _G.l2yWriteCount + 1
end
local writeCallbackTypes = {
  emu.callbackType and emu.callbackType.cpuWrite,
  emu.callbackType and emu.callbackType.write,
  emu.memCallbackType and emu.memCallbackType.cpuWrite,
  emu.memCallbackType and emu.memCallbackType.write,
}
for _, t in ipairs(writeCallbackTypes) do
  if t ~= nil then
    local ok = pcall(emu.addMemoryCallback, onLayer2YPosWrite, t, 0x7E0020)
    if ok then writeCallbackOk = true; break end
  end
end

emu.log(string.format("[l2_dump] ready -- HUD row 20 -- auto-snapshot on level entry -- wramMem=%s writeTrace=%s",
  WRAM_MEM == nil and "<UNRESOLVED>" or tostring(WRAM_MEM),
  writeCallbackOk and "ON" or "<UNAVAILABLE>"))
