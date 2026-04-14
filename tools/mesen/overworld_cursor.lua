-- overworld_cursor.lua
-- Tracks the level number under the overworld cursor as the player moves.
--
-- SMW WRAM addresses for overworld cursor state:
--   $7E1F11  (2-byte LE) — "Mario position" overworld tile number (tile under cursor)
--   $7E0D9F  (2-byte LE) — translevel for the highlighted exit (level index to enter)
--   $7E1EA2  was tested and does NOT update — that address is incorrect
--
-- Strategy: watch several candidate addresses each frame and log any that change.
-- Once we identify the right one, we can use it for the definitive level list.

local candidates = {
  -- format: { addr, label, lastVal }
  { addr=0x0D9F, label="$0D9F" },
  { addr=0x0DA0, label="$0DA0" },
  { addr=0x1F11, label="$1F11" },
  { addr=0x1F12, label="$1F12" },
  { addr=0x0DBF, label="$0DBF" },
  { addr=0x0DC0, label="$0DC0" },
  { addr=0x1EA0, label="$1EA0" },
  { addr=0x1EA1, label="$1EA1" },
  { addr=0x1EA2, label="$1EA2" },
  { addr=0x1EA3, label="$1EA3" },
  { addr=0x148B, label="$148B" },  -- overworld selected level (seen in some docs)
  { addr=0x148C, label="$148C" },
  { addr=0x1B9D, label="$1B9D" },  -- translevel low  (seen in decomp)
  { addr=0x1B9E, label="$1B9E" },  -- translevel high
}

-- Initialize last values
for _, c in ipairs(candidates) do
  c.lastVal = emu.read(c.addr, emu.memType.wram) or 0
end

local function getGameMode()
  return emu.read(0x0100, emu.memType.wram) or 0
end

local frameCount = 0

emu.addEventCallback(function()
  frameCount = frameCount + 1
  local mode = getGameMode()
  -- Only watch during overworld modes ($0C–$12)
  if mode < 0x0C or mode > 0x12 then return end

  for _, c in ipairs(candidates) do
    local v = emu.read(c.addr, emu.memType.wram) or 0
    if v ~= c.lastVal then
      emu.log(string.format("[frame %d] %s changed: $%02X → $%02X  (mode=$%02X)",
        frameCount, c.label, c.lastVal, v, mode))
      c.lastVal = v
    end
  end
end, emu.eventType.endFrame)

emu.log("overworld_cursor.lua loaded.")
emu.log("Go to overworld screen and move the cursor across level icons.")
emu.log("Any WRAM address that changes will be logged with old→new value.")
