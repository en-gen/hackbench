-- tilemap_raw_dump.lua
-- Dumps raw WRAM bytes from the L1 tilemap area ($7E:C800+).
-- Also dumps non-zero bytes to help determine the tilemap layout.
--
-- Usage: Load in Mesen2, enter level $104 (Yoshi's House).
-- Check the script log window for output.

local function hex(v) return string.format("%02X", v) end

local dumped = false

emu.addEventCallback(function()
  if dumped then return end

  local mode = emu.read(0x0100, emu.memType.wram)
  if mode ~= 0x14 then return end
  dumped = true

  local lvlLo = emu.read(0x1925, emu.memType.wram)
  local lvlHi = emu.read(0x1926, emu.memType.wram)
  local levelNum = (lvlHi << 8) | lvlLo
  local screens = emu.read(0x1928, emu.memType.wram) + 1

  emu.log(string.format("Level $%04X, %d screen(s)", levelNum, screens))

  -- Dump all non-zero bytes in the C800-DFFF range (L1 tilemap area, ~6KB)
  -- and separately in the 1C00-1FFF range (high bytes)
  emu.log("")
  emu.log("=== Non-zero bytes in $C800-$D800 (L1 tilemap low bytes) ===")
  local count = 0
  for offset = 0, 0x1000 - 1 do
    local addr = 0xC800 + offset
    local b = emu.read(addr, emu.memType.wram)
    if b ~= 0x25 and b ~= 0x00 then
      emu.log(string.format("  $%04X (+$%04X): $%02X", addr, offset, b))
      count = count + 1
      if count > 500 then
        emu.log("  ... (truncated at 500 entries)")
        break
      end
    end
  end
  emu.log(string.format("Found %d non-empty bytes", count))

  -- Dump the first 512 bytes in hex rows for layout analysis
  emu.log("")
  emu.log("=== First $200 bytes at $C800 (hex dump) ===")
  for row = 0, 31 do
    local addr = 0xC800 + row * 16
    local s = string.format("$%04X: ", addr)
    for col = 0, 15 do
      s = s .. hex(emu.read(addr + col, emu.memType.wram)) .. " "
    end
    emu.log(s)
  end

  -- Also try reading via the [$6B] pointer approach
  -- $6B/$6C is the current column pointer, but only valid during expansion.
  -- Instead, try reading what the game's initial [$6B] would be.
  -- From the handlers: [$6B] points into the tilemap. The initial value
  -- depends on the level mode and screen setup.

  emu.log("")
  emu.log("=== Key WRAM values ===")
  emu.log(string.format("  $005B = $%02X", emu.read(0x005B, emu.memType.wram)))
  emu.log(string.format("  $0057 = $%02X", emu.read(0x0057, emu.memType.wram)))
  emu.log(string.format("  $005A = $%02X", emu.read(0x005A, emu.memType.wram)))
  emu.log(string.format("  $0059 = $%02X", emu.read(0x0059, emu.memType.wram)))
  emu.log(string.format("  $006B = $%02X", emu.read(0x006B, emu.memType.wram)))
  emu.log(string.format("  $006C = $%02X", emu.read(0x006C, emu.memType.wram)))
  emu.log(string.format("  $1925 = $%04X (level number)", levelNum))
  emu.log(string.format("  $1928 = $%02X (screen count - 1)", screens - 1))
  emu.log(string.format("  $1931 = $%02X (tileset ID)", emu.read(0x1931, emu.memType.wram)))
  emu.log(string.format("  $1933 = $%02X", emu.read(0x1933, emu.memType.wram)))
  emu.log(string.format("  $13BF = $%02X (translevel)", emu.read(0x13BF, emu.memType.wram)))

  emu.log("")
  emu.log("=== DONE ===")
end, emu.eventType.startFrame)

emu.log("tilemap_raw_dump.lua loaded. Enter a level to dump. Output goes to script log.")
