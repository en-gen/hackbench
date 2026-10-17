// Refuses a Theia build from a worktree whose theia/node_modules is shared
// with another checkout (#1038). Through such a junction the workspace links
// (hackbench-*) resolve into the OTHER checkout's packages, so the build
// bundles the wrong extension, and nx/lerna cache under node_modules/.cache
// is shared, so two lock slots building at once corrupt each other.
// Evidence scope: lstat/realpath on Windows junctions and POSIX symlinks.
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LINKS = ['hackbench-theia-extension', 'hackbench-browser-app', 'hackbench-electron-app']

const inside = (root, p) => {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const FIX =
  'Fix: remove the junction WITHOUT deleting through it (cmd /c rmdir theia\node_modules), ' +
  'then run `yarn --cwd theia install` from this worktree.'

/** Returns a plain-words problem, or null when the install is this checkout's own. */
export function checkTheiaInstall(repoRoot) {
  const nm = path.join(repoRoot, 'theia', 'node_modules')
  if (!existsSync(nm)) return null // not this guard's job: the build fails as it does today
  const root = realpathSync(repoRoot)
  const why = lstatSync(nm).isSymbolicLink()
    ? 'theia/node_modules is a link to another folder'
    : !inside(root, realpathSync(nm))
      ? 'theia/node_modules resolves outside this checkout'
      : LINKS.filter(
          l => existsSync(path.join(nm, l)) && !inside(root, realpathSync(path.join(nm, l))),
        )
          .map(l => `${l} points at another checkout`)
          .join('; ')
  return why
    ? `Refusing to build Theia: ${why}. It would bundle the other checkout's code and share its build cache with any build running there. ${FIX}`
    : null
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problem = checkTheiaInstall(
    path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', '..')),
  )
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
}
