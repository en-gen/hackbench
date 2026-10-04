import * as fs from 'fs'
import * as path from 'path'

// Walks up from the code's own directory (never the cwd) to the repo's
// build/icons/app, so it resolves from src/ (tests), lib/ (tsc output) and
// theia/electron-app/lib/backend (the esbuild bundle that actually runs). The
// icons live under build/icons because the content gate allows binary images
// only there. Undefined when the file is absent: an icon never blocks startup.
export function appIconPath(
  platform: string = process.platform,
  fromDir: string = __dirname,
): string | undefined {
  const name = platform === 'win32' ? 'icon.ico' : 'icon.png'
  for (let dir = fromDir, parent = ''; dir !== parent; parent = dir, dir = path.dirname(dir)) {
    const file = path.join(dir, 'build', 'icons', 'app', name)
    if (fs.existsSync(file)) return file
  }
  return undefined
}
