# Launch HackBench for the owner

Use when the owner asks to run a branch to test it. The owner's rule (2026-10-04): launch the browser build on a random free port and hand over the URL; never the Electron app, because a fixed port or Electron collides with other agent sessions.

1. Build in a checkout no verifier is using: `yarn --cwd theia/extension build`, then `yarn --cwd theia build:browser`, in that order (the reverse bundles a stale backend).
2. Pick a free port: `node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"`.
3. Start it in the background: `yarn --cwd theia/browser-app theia start --port <port> --hostname 127.0.0.1`. `npx theia` fails to resolve the CLI from `browser-app`.
4. Hand the owner `http://127.0.0.1:<port>`.

This uses the owner's normal app data, so their projects and ROM paths are present. The Playwright start script isolates app data instead; do not use it for owner testing.
