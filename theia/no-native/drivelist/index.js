/**
 * Replacement for `drivelist`, which enumerates physical disks through a C++
 * addon.
 *
 * Theia calls this in exactly one place,
 * @theia/core/lib/node/env-variables/env-variables-server.js, to report drive
 * letters for file dialogs. HackBench opens projects and ROMs by path, so an
 * empty list costs a convenience in a dialog and nothing else.
 *
 * The real package publishes no prebuilt binaries for any platform and does
 * not compile against current Node headers with MSVC.
 */
async function list() {
  return []
}

module.exports = { list }
