# Idea: MCP Server hosted by the extension

Defer until the extension is feature-complete.

## Concept

The extension host (Node.js) spins up a Streamable HTTP MCP server on a local port so that
AI agents can interact with an open ROM without going through the VS Code UI.

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

## Implementation sketch

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as http from 'http'

export function activate(ctx: vscode.ExtensionContext) {
  // ... existing providers ...

  const mcp = new McpServer({ name: 'hackbench', version: '0.1.0' })

  mcp.tool('smw_list_levels', {}, async () => {
    const rom = RomSession.current?.rom
    if (!rom) return { content: [{ type: 'text', text: 'No ROM open' }] }
    return { content: [{ type: 'text', text: JSON.stringify(rom.getLevelList()) }] }
  })

  // ... more tools ...

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const server = http.createServer((req, res) => transport.handleRequest(req, res))
  server.listen(3579)
  mcp.connect(transport)

  ctx.subscriptions.push({ dispose: () => server.close() })
}
```

## Design notes

- `RomSession.current` needs to be a singleton - currently sessions are per-document.
  An "active session" concept (set when the user opens a ROM, cleared on close) would be needed.
- Port conflicts if multiple VS Code windows run the extension simultaneously - consider a
  configurable port setting or dynamic port with status-bar display.
- The ROM parsing layer (`src/rom/`) is already VS Code-free, making it straightforward to
  expose over MCP without architectural changes.
- Package to add: `@modelcontextprotocol/sdk`
