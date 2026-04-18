# Architecture

## Stack

| Layer | Technology |
|---|---|
| Extension host | Node.js (VS Code extension API) |
| Build tooling | Webpack 5 + ts-loader |
| Language | TypeScript 5 |
| Webview UI | Vanilla TypeScript + Canvas 2D |
| Tests (unit) | Vitest |
| Tests (integration) | @vscode/test-electron + Mocha |

## Extension model

VS Code extensions run in a dedicated Node.js process (the extension host). UI is rendered inside VS Code using **webview panels** — sandboxed HTML/JS iframes that communicate with the extension host via `postMessage`.

```
┌───────────────────────────────────────────────────────┐
│  VS Code Extension Host (Node.js)                      │
│                                                        │
│  extension.ts          — activate(), command handlers  │
│  RomSession.ts         — open ROM instance             │
│  src/rom/              — binary ROM parsing            │
│  src/providers/        — FS, TreeView, CustomEditor    │
└──────────────────┬────────────────────────────────────┘
                   │  postMessage / webview.onDidReceiveMessage
┌──────────────────▼────────────────────────────────────┐
│  Webview (sandboxed HTML/JS, no Node.js access)        │
│                                                        │
│  dist/webview/levelEditor.js  — level Canvas renderer  │
└───────────────────────────────────────────────────────┘
```

## Virtual filesystem

The "ROM as database" concept is implemented with `vscode.FileSystemProvider`.

When the user runs **HackBench: Open ROM**, the extension:
1. Opens and validates the ROM file
2. Creates a `RomSession` wrapping the `SmwRom` instance
3. Mounts the session at `smwrom://<slug>/` via `SmwFileSystemProvider`
4. Opens VS Code's explorer to that virtual folder

The virtual tree:
```
smwrom://<slug>/
  levels/
    000.smwlevel
    001.smwlevel
    ...
    1FF.smwlevel         (only levels with non-null pointers appear)
```

Each virtual "file" contains a small JSON descriptor. The actual ROM data is read on demand when an editor opens the file.

## Custom editors

Registered via `contributes.customEditors` in `package.json`. Each entry binds a filename pattern to a `viewType` string, which maps to a `CustomEditorProvider` in the extension host.

| Pattern | View type | Provider |
|---|---|---|
| `*.smwlevel` | `hackbench.levelEditor` | `LevelEditorProvider` |

## Webview message protocol

All webview↔host communication uses `panel.webview.postMessage` and `panel.webview.onDidReceiveMessage`.

### Level editor

| Direction | Message |
|---|---|
| Webview → Host | `{ type: 'ready' }` — webview mounted, send data |
| Host → Webview | `{ type: 'load', level: ParsedLevel, levelIndex: number }` |
| Host → Webview | `{ type: 'error', message: string }` |

Future edit messages will follow the same pattern with a `{ type: 'edit', ... }` shape, and the provider will update the document and fire `onDidChangeCustomDocument`.

## Source layout

```
src/
  extension.ts              Entry point — activate(), register everything
  RomSession.ts             Wraps SmwRom + derives slug for smwrom:// URIs
  rom/                      Pure ROM parsing — no vscode dependency
  providers/
    SmwFileSystemProvider.ts  smwrom:// virtual FS
    RomExplorerProvider.ts    SMW Explorer sidebar (TreeDataProvider)
    LevelEditorProvider.ts    .smwlevel custom editor
  webview/
    levelEditor/main.ts      Webview app entry
    shared/levelRenderer.ts  Canvas renderer (no vscode/node dep)
docs/
test/
  suite/                     VS Code integration tests
  roms/                      GITIGNORED — local ROM files only
```

## Adding a new editor

1. Add entry to `contributes.customEditors` in `package.json`
2. Create `src/providers/MyEditorProvider.ts`
3. Create `src/webview/myEditor/main.ts`
4. Add webpack entry in `webpack.config.js`
5. Register in `src/extension.ts`
