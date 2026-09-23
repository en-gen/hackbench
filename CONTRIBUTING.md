# Contributing to HackBench

Thanks for your interest in contributing! HackBench is a hobbyist
project and welcomes PRs, from documentation fixes to entirely new views.

HackBench is an [Eclipse Theia](https://theia-ide.org/) and Electron
desktop application. It is not a VS Code extension; it began as one, and
that tree survives as a reference implementation. See
[docs/architecture/overview.md](docs/architecture/overview.md).

## Before you start

- **License:** HackBench is released under the [MIT License](./LICENSE).
  By submitting a contribution, you agree to license it inbound under
  the same terms.
- **Code of Conduct:** contributions are subject to our
  [Code of Conduct](./CODE_OF_CONDUCT.md).
- **Never commit ROM data.** `*.smc`, `*.sfc`, `*.rom`, `*.ips`, `*.bps`
  are gitignored. Keep it that way. See [Legal](./README.md#legal).

## Setup

You need Node 22.12 or newer (Theia 1.75 pins Electron 42.8.1, whose
engines field requires it), plus `npm` and `yarn` 1.x.

```bash
git clone https://github.com/en-gen/hackbench
cd hackbench
npm install                     # root: the core, the tests, the tooling
yarn --cwd theia install        # the desktop app's own workspace
git config core.hooksPath .githooks   # the pre-commit gates, once per clone
```

Build and run the app:

```bash
yarn --cwd theia build          # first build is slow: it bundles the frontend
yarn --cwd theia start          # Electron
yarn --cwd theia watch          # rebuild on save
```

`start:browser` and `build:browser` target the browser instead, which is
what the Playwright suite drives.

Full walkthrough: [docs/guide/getting-started.md](docs/guide/getting-started.md).

## Commands

| Command | Purpose |
|---|---|
| `npm run lint` | ESLint over `src`, `test`, `tools`, `theia` and root config, at `--max-warnings 0` |
| `npm run lint:fix` | Auto-fix lint |
| `npm run format` | Prettier over JS/TS/CSS |
| `npm run format:check` | Prettier in check mode, as CI runs it |
| `npm run test:unit` | Vitest unit tests (single run) |
| `npm run test:unit:watch` | Vitest watch mode |
| `npm run typecheck:theia` | Type-check the desktop app |
| `npm run gitnexus` | Refresh the code index. Never a bare `gitnexus analyze` |
| `npm run compile` | Webpack build of the **reference** VS Code extension |

Run a single test file:

```bash
npx vitest run test/suite/unit/GraphicsDecoder.test.ts
```

## Branch strategy

- `main` - reserved for releases, and empty until the first one. Do not
  commit or open PRs against it.
- `develop` - default branch and integration base. **All PRs target
  `develop`.**
- `feature/<short-slug>` - one concern per branch, off `develop`.

After your PR merges:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/<next>
```

## Code layout

Full tour: [docs/architecture/overview.md](docs/architecture/overview.md)
and [docs/architecture/codebase-map.md](docs/architecture/codebase-map.md).
Short version:

- `src/rom/` - ROM parsing and decoding. **No shell imports**, so it is
  unit-testable without starting an app.
- `src/project/` - projects, patch layers, the working copy, IPS export.
  Same no-shell rule.
- `theia/extension/src/` - the application: `common/` holds the RPC
  contract, `node/` is the only side that touches the ROM, `browser/`
  renders and never reads a file.
- `src/providers/`, `src/webview/`, `src/extension.ts` - the original VS
  Code extension, reference only. No new features. See
  [src/providers/CLAUDE.md](src/providers/CLAUDE.md).

## Adding a new view

The Map16 editor is the most recent worked example; these are the files it
added.

1. Put the ROM reading in `src/rom/`, with no shell imports, and unit-test
   it there.
2. `theia/extension/src/common/<name>-protocol.ts` - the service interface
   and its `SERVICE_PATH`. Both sides import this, so a protocol change
   breaks the compile rather than the runtime.
3. `theia/extension/src/node/<name>-server.ts` plus
   `<name>-backend-module.ts` - the server, and an `RpcConnectionHandler`
   bound to the path. Read the working copy through `WorkingRomRegistry`,
   never `RomFile.load`; `test/suite/gates/workingCopyGate.test.ts`
   enforces that.
4. `theia/extension/src/browser/<name>-view-widget.tsx`,
   `<name>-frontend-module.ts`, and a `<name>-push-client.ts` if the view
   must re-render on an edit. Styles in `browser/style/<name>.css`.
5. Register the frontend/backend pair in `theia/extension/package.json`
   under `theiaExtensions`.
6. Add a Playwright spec under `theia/browser-app/test/`. Every feature
   ships with one, and it asserts behavior, not presence.

## Pull request checklist

- [ ] Targets `develop` (not `main`)
- [ ] `npm run lint` passes (warnings are fatal)
- [ ] `npm run format:check` passes, or run `npm run format`
- [ ] `npm run test:unit` passes
- [ ] New behavior covered by a unit test in `test/suite/unit/`
- [ ] ROM parsing lives in `src/rom/` or `src/project/`, with no shell imports
- [ ] Views read the working copy, not the base ROM
- [ ] New feature ships with a Playwright spec, and any new gate with a proof it can fail
- [ ] No `.smc` / `.sfc` / `.rom` / `.ips` / `.bps` files staged
- [ ] User-facing changes noted in `CHANGELOG.md` under `[Unreleased]`
- [ ] Commit messages explain *why* (the *what* is in the diff)

## Commit style

One concern per commit. Subject line in the imperative mood
("Add GFX re-decode on BPP change" - not "Added..." or "Adds..."). Body
explains the motivation. See recent `git log --oneline` for examples.

## Reporting bugs & suggesting features

Use the [issue templates](https://github.com/en-gen/hackbench/issues/new/choose).
For security-sensitive reports see [SECURITY.md](./SECURITY.md).
