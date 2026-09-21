/**
 * Where HackBench keeps per-machine state.
 *
 * Per-user application data, following each platform's own convention rather
 * than inventing a dotfile. Deliberately outside every project directory: a
 * project must never hold machine-specific state, which is what makes one safe
 * to commit and share.
 *
 * Shared by the ROM registry and the recent-projects list so the two cannot
 * disagree about where "here" is.
 */
import * as os from 'os'
import * as path from 'path'

export const APP_DIR_NAME = 'hackbench'

export function appDataDir(): string {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_DIR_NAME)
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR_NAME)
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), APP_DIR_NAME)
}
