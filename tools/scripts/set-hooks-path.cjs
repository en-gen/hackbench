#!/usr/bin/env node
// Run by the npm `prepare` lifecycle script so the content gate and style
// gate are wired up automatically (issue #678). Plain CommonJS + node
// built-ins only, and never `bash`: on Windows, `bash` on PATH can resolve
// to WSL's bash.exe, which cannot see this checkout and breaks `npm install`.
//
// Must no-op (never fail `npm ci`/`npm install`) outside a git checkout,
// e.g. unpacked from a published tarball with no .git directory at all.
//
// Writes to whichever config file actually takes effect: `--worktree`
// when `extensions.worktreeConfig` is on (this clone uses per-worktree
// config so many linked worktrees don't fight over one hooksPath), else
// `--local`. It only ever touches the worktree it runs in - a linked
// worktree's own config.worktree file - never another worktree's.

const { spawnSync } = require('node:child_process')

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' })
}

function main() {
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return // not a git checkout

  const useWorktreeScope =
    git(['config', '--get', 'extensions.worktreeConfig']).stdout.trim() === 'true'
  const scope = useWorktreeScope ? '--worktree' : '--local'

  const set = git(['config', scope, 'core.hooksPath', '.githooks'])
  if (set.status !== 0) {
    console.warn(`set-hooks-path: could not set core.hooksPath (${scope}): ${set.stderr.trim()}`)
    return
  }

  const effective = git(['config', 'core.hooksPath']).stdout.trim()
  if (effective !== '.githooks') {
    console.warn(
      `set-hooks-path: core.hooksPath is "${effective}" after writing ${scope}, not ".githooks" - ` +
        'a higher-precedence config (often another config.worktree entry) is still winning.',
    )
  }
}

main()
