import { describe, it, expect, beforeEach } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { render } from '../../../tools/scripts/protocol-inject.mjs'

const repoRoot = path.resolve(__dirname, '../../..')
const hook = path.join(repoRoot, 'tools/scripts/protocol-inject.mjs')
const CLI_ID = '2b245891-c391-4d73-9647-b5b41cea6c49'
const LOCAL_ID = 'local_774e2af5-aaaa-4bbb-8ccc-000000000001'
let stateDir: string
let protocolsDir: string
let docsDir: string

function proto(name: string, group: string, changes: string[]): string {
  return (
    [
      `# ${name}`,
      '## Purpose',
      'p.',
      '## Group',
      group,
      '## Activation',
      'owner.',
      '## Changes',
      ...changes,
      '## Unchanged',
      'rest.',
      '## Exit',
      'off.',
    ].join('\n\n') + '\n'
  )
}

function hookEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HACKBENCH_STATE_DIR: stateDir,
    HACKBENCH_PROTOCOLS_DIR: protocolsDir,
    HACKBENCH_DOCS_DIR: docsDir,
  }
}

function runHook(input: object): { code: number; out: string } {
  const r = spawnSync('node', [hook], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: hookEnv(),
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

function register(role: string, team: string | null): void {
  fs.writeFileSync(
    path.join(stateDir, 'sessions.json'),
    JSON.stringify({
      [CLI_ID]: { desktopId: LOCAL_ID, role, team, registered: 'x' },
    }),
  )
}

const START = { session_id: CLI_ID, hook_event_name: 'SessionStart', source: 'clear' }

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-state-'))
  protocolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-protocols-'))
  docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-docs-'))
  fs.mkdirSync(path.join(docsDir, 'agents'))
  fs.mkdirSync(path.join(stateDir, 'teams'))
  fs.writeFileSync(
    path.join(protocolsDir, 'alpha.md'),
    proto('alpha', 'shift (default)', ['1. Alpha rule.']),
  )
  fs.writeFileSync(
    path.join(protocolsDir, 'beta.md'),
    proto('beta', 'shift', ['1. Beta rule one.', '2. Beta rule two.']),
  )
})

describe('the protocol hook', () => {
  it('prints only the active protocols on a prompt', () => {
    fs.writeFileSync(
      path.join(stateDir, 'protocols.json'),
      JSON.stringify({ active: ['beta'], changed: null, by: null }),
    )
    const r = runHook({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('Active protocols: beta')
    expect(r.out).toContain('2. Beta rule two.')
    expect(r.out).not.toContain('Alpha rule')
    expect(r.out).not.toContain('Session id')
  })

  it('falls back to the group default with no state file', () => {
    const r = runHook({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' })
    expect(r.out).toContain('Active protocols: alpha')
  })

  it('prints one warning line when the state file is unreadable', () => {
    fs.writeFileSync(path.join(stateDir, 'protocols.json'), '{bad')
    const r = runHook({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' })
    expect(r.out).toContain('protocols.json unreadable, defaults applied')
    expect(r.out).toContain('Active protocols: alpha')
  })

  it('on session start prints both ids, the state file, then the manual', () => {
    fs.writeFileSync(path.join(docsDir, 'agents', 'tech-lead.md'), '# Tech lead manual\n')
    fs.writeFileSync(path.join(docsDir, 'agents', 'ba.md'), '# BA manual\n')
    fs.writeFileSync(path.join(stateDir, 'teams', 'alpha.md'), '# Alpha state\n')
    register('tech-lead', 'alpha')
    const r = runHook(START)
    expect(r.out).toContain(
      `Session id: ${CLI_ID}. Desktop id: ${LOCAL_ID}. Registered as tech-lead alpha.`,
    )
    expect(r.out).toContain('# Tech lead manual')
    expect(r.out).not.toContain('# BA manual')
    expect(r.out.indexOf('# Alpha state')).toBeGreaterThan(-1)
    expect(r.out.indexOf('# Alpha state')).toBeLessThan(r.out.indexOf('# Tech lead manual'))
  })

  it('injects the BA state file for a registered ba (M15)', () => {
    fs.writeFileSync(path.join(docsDir, 'agents', 'ba.md'), '# BA manual\n')
    fs.writeFileSync(path.join(stateDir, 'ba.md'), '# BA state file\n')
    register('ba', null)
    const r = runHook(START)
    expect(r.out).toContain('# BA manual')
    expect(r.out).toContain('# BA state file')
  })

  it('gives a registered both the core, a BA line, the team file and a BA state pointer', () => {
    fs.writeFileSync(path.join(docsDir, 'agents', 'tech-lead.md'), '# Tech lead manual\n')
    fs.writeFileSync(path.join(docsDir, 'agents', 'ba.md'), '# BA manual\n')
    fs.writeFileSync(path.join(stateDir, 'teams', 'alpha.md'), '# Alpha state\n')
    fs.writeFileSync(path.join(stateDir, 'ba.md'), '# BA state file\n')
    register('both', 'alpha')
    const r = runHook(START)
    expect(r.out).toContain('# Tech lead manual')
    expect(r.out).toContain('# Alpha state')
    expect(r.out).not.toContain('# BA manual')
    expect(r.out).not.toContain('# BA state file')
    expect(r.out).toContain(
      `You are also the BA: read ${path.resolve(docsDir, 'agents', 'ba.md')} before your first reply.`,
    )
    expect(r.out).toContain(path.resolve(stateDir, 'ba.md'))
  })

  it('gives an unregistered session no manual, only the registration block', () => {
    fs.writeFileSync(path.join(docsDir, 'agents', 'tech-lead.md'), '# Tech lead manual\n')
    fs.writeFileSync(path.join(docsDir, 'agents', 'ba.md'), '# BA manual\n')
    fs.writeFileSync(path.join(stateDir, 'teams', 'alpha.md'), '# Alpha state\n')
    fs.writeFileSync(path.join(stateDir, 'teams', 'bravo.md'), '# Bravo state\n')
    const r = runHook(START)
    expect(r.out).toContain(`Session id: ${CLI_ID}. Desktop id: unknown until you register.`)
    expect(r.out).toContain('Not registered. Your title decides your role')
    expect(r.out).toContain('Existing team files: alpha, bravo')
    expect(r.out).toContain(path.resolve(docsDir, 'agents', 'tech-lead.md'))
    expect(r.out).toContain(path.resolve(docsDir, 'agents', 'ba.md'))
    expect(r.out).not.toContain('# Tech lead manual')
    expect(r.out).not.toContain('# BA manual')
    expect(r.out).not.toContain('# Alpha state')
    expect(r.out).not.toContain('You are also the BA')
  })

  it('never blocks a session: a broken protocol file becomes one line and exit 0', () => {
    fs.writeFileSync(
      path.join(protocolsDir, 'broken.md'),
      '# broken\n\n## Purpose\n\nno other headings\n',
    )
    const r = runHook({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^Protocol hook error: broken: headings must be/)
  })

  it('keeps the protocols block when the session part fails', () => {
    fs.mkdirSync(path.join(stateDir, 'teams', 'alpha.md'))
    register('tech-lead', 'alpha')
    const r = runHook(START)
    expect(r.code).toBe(0)
    expect(r.out).toContain('Active protocols: alpha')
    expect(r.out).toMatch(/Protocol hook: session part failed: /)
  })

  it('survives empty stdin', () => {
    const r = spawnSync('node', [hook], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: '',
      env: hookEnv(),
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Active protocols: alpha')
  })
})

// The hooks docs cap injected output at 10,000 characters; beyond that Claude
// sees only a file path and a 2,000-character preview, which is how the old
// orchestrator manual (11,194 characters) reached sessions. These render
// against the REAL docs/ and docs/protocols/, so growing a manual or a
// protocol past the cap turns them red instead of silently pointerising.
describe('the SessionStart injection stays under the hook cap', () => {
  const CAP = 10000

  it.each([
    ['tech-lead', 'tech-lead', 'alpha', '## Safety decisions'],
    ['ba', 'ba', null, "## Keep the owner's time"],
    ['both', 'both', 'alpha', '## Safety decisions'],
  ])('registered as %s', (_label, role, team, onlyInManual) => {
    fs.writeFileSync(
      path.join(stateDir, 'protocols.json'),
      JSON.stringify({ active: ['night-shift', 'throttle'], changed: null, by: null }),
    )
    register(role as string, team)
    fs.writeFileSync(path.join(stateDir, 'ba.md'), 'b'.repeat(1500))
    fs.writeFileSync(path.join(stateDir, 'teams', 'alpha.md'), 't'.repeat(1500))
    const r = spawnSync('node', [hook], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify(START),
      env: {
        ...process.env,
        HACKBENCH_STATE_DIR: stateDir,
        HACKBENCH_PROTOCOLS_DIR: '',
        HACKBENCH_DOCS_DIR: '',
        CLAUDE_PROJECT_DIR: repoRoot,
      },
    })
    expect(r.stdout).toContain('Active protocols: night-shift, throttle')
    expect(r.stdout).toContain(onlyInManual)
    expect(r.stdout).not.toContain('too large to inject')
    expect(r.stdout.length).toBeLessThan(CAP)
  })
})

describe('the cap guard', () => {
  function dirs() {
    return { stateDir, protocolsDir, docsDir }
  }

  function renderWithManual(chars: number): string {
    fs.writeFileSync(path.join(docsDir, 'agents', 'tech-lead.md'), 'm'.repeat(chars))
    register('tech-lead', 'alpha')
    return render(START, dirs())
  }

  it('hands the state file the room before the manual (M34)', () => {
    fs.writeFileSync(
      path.join(stateDir, 'protocols.json'),
      JSON.stringify({ active: ['beta'], changed: null, by: null }),
    )
    fs.writeFileSync(path.join(stateDir, 'teams', 'alpha.md'), 't'.repeat(4000))
    const out = renderWithManual(6300)
    expect(out.length).toBeLessThan(10000)
    expect(out).toContain('t'.repeat(4000))
    expect(out).not.toContain('m'.repeat(6300))
    expect(out).toContain(`Read ${path.resolve(docsDir, 'agents', 'tech-lead.md')}`)
  })

  it('pins the threshold: 9,500 characters is injected, 9,501 is a pointer (M35)', () => {
    const base = renderWithManual(0).length
    // render ends with one newline; adding text of n characters adds n + 1 (the join) + 1 (the end).
    const fits = renderWithManual(9500 - base - 1)
    expect(fits.length).toBe(9500)
    expect(fits).not.toContain('too large to inject')
    const over = renderWithManual(9500 - base)
    expect(over).toContain('too large to inject')
    expect(over.length).toBeLessThan(9500)
  })

  it('turns a manual that would land at 9,990 into a pointer (M35)', () => {
    const base = renderWithManual(0).length
    const out = renderWithManual(9990 - base - 1)
    expect(out).toContain('too large to inject')
  })
})

describe('the hook is wired', () => {
  function commandsFor(event: string): string[] {
    const settings = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.claude/settings.json'), 'utf8'),
    )
    return (settings.hooks[event] ?? []).flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map(h => h.command),
    )
  }

  function runCommand(projectDir: string): { status: number | null; stdout: string } {
    const command = commandsFor('UserPromptSubmit').find(c => c.includes('protocol-inject.mjs'))
    const r = spawnSync(command ?? 'exit 1', {
      shell: true,
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: CLI_ID, hook_event_name: 'UserPromptSubmit' }),
      env: { ...hookEnv(), CLAUDE_PROJECT_DIR: projectDir },
    })
    return { status: r.status, stdout: r.stdout + r.stderr }
  }

  it('settings.json runs protocol-inject.mjs on SessionStart and UserPromptSubmit', () => {
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      expect(commandsFor(event).some((c: string) => c.includes('protocol-inject.mjs'))).toBe(true)
    }
  })

  // The settings command imports the script under `node -e`, where argv[1] is
  // unset; a main guard that only matched a direct invocation printed nothing.
  it('the settings.json command itself prints the active protocols', () => {
    const r = runCommand(repoRoot)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Active protocols: alpha')
  })

  it('a missing script becomes one line and exit 0, not a stack trace', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-empty-'))
    const r = runCommand(empty)
    expect(r.status).toBe(0)
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
    expect(r.stdout).toMatch(/^Protocol hook error: /)
  })
})

describe('pointers obey the cap too', () => {
  // A directory whose absolute path is exactly `total` characters long.
  function longDir(prefix: string, total: number): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const fill = total - base.length - 1
    const dir = path.join(base, 'x'.repeat(fill))
    fs.mkdirSync(dir, { recursive: true })
    expect(dir.length).toBe(total)
    return dir
  }

  it.each(['tech-lead', 'ba', 'both'])('stays under 10,000 with 199-character paths: %s', role => {
    const longDocs = longDir('hook-docs-', 199)
    fs.cpSync(path.join(repoRoot, 'docs', 'agents'), path.join(longDocs, 'agents'), {
      recursive: true,
    })
    const longState = longDir('hook-state-', 199)
    fs.mkdirSync(path.join(longState, 'teams'))
    fs.writeFileSync(path.join(longState, 'teams', 'alpha.md'), 't'.repeat(1500))
    fs.writeFileSync(path.join(longState, 'ba.md'), 'b'.repeat(1500))
    fs.writeFileSync(
      path.join(longState, 'protocols.json'),
      JSON.stringify({ active: ['night-shift', 'throttle'], changed: null, by: null }),
    )
    fs.writeFileSync(
      path.join(longState, 'sessions.json'),
      JSON.stringify({
        [CLI_ID]: {
          desktopId: LOCAL_ID,
          role,
          team: role === 'ba' ? null : 'alpha',
          registered: 'x',
        },
      }),
    )
    const out = render(START, {
      stateDir: longState,
      protocolsDir: path.join(repoRoot, 'docs', 'protocols'),
      docsDir: longDocs,
    })
    expect(out.length).toBeLessThan(10000)
  })

  // Fixed-length directories: the point where the BA line stops fitting depends
  // on path length, which differs between Windows and Linux temp directories.
  it('drops a pointer that does not fit and says more was omitted', () => {
    const longState = longDir('hook-state-', 199)
    const longDocs = longDir('hook-docs-', 199)
    fs.mkdirSync(path.join(longState, 'teams'))
    fs.mkdirSync(path.join(longDocs, 'agents'))
    fs.writeFileSync(path.join(longState, 'teams', 'alpha.md'), 't'.repeat(9000))
    fs.writeFileSync(path.join(longDocs, 'agents', 'tech-lead.md'), 'm'.repeat(6000))
    fs.writeFileSync(
      path.join(longState, 'sessions.json'),
      JSON.stringify({
        [CLI_ID]: { desktopId: LOCAL_ID, role: 'both', team: 'alpha', registered: 'x' },
      }),
    )
    const out = render(START, { stateDir: longState, protocolsDir, docsDir: longDocs })
    expect(out.length).toBeLessThan(10000)
    expect(out).toContain('(more omitted)')
  })
})

describe('a hand-edited registration', () => {
  it('treats a team name that is not a plain name as unregistered', () => {
    register('tech-lead', '../../evil')
    const r = runHook(START)
    expect(r.out).toContain('Not registered')
    expect(r.out).not.toContain('Registered as')
    expect(r.out).not.toContain('evil.md')
  })
})
