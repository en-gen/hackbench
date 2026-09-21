# T11: EmulatorJS / libretro calling conventions for savestates and memory

Evidence scope: read directly from source via `gh api` / `curl` against
`EmulatorJS/EmulatorJS` (JS frontend) and `EmulatorJS/RetroArch` (the fork that
actually builds the wasm; default branch `next`, tag `v1.22.2` used below).
Target build: core `2.0.2`, EJS `4.2.2` (tag `v4.2.2` = commit `a796c4a3`,
2025-06-14). Each function is tagged PRESENT (blamed before 2025-06-14, should
be in our binary), LIKELY ABSENT (blamed after, probably missing), or
UNVERIFIED. Everything cited below was read from source this session, not
recalled from general knowledge of EmulatorJS.

## 1. Savestates: the real calling convention

**`cmd_save_state()` is not what GameManager calls.** `GameManager.js` at tag
`v4.2.2` has no `cmd_save_state` cwrap. The real save path:

```js
getState() {
    const state = this.functions.saveStateInfo().split("|");
    if (state[2] !== "1") throw new Error(state[0]);
    const size = parseInt(state[0]), dataStart = parseInt(state[1]);
    return new Uint8Array(this.Module.HEAPU8.subarray(dataStart, dataStart + size));
}
// functions.saveStateInfo = Module.cwrap('save_state_info', 'string', [])
```

C side, `tasks/task_save.c:1834-1866` (`#ifdef EMULATORJS`, commit `4d26b6fa`
"EmulatorJS patches", 2025-01-27, PRESENT):

```c
char* save_state_info(void) {
   char state_data[300];   // stack buffer, NOT malloc'd
   serial_size = core_serialize_size();
   save_data = content_get_serialized_data(&serial_size);   // real bytes, heap
   sprintf(state_data, "%zu|%zu|1", serial_size, (unsigned long)save_data);
   return state_data;
}
bool supports_states(void) { return core_info_current_supports_savestate(); }
```

Matches FINDINGS.md exactly: `save_state_info()` returning "780656" is
`parseInt("780656|<ptr>|1")`, i.e. `retro_serialize_size()`. Fix: call it with
`cwrap(..., 'string', [])` or `ccall` + `UTF8ToString`, not as a plain number.
Do not free the returned pointer: `state_data` is a stack array, so freeing it
is undefined behavior (EmulatorJS's newer `$EmulatorJSGetState` helper does
call `_free` on it anyway; that is a latent bug in their code, not a contract
to replicate). Copy the state bytes with `.slice`, not `.subarray`: a subarray
is a live view that a later serialize call can invalidate.

**Load path**, same file:

```js
loadState(state) {
    this.FS.writeFile("/game.state", state);
    this.functions.loadState("game.state", 0);   // arg 2 is ALWAYS 0, every call site
}
// functions.loadState = Module.cwrap('load_state', 'number', ['string', 'number'])
```

C side, `retroarch.c:6272-6275` (same 2025-01-27 commit, PRESENT):

```c
int load_state(char *path, int rv) {
    content_load_state(path, false, false);
    return rv;
}
```

**This resolves the spike's mystery.** The return value is always `rv`, i.e.
whatever you passed as the second argument; `content_load_state`'s own
success/failure is discarded. There is no way to detect load failure from the
return value. GameManager.js always passes `rv = 0` and ignores it. Path is a
plain FS write to any filename (`quickSave`/`quickLoad` use `"1-quick.state"`
at FS root); no directory needs pre-creating, and neither call touches
`retroarch.cfg`'s `savestate_directory` (never set, see section 3).

**`cmd_save_state()` / `cmd_load_state()` are a second, unused mechanism.**
`frontend/drivers/platform_emulatorjs.c:140-155`:

```c
void cmd_save_state(void) { command_event(CMD_EVENT_SAVE_STATE, NULL); }
void cmd_load_state(void) { command_event(CMD_EVENT_LOAD_STATE, NULL); }
```

This drives RetroArch's own async save-to-file task, resolving its path from
RetroArch's internal content-relative default (EmulatorJS's cfg never sets
`savestate_directory`), completing on a later `task_queue_check()` inside
`emscripten_mainloop`. Consistent with FINDINGS.md gotcha 4 (`cmd_*` needs a
pumped frame). GameManager.js never calls either function; they are shared
frontend-driver plumbing, not part of the save/load API. Writing no findable
file is expected: this path was never wired to return bytes to JS and its
on-disk destination is unconfigured. Abandon it for save/load.

**Recipe**: `ccall('save_state_info','number',[],[])` then
`UTF8ToString` then split, exactly as `getState()` above; for load, `FS.writeFile`
then call `load_state('path', 0)` and ignore the return. No `Module.cwrap`
setup beyond what GameManager.js already shows is needed.

## 2. Memory access: three candidate paths

### Path A: `READ_CORE_MEMORY` / `WRITE_CORE_MEMORY` (best confidence)

RetroArch's generic remote-command protocol, `command.c`, not gated behind
`#ifdef EMULATORJS` (ordinary upstream code, should be present regardless of
build date). Reached via `Module.EmscriptenSendCommand(str)` /
`Module.EmscriptenReceiveCommandReply()` (`library_platform_emscripten.js:189-197`,
both listed in `EXPORTED_RUNTIME_METHODS` in `Makefile.emulatorjs:132`). A
reply is only queued after a pumped frame (`command_emscripten_poll` runs the
dispatcher once per iteration, `command.c:390-396`).

```c
// command.c:1075-1112, not gated by HAVE_CHEEVOS
sscanf(arg, "%x %u", &address, &nbytes);
command_memory_get_pointer(sys_info, address, &max_bytes, /*for_write=*/0, ...);
// reply: "READ_CORE_MEMORY <addr> XX XX XX ...\n" or "... -1 <reason>\n"
// command.c:1114-1150: WRITE_CORE_MEMORY "<addr hex> <byte hex> <byte hex> ..."
```

`command_memory_get_pointer` (`command.c:1006-1029`) resolves `address` through
the core's declared memory-map descriptors:

```c
if (!sys_info || sys_info->mmaps.num_descriptors == 0) return " -1 no memory map defined";
desc = command_memory_get_descriptor(&sys_info->mmaps, address, &offset);
return (uint8_t*)desc->core.ptr + desc->core.offset + offset;
```

UNVERIFIED: only works if the core called `RETRO_ENVIRONMENT_SET_MEMORY_MAPS`.
Whether `snes9x_libretro` does was not confirmed from source this session.
Concrete test: `Module.EmscriptenSendCommand("READ_CORE_MEMORY 0 16")`, pump
one frame, `Module.EmscriptenReceiveCommandReply()`. A "-1 no memory map
defined" reply closes this path; sixteen hex bytes back opens it, both read
and write, and address 0 in RetroAchievements convention is normally start of
system RAM (WRAM), not the raw SNES bus address.

A second pair, `READ_CORE_RAM` / `WRITE_CORE_RAM` (`command.c:877-928`, gated
`#if defined(HAVE_CHEEVOS)`), resolves through `rcheevos_patch_address(addr)`
instead. Try both; `HAVE_CHEEVOS` compiled in is UNVERIFIED.

### Path B: `get_memory_data(key)` (cleanest API, LIKELY ABSENT)

`retroarch.c:6213-6234` (`#ifdef EMULATORJS`):

```c
char* get_memory_data(char* key) {   // key: one of the four RETRO_MEMORY_* names, as a string
   void* data = retro_get_memory_data(id);
   size_t size = retro_get_memory_size(id);
   sprintf(state_data, "%zu|%zu", size, (unsigned long)data);
   return state_data;   // stack buffer again, do not free
}
```

JS side, `emscripten/emulatorjs.js`:

```js
$EmulatorJSGetMemoryData: function(key) {
    const info = _get_memory_data(stringToNewUTF8(key));
    const [size, dataStart] = UTF8ToString(info).split("|").map(Number);
    return HEAPU8.subarray(dataStart, dataStart + size);   // LIVE view
}
```

Exactly the direct pointer into `retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)`
the task asked about: SNES WRAM, live, readable and writable by indexing
`HEAPU8` (not a snapshot; the core writes through the same buffer).

**Does not predate our build.** `git log` on `retroarch.c` and
`Makefile.emulatorjs` both show `get_memory_data`, `_get_memory_data`, and
`EmulatorJSGetMemoryData` introduced together in commit `ed326574` "Add
ability to get pointer to emulated ram", 2026-02-06, eight months after the
`v4.2.2` baseline. The non-EmulatorJS `Makefile.emscripten` never exports it.
Verdict: LIKELY ABSENT from `snes9x_libretro.wasm` core `2.0.2`. Verify
directly: grep the wasm binary's export-name section (same technique already
used to establish `toggleMainLoop` was the only pause-related export) for the
literal bytes `get_memory_data`. If present, this beats Path A outright. If
absent, rebuilding the core from `EmulatorJS/build` against current
`EmulatorJS/RetroArch` is a real, scoped option.

### Path C: `set_cheat` / `reset_cheat` (write-only, confirmed present)

`platform_emulatorjs.c:145-152` (2025-01-27 commit, PRESENT):

```c
void set_cheat(unsigned index, bool enabled, const char *code) { retro_cheat_set(index, enabled, code); }
void reset_cheat(void) { retro_cheat_reset(); }
```

`retro_cheat_set` is the standard libretro callback; RetroArch does zero
parsing of `code` and forwards it straight to the core's own cheat decoder.
For `snes9x_libretro` that decoder is expected to accept Game Genie and Pro
Action Replay formats by SNES-core convention, but the exact decoder was not
traced this session; treat the PAR `AAAAAAVV` claim as likely but UNVERIFIED.
Once enabled, the core is expected to keep applying the cheat every frame, no
separate "apply" call needed (that requirement belongs to the older
`cmd_cheat_apply_cheats()` / `cheat_manager_*` path, which `set_cheat`
bypasses). No read path exists through cheats. This confirms the task's
fallback plan: plant a distinctive byte pattern via a cheat write, then find it
in `HEAPU8` by exact search, locating WRAM by identity rather than guessing.

### Summary

| Path | Read | Write | Confidence |
|---|---|---|---|
| `READ_CORE_MEMORY`/`WRITE_CORE_MEMORY` | yes | yes | likely present; needs core memory map, unverified |
| `READ_CORE_RAM`/`WRITE_CORE_RAM` | yes | yes | depends on `HAVE_CHEEVOS`, unverified |
| `get_memory_data`/`EmulatorJSGetMemoryData` | yes | yes | likely ABSENT (added 2026-02-06) |
| `set_cheat`/`reset_cheat` | no | yes | confirmed present (2025-01-27) |

## 3. Configuration

`GameManager.js` (`getRetroArchCfg()`, v4.2.2) writes this to
`/home/web_user/.config/retroarch/retroarch.cfg` before boot:

```
autosave_interval = 60
screenshot_directory = "/"
block_sram_overwrite = false
video_gpu_screenshot = false
audio_latency = 64
video_top_portrait_viewport = true
video_vsync = true
video_smooth = false
fastforward_ratio = 3.0
slowmotion_ratio = 3.0
rewind_enable = true        # only if EJS.rewindEnabled was set before boot
rewind_granularity = 6      # only if EJS.rewindEnabled was set before boot
savefile_directory = "/data/saves"
```

**`audio_enable` is not in this list.** `configuration.c:1854` shows its
compiled default is `DEFAULT_AUDIO_ENABLE` (true). EmulatorJS's own frontend
never disables it because it runs in a real tab where WebAudio drains. The
spike's `audio_enable = false` requirement is correct and necessary, but it is
our own addition for headless/synchronous pumping, not an EmulatorJS
convention to look for elsewhere.

**No `savestate_directory` key is ever set**, which is why `cmd_save_state`'s
on-disk destination is unpredictable (section 1): it is simply never
configured.

**Rewind**: `toggle_rewind(bool)` / `set_rewind_granularity(uint)`
(`retroarch.c:6353-6365`, PRESENT) only flip a global bool and a settings
field; the rewind ring buffer itself is allocated at content-load time from
`rewind_enable` in the boot cfg (standard RetroArch behavior, not re-verified
here). Toggling rewind on later without `rewind_enable = true` at boot is
UNVERIFIED and likely a no-op. Set `rewind_enable = true` before boot if
rewind is wanted as a savestate backdoor.

## 4. Other findings

**`EmscriptenSendCommand`/`EmscriptenReceiveCommandReply` are RetroArch's
standard remote-command text protocol**, the one `retroarch --command` uses,
rerouted through a JS queue instead of a UDP socket
(`command_emscripten_poll` calls the same `command_parse_msg` dispatcher
desktop RetroArch uses, `command.c:390-396`). The full standard vocabulary is
available this way, not just `READ_CORE_MEMORY`/`WRITE_CORE_MEMORY`:
`SAVE_STATE`, `LOAD_STATE`, `PAUSE_TOGGLE`, `RESET`, etc. `SAVE_STATE`/
`LOAD_STATE` sent this way hit the identical `command_event` calls as
`cmd_save_state`/`cmd_load_state`, so they inherit the same unconfigured
destination problem, not a fix for it.

**`get_current_frame_count` zero-arg signature: sanity check confirmed.**
`GameManager.js` declares `cwrap("get_current_frame_count", "number", [""])`
in both `main` and `v4.2.2`, an empty string as the lone arg-type entry. The C
function (`retroarch.c:6250`, PRESENT) is `double get_current_frame_count(void)`,
truly zero-argument. `cwrap` only marshals as many arguments as are actually
passed, so calling with zero arguments (as the earlier finding did) is correct;
the declared arg-type array is a harmless copy-paste artifact in EmulatorJS's
own source, not a real discrepancy.

**`get_video_dimensions(key)` takes a string, returns a float; three separate
calls needed.** `runloop.c:8759-8783` (PRESENT, added 2025-05-11, before
baseline): `key` is `"width"`, `"height"`, or `"aspect"`; anything else logs an
error and returns `-1.0f`. No single call returns both dimensions.

**`ejs_set_variable(key, value)` is core-options only.** `runloop.c:8524-8547`
(PRESENT): the one special case is `key == "fps"` (toggles the FPS overlay);
everything else routes through `core_option_manager_set_val`, touching only
options the core itself exposed via `RETRO_ENVIRONMENT_SET_CORE_OPTIONS`. It
cannot set arbitrary `retroarch.cfg` keys at runtime.

**Confirmed newer than baseline (LIKELY ABSENT from core 2.0.2), beyond
`get_memory_data`:**
- `get_core_options_json` (commit `1e5d8463`, 2026-07-25)
- `ejs_set_controller_port_device`, `ejs_get_controller_port_info` (commit `c419f627`, 2026-03-16)
- `EmulatorJSGetState` as a named JS helper (commit `e31353d7`, 2025-08-07, two
  months after baseline). The underlying technique (`save_state_info` + manual
  parse + `HEAPU8` slice) is what `v4.2.2`'s `GameManager.js` already does
  inline in JS (section 1), so the technique is confirmed present even if this
  particular helper name is not.

## 5. What we are doing wrong, ranked

1. **Calling `save_state_info()` as a plain number instead of a C string.** It
   returns `"size|pointer|flag"` as text; parse it, do not treat the return as
   a size or pointer directly. This alone should unblock savestates.
2. **Treating `load_state`'s return value as a success flag.** It structurally
   cannot be one (`return rv;` on the literal argument passed in). Detect
   success by re-reading game state after a pumped frame, not the return
   value.
3. **Chasing `cmd_save_state`/`cmd_load_state`.** Real functions, but a
   different, unconfigured, async RetroArch-desktop code path that
   `GameManager.js` itself never uses. `save_state_info`/`load_state` is the
   actual API.
4. **Not yet trying `READ_CORE_MEMORY`/`WRITE_CORE_MEMORY` over the command
   channel.** Ordinary RetroArch code, not new, not EmulatorJS-only, possibly
   the fastest unblock for WRAM access if `snes9x_libretro` declares a memory
   map, and cheaper to test than continuing to chase `get_memory_data`, which
   was probably not built into this core at all.
