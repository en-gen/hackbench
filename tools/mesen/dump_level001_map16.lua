-- Mesen 2 Lua script — dump Layer 1 Map16 tile IDs for the current level.
--
-- IMPORTANT: SMW streams Map16 tile data into RAM as the camera scrolls.
-- Only the ON-SCREEN WINDOW (and a small buffer) is guaranteed fresh; anything
-- further away may be stale or uninitialized. The script prints the current
-- camera X so we can tell which columns in the output are trustworthy.
--
-- Usage:
--   1. Load vanilla SMW, enter the level, let it settle.
--   2. Position the camera over the region you want to capture.
--   3. Tools → Script Window → open this file → Run.
--   4. Repeat from different camera positions until you've covered the level.
--   5. Paste each log into Claude — the camera-X header lets us stitch them.
--
-- RAM layout (from smw-memory-map-full.md + SMW_U.sym):
--   $7EC800  Map16TilesLow   (14336 bytes)
--   $7FC800  Map16TilesHigh  (14336 bytes; only bit 0 = page flag)
--   Per screen: $1B0 bytes = 16 cols × 27 rows, row-major.
--   tile_id = ((high_byte & 1) << 8) | low_byte
--
-- SMW status RAM used for the header (from smw-ram-map.md):
--   $7E:0013BF  Translevel number (1 byte)
--   $7E:001A/1B Camera X position, low/high (2 bytes; pixel coordinate)
--   $7E:001C/1D Camera Y position, low/high
--   One Map16 tile = 16 pixels, so camera_col = camera_x / 16.

local ROW_START = 12
local ROW_END   = 26   -- exclusive
local COL_END   = 80   -- exclusive (screens 0..4)
local BYTES_PER_SCREEN = 0x1B0
local BYTES_PER_ROW    = 0x10
local MEM = emu.memType.snesMemory

local function r(addr) return emu.read(addr, MEM, true) end

local function tileIdAt(col, row)
  local screen      = math.floor(col / 16)
  local colInScreen = col % 16
  local offset      = screen * BYTES_PER_SCREEN + row * BYTES_PER_ROW + colInScreen
  local lo          = r(0x7EC800 + offset)
  local hi          = r(0x7FC800 + offset)
  return ((hi % 2) * 256) + lo
end

local function dump()
  local translevel = r(0x7E13BF)
  local cameraX    = r(0x7E001A) + r(0x7E001B) * 256
  local cameraY    = r(0x7E001C) + r(0x7E001D) * 256
  local cameraCol  = math.floor(cameraX / 16)
  local cameraRow  = math.floor(cameraY / 16)
  -- SMW typically keeps the current screen + ~1 screen on each side loaded.
  -- Use a conservative "trust window" of +/- 16 cols from cameraCol.
  local trustLo = math.max(0, cameraCol - 2)
  local trustHi = cameraCol + 18

  emu.log(string.format("=== Translevel $%02X  camera=(px %d,%d) = Map16 col %d row %d  trust-window cols %d..%d ===",
    translevel, cameraX, cameraY, cameraCol, cameraRow, trustLo, trustHi))

  -- column header every 8 cols
  local hdr = "      "
  for c = 0, COL_END - 1 do
    if (c % 8) == 0 then
      hdr = hdr .. string.format("%3d ", c)
    else
      hdr = hdr .. "    "
    end
  end
  emu.log(hdr)

  for row = ROW_START, ROW_END - 1 do
    local line = string.format("r%2d: ", row)
    for col = 0, COL_END - 1 do
      local id = tileIdAt(col, row)
      if id == 0x25 then
        line = line .. " .  "
      else
        line = line .. string.format("%03x ", id)
      end
    end
    emu.log(line)
  end

  emu.log("=== end ===")
end

dump()
