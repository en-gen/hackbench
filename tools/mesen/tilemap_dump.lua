-- tilemap_dump.lua — Find the correct memory type and dump the L1 tilemap.
-- Testing multiple Mesen2 memory type names to find $7E:C800.

local dumped = false

emu.addEventCallback(function()
  if dumped then return end
  local mode = emu.read(0x0100, emu.memType.snesWorkRam)
  if mode ~= 0x14 then return end
  dumped = true

  emu.log("=== Memory Type Test ===")

  -- Read the game mode from $0100 to verify we're reading WRAM correctly
  local modeWR = emu.read(0x0100, emu.memType.snesWorkRam)
  emu.log(string.format("snesWorkRam $0100 = $%02X (should be $14 = in level)", modeWR))

  -- Read translevel from $13BF
  local translevel = emu.read(0x13BF, emu.memType.snesWorkRam)
  emu.log(string.format("Translevel $13BF = $%02X", translevel))

  -- Read screen count from $5D
  local screens = emu.read(0x005D, emu.memType.snesWorkRam)
  if screens == 0 then screens = 1 end
  emu.log(string.format("Screens $5D = %d", screens))

  -- Read tileset
  local tileset = emu.read(0x1931, emu.memType.snesWorkRam)
  emu.log(string.format("Tileset $1931 = %d", tileset))

  -- Test: read $C800 from snesWorkRam (should be $7E:C800 = Map16 tilemap)
  local testC800 = emu.read(0xC800, emu.memType.snesWorkRam)
  emu.log(string.format("snesWorkRam $C800 = $%02X", testC800))

  -- First 16 raw bytes at $C800
  local raw = "RAW snesWorkRam $C800: "
  for i = 0, 15 do
    raw = raw .. string.format("%02X ", emu.read(0xC800 + i, emu.memType.snesWorkRam))
  end
  emu.log(raw)

  -- High bytes at $7F:C800 = snesWorkRam offset $10000 + $C800
  local hiTest = emu.read(0x10000 + 0xC800, emu.memType.snesWorkRam)
  emu.log(string.format("snesWorkRam $1C800 (high byte) = $%02X", hiTest))

  -- Count $25 values in tilemap
  local count25 = 0
  for i = 0, 0x1AF do
    if emu.read(0xC800 + i, emu.memType.snesWorkRam) == 0x25 then
      count25 = count25 + 1
    end
  end
  emu.log(string.format("$25 count in $C800-$C9AF: %d / 432", count25))

  -- Dump grid (low bytes only)
  emu.log("")
  emu.log("GRID (screen 0, low bytes only):")
  for r = 0, 26 do
    local line = string.format("R%02d:", r)
    for c = 0, 15 do
      local offset = r * 16 + c
      local lo = emu.read(0xC800 + offset, emu.memType.snesWorkRam)
      if lo == 0x25 then
        line = line .. " ..."
      else
        line = line .. string.format("  %02X", lo)
      end
    end
    emu.log(line)
  end

  emu.log("DONE")
end, emu.eventType.startFrame)

emu.log("tilemap_dump.lua — enter level $104.")
