import * as fs from 'fs'
import * as path from 'path'

// Found by walking up from this file to the repo's build/icons/app, so the
// same code resolves from src/ (tests) and from lib/theia/extension/src/ (the
// built app), and never depends on the process cwd. The icons live under
// build/icons because the content gate allows binary images only there.
export function appIconPath(
  platform: string = process.platform,
  fromDir: string = __dirname,
): string {
  let dir = fromDir
  while (!fs.existsSync(path.join(dir, 'build', 'icons', 'app'))) {
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`HackBench icon assets not found above ${fromDir}`)
    dir = parent
  }
  return path.join(dir, 'build', 'icons', 'app', platform === 'win32' ? 'icon.ico' : 'icon.png')
}
