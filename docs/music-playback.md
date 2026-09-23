# Music playback

How the Music panel turns ROM bytes into sound, what the engine can and
cannot do, and which limitations are the ROM's, the player's, or ours.

## The short version

A track is not a file. It is a one-byte BGM command that the game writes to
an SPC I/O port. To hear one outside the game, HackBench assembles the
64 KB ARAM image the SNES would have uploaded, writes the command into it,
and hands the result to an SPC700 emulator as a `.spc` snapshot.

```
working copy (base ROM + edit layers)
  -> locate the music bank            src/rom/MusicCatalog.ts
  -> upload engine + samples + bank   src/rom/SpcBuilder.ts  (buildSpc)
  -> write BGM command to ARAM $F6
  -> package as a .spc snapshot
  -> JSON-RPC to the frontend         theia/.../music-server.ts  trackSpc
  -> Backend.loadSPC()                theia/.../spc-playback.ts
```

Snapshots are built per play and never cached. They come from the
project's WORKING COPY, so an edit made anywhere else in the session is
audible immediately, and a cache keyed on less than the whole working copy
would go stale without saying so.

## The engine

`@smwcentral/spc-player` 2.0.2, by Telinc1, LGPL-2.1-only. It wraps
Blargg's `snes_spc` plus logic from cosinusoidally's `snes_spc_js`. See
[THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md) for the relink
obligations, which the serving arrangement below is chosen partly to
honour.

### Why it is loaded by URL rather than imported

Two properties of the package, both documented upstream, neither a
leftover from the VS Code extension's webview:

- It is an **Emscripten global script**. Running it assigns
  `window.SMWCentral.SPCPlayer`, and it fetches its own `.wasm` at runtime
  through Emscripten's `locateFile` hook. Pulling it through the frontend
  bundler as a module breaks both halves.
- It **auto-initialises its own player UI** on `DOMContentLoaded`, reading
  about twenty elements by id and class. Its README is explicit: "You must
  also include the HTML from `spc_player.html` somewhere on the page." Without
  them it throws before `Backend` is ever assigned.

So `theia/extension/src/node/spc-assets.ts` serves the two files from
`node_modules` at `/hackbench/spc/`, and
`theia/extension/src/browser/spc-playback.ts` plants a hidden stub
carrying those elements, sets `Module.locateFile`, injects the script, and
then drives `Backend` directly. The package's own UI is never shown; its
README sanctions this under "Custom interface".

What the shell DID let us drop, compared to the webview: the CSP nonce,
`wasm-unsafe-eval`, webview resource URIs, and the `postMessage` bridge.

## The controls, and where each one comes from

Every control below is a byte the game itself writes. None is invented.

| Control              | Port        | Byte          | Citation                                      |
| -------------------- | ----------- | ------------- | --------------------------------------------- |
| Select track         | 2 (`$1DFB`) | command       | `bank_00.asm:205-212` mirrors to `$2142`      |
| Hurry-up             | 0 (`$1DF9`) | `$FF`         | `!SFX_HURRYUP`, constants.asm:322             |
| Yoshi drums on / off | 1 (`$1DFA`) | `$02` / `$03` | `!SFX_YOSHIDRUMON/OFF`, constants.asm:325-326 |

The hurry-up byte is what `UpdateStatusBar` writes when the timer ticks to
**099**, not 100: the check is `hundreds == 0 && (tens AND ones) == 9`
(`bank_00.asm:1585-1592`). It both plays the jingle and speeds the music
up, in one command.

The SNES writes `$2140-$2143` and the SPC reads `$F4-$F7`, with the game
mirroring `SPCIO0-3` (`$1DF9-$1DFC`) onto them in NMI
(`bank_00.asm:213-218`). So port 0 is ARAM `$F4`, port 1 is `$F5`, port 2
is `$F6`.

### The limitation that shapes the UI

**The engine cannot write a port once a snapshot is loaded.** Its surface
is `loadSPC`, `pause`, `resume`, `seek`, `getTime` and a gain node, and
nothing else. So hurry-up and Yoshi drums cannot be applied live: toggling
either rebuilds the snapshot with a different port byte and reloads it,
which **restarts the track**.

That is a property of the player, not of the ROM. The panel labels those
two buttons accordingly rather than presenting them as live toggles, which
would be a control that silently half-works.

`SpcPorts` in `src/rom/SpcBuilder.ts` is the seam. Getting its offsets
wrong is silent (the snapshot loads, the track plays, the control does
nothing), so `test/suite/unit/SpcBuilderPorts.test.ts` pins each one
against planted defects.

## Why playback can be unavailable

Playing a track needs the music bank located, and locating a bank means
verifying the path to its upload routine, not just reading bytes at a
fixed address. On the three AddmusicK ROMs in this repo's corpus that
verification fails for **all three banks**, so nothing in them can be
played.

`trackSpc` gates on `readMusicCatalog` before calling `buildSpc`, because
`buildSpc`'s own reads for the engine and sample blocks are ungated: on a
patched ROM they would assemble a snapshot out of addresses that ROM never
uploads. A confidently wrong noise is worse than silence.

The panel stays useful on those ROMs. Map attribution comes from the
level-header decode, which survives AddmusicK on all six corpus ROMs, so
the list still shows which commands the project's maps ask for and how
many maps each. See [music-bank-song-table.md](./spikes/music-bank-song-table.md)
for the bank reading itself.

## Banks

Three banks, all uploading to the same ARAM address (`$1360` on a stock
ROM), so only one is resident at a time and a BGM command means a
different song in each. `$02` is the level bank's overworld theme and the
overworld bank's Donut Plains theme. The panel therefore shows one bank at
a time, and track names are stored per bank
(`src/project/Aliases.ts`).

Measured across the corpus on 2026-09-21:

| Bank      | ROM address | Size  | Commands | Distinct songs |
| --------- | ----------- | ----- | -------- | -------------- |
| Level     | `$0EAED6`   | 16893 | 29       | 27             |
| Overworld | `$0E98B1`   | 5661  | 9        | 9              |
| Credits   | `$03E400`   | 6598  | 12       | 4              |

The level bank's 29 commands resolve to 27 songs because `$04` shares with
`$16` and `$0F` shares with `$10`. The credits bank's twelve slots hold
four songs repeated three times. The panel marks shared commands, because
otherwise replacing one looks like it changed another by magic.

## Track names

A ROM holds none. The names in the disassembly's `constants.asm`
(`ATHLETIC`, `CASTLE`, ...) describe a stock ROM and are wrong on a hack:
all three AddmusicK ROMs point their eight level-music slots at `$0A-$12`,
which under stock naming reads GAMEOVER, KEYHOLE, BOSSCLEAR, SPOTLIGHT.

So names come from the user and live in the project manifest, namespaced
per bank. A row shows the user's name if they gave one, otherwise the hex
command, and never a name derived from the ROM.
