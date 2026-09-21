/**
 * Replacement for `@theia/ffmpeg`.
 *
 * The real package strips proprietary codecs out of the ffmpeg shared library
 * Electron bundles, which is a DISTRIBUTION licensing step. It reads the
 * library through a C++ addon, so it needs node-gyp.
 *
 * It is only reached from ApplicationPackageManager.prepareElectron, and the
 * browser target never calls it. Even for Electron, nothing in HackBench plays
 * media: the SNES core renders to a canvas and audio is disabled.
 *
 * A release build that ships Electron binaries must use the real package, so
 * codec stripping actually happens. That belongs to the packaging issue, not
 * to development.
 */
async function replaceFfmpeg() {
  console.warn('[hackbench] @theia/ffmpeg replaced: codec stripping skipped (dev build)')
}

async function checkFfmpeg() {
  // Nothing was replaced, so there is nothing to verify.
}

module.exports = { replaceFfmpeg, checkFfmpeg }
