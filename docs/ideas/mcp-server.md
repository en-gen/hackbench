# Idea: MCP Server hosted by the extension

Status: open, not built, and written for the VS Code extension, which is now reference only (see [../architecture/overview.md](../architecture/overview.md)). A Theia-backend version would host it in `theia/extension/src/node/`. The method names in the table below are as drafted; only `loadGfxFile` still exists under that name in `src/rom/`. Nothing in `src/` or `theia/` uses `@modelcontextprotocol/sdk` (grep 2026-11-07). [EST]

Defer until the application is feature-complete.

## Concept

The host (Node.js) runs a Streamable HTTP MCP server on a local port so AI agents can query an open ROM without the UI.

## Transport

**Streamable HTTP** on a fixed local port (e.g. `localhost:3579`).  
Agents connect via `mcp.json` (VS Code) or Claude Desktop config:

```json
{
  "servers": {
    "hackbench": {
      "type": "http",
      "url": "http://localhost:3579/mcp"
    }
  }
}
```

## Proposed tools

| Tool                    | Maps to                                 |
| ----------------------- | --------------------------------------- |
| `smw_list_levels`       | `SmwRom.getLevelList()`                 |
| `smw_get_level`         | `LevelParser.parseLevel(index)`         |
| `smw_get_level_objects` | `ObjectExpander.expand(level)`          |
| `smw_get_palette`       | `PaletteLoader.loadPaletteGroup(group)` |
| `smw_get_gfx`           | `GfxLoader.loadGfxFile(index)`          |
| `smw_get_map16_page`    | `SmwRom.getMap16Page(page)`             |

## Design notes

- `RomSession` sessions are per-document; the server needs an "active session" (set on ROM open, cleared on close).
- Several windows would collide on one port: use a setting or a dynamic port shown in the status bar.
- `src/rom/` is already shell-free, so it can be exposed without architectural changes.
- Reads must go through the working copy, not the base ROM (`WorkingRomRegistry`).
- Package to add: `@modelcontextprotocol/sdk`
