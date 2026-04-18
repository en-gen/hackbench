-- Mesen 2 Lua — dump Map16 tile definitions (pointer + raw bytes + decoded subtiles)
-- for a list of tile IDs, reading from SMW's live pointer table at $7E:0FBE.
--
-- Tile definition format (from SMWDisX CODE_0581FB + our src/rom/Map16.ts):
--   $7E:0FBE + tileId*2  → 16-bit pointer into bank $0D
--   8 bytes at that pointer = 4 little-endian words in column-major order:
--       word 0 = TL  (top-left subtile attrs)
--       word 1 = BL  (bottom-left)
--       word 2 = TR  (top-right)
--       word 3 = BR  (bottom-right)
--   Subtile word bit layout: char(10) | palette(3) | prio(1) | flipX(1) | flipY(1).
--
-- Usage: load level, scroll into position, paste into Mesen Script Window, Run.

local MEM = emu.memType.snesMemory
local function r(addr) return emu.read(addr, MEM) end  -- unsigned

local function getPtr(tileId)
  local base = 0x7E0FBE + tileId * 2
  return 0x0D0000 + r(base) + r(base + 1) * 256
end

local function decodeSub(lo, hi)
  local w = lo | (hi << 8)
  return {
    char  = w & 0x3FF,
    pal   = (w >> 10) & 0x7,
    prio  = (w >> 13) & 0x1,
    flipX = (w >> 14) & 0x1,
    flipY = (w >> 15) & 0x1,
  }
end

local function dumpTile(tileId)
  local p = getPtr(tileId)
  local b = {}
  for i = 0, 7 do b[i + 1] = r(p + i) end
  local names = {"TL", "BL", "TR", "BR"}
  local subs = {
    decodeSub(b[1], b[2]),
    decodeSub(b[3], b[4]),
    decodeSub(b[5], b[6]),
    decodeSub(b[7], b[8]),
  }
  emu.log(string.format("$%03X  ptr=$%06X  %02X %02X %02X %02X %02X %02X %02X %02X",
    tileId, p, b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8]))
  for i, s in ipairs(subs) do
    emu.log(string.format("  %s char=$%03X pal=%d prio=%d fX=%d fY=%d",
      names[i], s.char, s.pal, s.prio, s.flipX, s.flipY))
  end
end

-- Default tile IDs of interest from level $001 trust-window cols 5..25.
-- Edit freely to investigate other tiles.
local ids = {
  0x073, 0x074, 0x079,            -- first hill cap
  0x145, 0x148, 0x14B, 0x14C,     -- ground/slope transitions
  0x100,                           -- grass-top body
  0x03F,                           -- dirt fill
  0x126,                           -- collectible
  0x0A0, 0x0A5, 0x0AA, 0x0AF,     -- pyramid slope edges
  0x0DE, 0x0E0, 0x0E2, 0x0E4, 0x0E6, -- slope bodies/caps
  0x096, 0x09B,                    -- slope-up lips
  0x16A,                           -- extra tile seen in Mesen
}

emu.log("=== Map16 tile definitions ===")
for _, id in ipairs(ids) do dumpTile(id) end
emu.log("=== end ===")
