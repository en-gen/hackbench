// Refuses a Theia build or Playwright run from a worktree whose Theia install
// is shared with another checkout (#1038). Through such a link the workspace
// links (hackbench-*) resolve into the OTHER checkout's packages, so the build
// bundles the wrong extension, and nx/lerna cache under node_modules/.cache is
// shared, so two lock slots building at once corrupt each other.
// Evidence scope: lstat/realpath on Windows junctions and POSIX symlinks, one
// Windows machine. Native realpath so 8.3 short paths compare as long ones.
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LINKS = ['hackbench-theia-extension', 'hackbench-browser-app', 'hackbench-electron-app']
const PACKAGES = ['extension', 'browser-app', 'electron-app']
const real = p => realpathSync.native(p)
const isLink = p => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
const inside = (root, p) => {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// String.raw: a plain "\n" in "theia\node_modules" would be a newline.
const REMOVE_NM = String.raw`cmd /c rmdir theia\node_modules`
const INSTALL = '`yarn --cwd theia install`'
const ADVICE_LINK = what =>
  `Fix: remove the link with \`${what}\` (not a recursive delete), then run ${INSTALL} from this worktree.`
const ADVICE_INSTALL = `Fix: run ${INSTALL} from this worktree.`

/** Returns a plain-words problem, or null when the install is this checkout's own. */
export function checkTheiaInstall(repoRoot) {
  const theia = path.join(repoRoot, 'theia')
  if (!existsSync(theia)) return null
  const tail = (why, fix) =>
    `Refusing a Theia build or Playwright run: ${why}. It would bundle the other checkout's code and share its build cache with any build running there. ${fix}`
  if (isLink(theia)) {
    return tail(
      'the theia folder is itself a link to another folder',
      `Fix: remove the link with \`${String.raw`cmd /c rmdir theia`}\`, run \`git checkout -- theia\`, then run ${INSTALL}.`,
    )
  }
  const nm = path.join(theia, 'node_modules')
  if (!existsSync(nm)) return null // not this guard's job: the build fails as it does today
  const root = real(repoRoot)
  if (isLink(nm)) {
    return tail('theia/node_modules is a link to another folder', ADVICE_LINK(REMOVE_NM))
  }
  const bad = LINKS.filter(
    l => existsSync(path.join(nm, l)) && !inside(root, real(path.join(nm, l))),
  )
  if (bad.length) {
    return tail(`${bad.join(', ')} in theia/node_modules point at another checkout`, ADVICE_INSTALL)
  }
  // Shared build state lives in these too; each must be this checkout's own.
  const shared = [...PACKAGES.map(p => `theia/${p}/node_modules`), 'theia/node_modules/.cache']
  for (const rel of shared) {
    const p = path.join(repoRoot, rel)
    if (isLink(p) && existsSync(p) && !inside(root, real(p))) {
      const cmd = `cmd /c rmdir ${rel.replaceAll('/', '\\')}`
      return tail(`${rel} is a link to another checkout`, ADVICE_LINK(cmd))
    }
  }
  return null
}

const MARKER = path.join('tools', 'scripts', 'check-theia-install.mjs')

/**
 * Checkout roots to check when no root is given. On POSIX process.cwd() is the
 * symlink TARGET, so a junctioned theia folder would look like the main
 * checkout; the shell's PWD (accepted only when it is the cwd) and yarn's
 * INIT_CWD keep the worktree path (#1038 review). Each is walked up to the
 * nearest folder holding this script.
 */
export function candidateRoots(env = process.env, cwd = process.cwd()) {
  const dirs = [
    env.INIT_CWD,
    env.PWD && existsSync(env.PWD) && real(env.PWD) === real(cwd) ? env.PWD : '',
    cwd,
  ]
  const roots = []
  for (const start of dirs.filter(Boolean)) {
    for (let d = path.resolve(start); ; d = path.dirname(d)) {
      if (existsSync(path.join(d, MARKER))) {
        if (!roots.includes(d)) roots.push(d)
        break
      }
      if (path.dirname(d) === d) break
    }
  }
  return roots
}

// Compare realpaths: invoking through a link must still run the check.
const invoked = process.argv[1] && existsSync(process.argv[1]) ? real(process.argv[1]) : ''
if (invoked === real(fileURLToPath(import.meta.url))) {
  const own = path.join(import.meta.dirname, '..', '..')
  const roots = process.argv[2] ? [path.resolve(process.argv[2])] : candidateRoots()
  const problem = (roots.length ? roots : [own]).map(checkTheiaInstall).find(Boolean)
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
}
