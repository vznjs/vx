import { documentedFlags, helpText, verbHelpText } from '../src/cli/help.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import { localWorkspaceSource, writeLocalWorkspace } from './helpers/local-workspace.js'
import { formatBytes } from '../src/cli/format.js'
import { parseDuration, parsePruneArgs, parseSize } from '../src/cli/cache.js'
import { parseRunArgs } from '../src/cli/run.js'
import { run } from './helpers/cli.js'
import { lock } from './helpers/orchestrator.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { planned } from './helpers/parity.js'
import { makeWorkspace } from './helpers/workspace.js'
import { writeLockClaim } from './helpers/plugin.js'
import { editDistance, nearest } from '../src/util/index.js'
import { noticed } from './helpers/notice.js'

describe('cli run()', () => {
  let stdout: string
  let stderr: string
  // Every row runs outside any workspace. An unknown verb or flag looks for
  // a task of that name to suggest, so it loads the workspace at the cwd:
  // from `packages/vx` that wrote the repo's own `.vx` cache, and under the
  // shard's sandbox, which hides the root `package.json`, it opened a stale
  // `packages/vx/.vx` and the write was refused.
  let origCwd: string
  let emptyDir: string

  beforeEach(async () => {
    stdout = ''
    stderr = ''
    origCwd = process.cwd()
    emptyDir = await mkdtemp(path.join(os.tmpdir(), 'vx-cli-run-'))
    process.chdir(emptyDir)
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    process.chdir(origCwd)
    await rm(emptyDir, { recursive: true, force: true })
  })

  it('prints help with no args', async () => {
    // Inside a workspace; outside one, a bare `vx` says there is none.
    const root = await makeWorkspace({ prefix: 'vx-cli-help-' })
    process.chdir(root)
    try {
      expect(await run([])).toBe(0)
    } finally {
      process.chdir(emptyDir)
      await rm(root, { recursive: true, force: true })
    }
    expect(stdout).toContain('Usage:')
  })

  it('prints version', async () => {
    expect(await run(['--version'])).toBe(0)
    expect(stdout).toMatch(/^vx \d/)
  })

  it('a flag before any verb is called a flag, not a command (M-60)', async () => {
    const said = async (args: string[]): Promise<[number, string]> => {
      stderr = ''
      return [await run(args), stderr]
    }
    expect([await said(['--verison']), await said(['--all']), await said(['rnu'])]).toEqual([
      [
        1,
        noticed(
          "vx: unknown flag: --verison (did you mean --version?); a verb's flags follow the verb (see `vx help`)\n",
        ),
      ],
      [1, noticed("vx: unknown flag: --all; a verb's flags follow the verb (see `vx help`)\n")],
      // CONTROL: a word without a dash is still a command.
      [1, noticed('vx: unknown command: rnu. Did you mean run? (see `vx help`)\n')],
    ])
  })

  it('vx watch names its own help, and vx cache its one subcommand (M-58)', async () => {
    const said = async (args: string[]): Promise<[number, string]> => {
      stderr = ''
      return [await run(args), stderr]
    }
    expect([
      // `watch` reads `run`'s flags, and pointed at `vx run --help`.
      await said(['watch', 'build', '--debounce=abc']),
      await said(['watch', 'build', '--filtr=app']),
      // A refused value points at the verb's help too, not only an unknown flag.
      await said(['watch', 'build', '--concurrency', 'abc']),
      await said(['run', 'build', '--output-logs=loud']),
      await said(['cache', 'bogus']),
      // CONTROL: a near miss keeps its one name.
      await said(['cache', 'claen']),
    ]).toEqual([
      [1, noticed('vx watch: unknown flag: --debounce=abc (see `vx watch --help`)\n')],
      [
        1,
        noticed(
          'vx watch: unknown flag: --filtr=app (did you mean --filter?) (see `vx watch --help`)\n',
        ),
      ],
      [
        1,
        noticed(
          "vx watch: --concurrency must be a positive integer, or a share of the cores like '50%' (got abc) (see `vx watch --help`)\n",
        ),
      ],
      [
        1,
        noticed(
          "vx run: --output-logs must be one of 'full', 'errors-only', 'hash-only', 'none' (got loud) (see `vx run --help`)\n",
        ),
      ],
      [
        1,
        noticed(
          'vx cache: unknown subcommand: bogus. Its one subcommand is `vx cache clean` (see `vx cache --help`)\n',
        ),
      ],
      [
        1,
        noticed(
          'vx cache: unknown subcommand: claen. Did you mean clean? (see `vx cache --help`)\n',
        ),
      ],
    ])
  })

  // Every verb answered `unknown flag: --help` and exited 1 until
  // 2026-09-04 — the one thing every user types first. The list is the
  // dispatcher's own verbs; a new verb that forgets this fails here.
  it.each(['run', 'watch', 'cache', 'lock', 'init', 'upgrade', 'show', 'info', 'why', 'last'])(
    '`vx %s --help` prints help and exits 0',
    async (verb) => {
      expect(await run([verb, '--help'])).toBe(0)
      expect(stdout).toContain('Usage:')
      expect(stderr).toBe('')
    },
  )

  // `vx help run` printed the whole reference until item 1035: the
  // argument was dropped. It is the same cut `vx run --help` prints.
  it('`vx help <verb>` prints that verb’s help, the whole reference with no verb', async () => {
    expect(await run(['run', '--help'])).toBe(0)
    const cut = stdout
    stdout = ''
    expect(await run(['help', 'run'])).toBe(0)
    expect(stdout).toBe(cut)
    stdout = ''
    expect(await run(['help'])).toBe(0)
    const whole = stdout
    expect(whole).not.toBe(cut)
    expect(stderr).toBe('')
    // A name that is no verb is a typo, answered as `vx rnu` is, not with
    // the whole reference and no word.
    stdout = ''
    expect(await run(['help', 'rnu'])).toBe(1)
    expect(await run(['help', 'no-such-verb'])).toBe(1)
    expect({ stdout, stderr }).toEqual({
      stdout: '',
      stderr:
        noticed('vx help: unknown command: rnu. Did you mean run? (see `vx help`)\n') +
        noticed('vx help: unknown command: no-such-verb (see `vx help`)\n'),
    })
  })

  // `vx help run extra` printed run's help and exited 0: a word it takes
  // no more of is refused, as `vx version extra` is.
  it('`vx help <verb> <more>` refuses the extra word', async () => {
    expect(await run(['help', 'run', 'extra'])).toBe(1)
    expect({ stdout, stderr }).toEqual({
      stdout: '',
      stderr: noticed('vx help: unexpected argument: extra (see `vx help`)\n'),
    })
  })

  // Every argument error points at the verb's own help, which is only
  // useful because `vx <verb> --help` prints something (same day). A verb
  // that grows a new parser and forgets the pointer fails here.
  it.each([
    ['show', ['show', '--json']],
    ['run', ['run', '--concurency', '2', 'build']],
    ['last', ['last', '--lst']],
    ['init', ['init', '--dyr']],
    ['why', ['why', '--fmt', 'x']],
    ['lock', ['lock', '--chk']],
    ['info', ['info', 'extra']],
    ['cache', ['cache', 'bogus']],
    ['upgrade', ['upgrade', '--forse']],
  ])('a bad argument to `%s` points at its help', async (verb, argv) => {
    // Some verbs print and return non-zero, others throw a UserError that
    // `bin.ts` prints. Both are the same thing to a user, so accept either.
    let thrown = ''
    try {
      expect(await run(argv)).not.toBe(0)
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err)
    }
    expect(`${stdout}${stderr}${thrown}`).toContain(`vx ${verb} --help`)
  })

  it('`-h` works the same, and a `--` forwarded `--help` is the task’s, not ours', async () => {
    expect(await run(['show', '-h'])).toBe(0)
    expect(stdout).toContain('Usage:')
    stdout = ''
    // Past `--` the flag belongs to the command being run, so vx must NOT
    // answer it: this reaches task resolution (and fails there) instead of
    // printing help.
    //
    // In a throwaway workspace, never this repo. `run` loads the workspace it
    // is standing in and memoizes each config evaluation in `.vx/cache` — a
    // WRITE, which the suite's own sandbox refuses (`SQLITE_READONLY`), and
    // which would dirty the tree the cache hashes even when it succeeds.
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-cli-help-'))
    const origCwd = process.cwd()
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', workspaces: ['p'] }),
      )
      await writeLocalWorkspace(root)
      await mkdir(path.join(root, 'p'), { recursive: true })
      await writeFile(path.join(root, 'p', 'package.json'), JSON.stringify({ name: 'p' }))
      await writeFile(
        path.join(root, 'p', 'vx.config.mjs'),
        `export default { tasks: { hello: { exec: { command: 'true' } } } }\n`,
      )
      for (const args of [
        ['init', '-q'],
        ['config', 'user.email', 'c@vx'],
        ['config', 'user.name', 'c'],
        ['add', '-A'],
        ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'],
      ]) {
        Bun.spawnSync({ cmd: ['git', ...args], cwd: root })
      }
      // By hand: the helper takes the forwarded `--help` for ours and skips the lock.
      await lock(root)
      process.chdir(path.join(root, 'p'))
      expect(await run(['run', 'no-such-task-xyz', '--', '--help'])).not.toBe(0)
      expect(stdout).not.toContain('Usage:')
      expect(`${stdout}${stderr}`).toContain('no-such-task-xyz')
    } finally {
      process.chdir(origCwd)
      await rm(root, { recursive: true, force: true })
    }
  })

  // Item 483. The unresolved-task refusal is enforced at THREE sites over
  // one producer (`unresolvedRequests`): the run path, the plan builder, and
  // here, the `--dry` path. Mutating each separately is the only
  // way to learn which is held — the producer fails 8 rows, the run path 5,
  // the plan builder 1, and this one NOTHING.
  //
  // It survives because the guard below it (`plan.tasks.length === 0`)
  // catches the same case and returns the same 1. What this site carries
  // ALONE is WHICH names the message blames, and the fallback blames all of
  // them. Read off the real CLI:
  //
  //   pristine:  vx run: no projects declare task(s): typo-here.
  //   disabled:  vx run: no projects declare task(s): build, lint, typo-here.
  //
  // Two perfectly good tasks named as the problem. The run path pins this
  // precision five times over ("a bogus BARE task fails the run even when
  // another task resolves"); the dry-run path had nothing, which is the same
  // user-facing rule pinned on one path and unpinned on the other.
  it('a --dry typo beside good tasks names ONLY the typo', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-cli-dry-typo-'))
    const origCwd = process.cwd()
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', workspaces: ['p'] }),
      )
      await writeLocalWorkspace(root)
      await mkdir(path.join(root, 'p'), { recursive: true })
      await writeFile(path.join(root, 'p', 'package.json'), JSON.stringify({ name: 'p' }))
      await writeFile(
        path.join(root, 'p', 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'true' } }, lint: { exec: { command: 'true' } } } }\n`,
      )
      for (const args of [
        ['init', '-q'],
        ['config', 'user.email', 'c@vx'],
        ['config', 'user.name', 'c'],
        ['add', '-A'],
        ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'],
      ]) {
        Bun.spawnSync({ cmd: ['git', ...args], cwd: root })
      }
      process.chdir(root)
      expect(await run(['run', 'build', 'lint', 'typo-here', '--all', '--dry'])).toBe(1)
      // The control, and the whole point: the names that DO resolve are not
      // among the unresolved; they appear only as what exists (M-56). The
      // whole line, because `toContain` would pass on the fallback's wording.
      expect(stderr).toBe(
        noticed(
          'vx run: no projects declare task(s): typo-here. Tasks: build, lint. A run reads the lock: after editing a vx.config, run `vx lock`.\n',
        ),
      )
    } finally {
      process.chdir(origCwd)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('--dry hints the nearest task, as the run does (E-29)', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-cli-dry-hint-'))
    const origCwd = process.cwd()
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', workspaces: ['p'] }),
      )
      await writeLocalWorkspace(root)
      await mkdir(path.join(root, 'p'), { recursive: true })
      await writeFile(path.join(root, 'p', 'package.json'), JSON.stringify({ name: 'p' }))
      await writeFile(
        path.join(root, 'p', 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      process.chdir(root)
      expect(await run(['run', 'biuld', '--all', '--dry'])).toBe(1)
      expect(stderr).toBe(
        noticed('vx run: no projects declare task(s): biuld. Did you mean build?'),
      )
    } finally {
      process.chdir(origCwd)
      await rm(root, { recursive: true, force: true })
    }
  })

  it("every verb's unknown flag is named a flag and hints the nearest flag it accepts, as vx run's does", async () => {
    // Each verb parses its own flags; only `vx run` hinted one. The hint set
    // is the verb's own usage line (`acceptedFlags`), so `--format` is
    // offered where it is accepted and nowhere else.
    const said: string[] = []
    for (const argv of [
      ['info', '--formt'],
      ['lock', '--chek'],
      ['init', '--forse'],
      ['last', '--lst'],
      ['show', '--formt'],
      ['why', 'x', '--rn', '1'],
      ['cache', 'clean', '--dry-rn'],
      ['cache', 'clean', '--dry-run'],
      ['run', 'build', '--dry-run'],
      ['run', 'build', '--concurency', '2'],
      ['info', '--json'],
      ['last', '--json'],
      ['show', '--json'],
      // CONTROL: a verb with no --format gets no such hint.
      ['upgrade', '--json'],
      // CONTROL: a positional is not a flag, and gets no hint, even one two
      // edits from a flag the verb takes.
      ['info', 'format'],
      ['lock', 'foo'],
      ['cache', 'clean', 'foo'],
    ]) {
      stderr = ''
      // `last` and `why` refuse by throwing, which bin.ts prints as-is.
      const code = await run(argv).catch((e: Error) => {
        stderr += `${e.message}\n`
        return 1
      })
      expect(code).toBe(1)
      said.push(stderr.trimEnd())
    }
    expect(said).toEqual([
      noticed(
        'vx info: unknown flag: --formt (did you mean --format?) (see `vx info --help`)',
      ).trimEnd(),
      noticed(
        'vx lock: unknown flag: --chek (did you mean --check?) (see `vx lock --help`)',
      ).trimEnd(),
      noticed(
        'vx init: unknown flag: --forse (did you mean --force?) (see `vx init --help`)',
      ).trimEnd(),
      'vx last: unknown flag: --lst (did you mean --list?) (see `vx last --help`)',
      noticed(
        'vx show: unknown flag: --formt (did you mean --format?) (see `vx show --help`)',
      ).trimEnd(),
      'vx why: unknown flag: --rn (did you mean --run?) (see `vx why --help`)',
      noticed(
        'vx cache clean: unknown flag: --dry-rn (did you mean --dry?) (see `vx cache --help`)',
      ).trimEnd(),
      noticed(
        'vx cache clean: unknown flag: --dry-run (did you mean --dry?) (see `vx cache --help`)',
      ).trimEnd(),
      noticed(
        'vx run: unknown flag: --dry-run (did you mean --dry?) (see `vx run --help`)',
      ).trimEnd(),
      noticed(
        'vx run: unknown flag: --concurency (did you mean --concurrency?) (see `vx run --help`)',
      ).trimEnd(),
      noticed(
        'vx info: unknown flag: --json (did you mean --format json?) (see `vx info --help`)',
      ).trimEnd(),
      'vx last: unknown flag: --json (did you mean --format json?) (see `vx last --help`)',
      noticed(
        'vx show: unknown flag: --json (did you mean --format json?) (see `vx show --help`)',
      ).trimEnd(),
      noticed('vx upgrade: unknown flag: --json (see `vx upgrade --help`)').trimEnd(),
      noticed('vx info: unexpected argument: format (see `vx info --help`)').trimEnd(),
      noticed('vx lock: unexpected argument: foo (see `vx lock --help`)').trimEnd(),
      noticed('vx cache clean: unexpected argument: foo (see `vx cache --help`)').trimEnd(),
    ])
  })

  it('rejects unknown command', async () => {
    expect(await run(['nope'])).toBe(1)
    expect(stderr).toContain('unknown command')
  })

  // Service features (serve/dev, dashboard, remote cache, distribution) come
  // from PLUGINS, not core. Core keeps a neutral hint for the common
  // muscle-memory verbs but must name NO specific plugin package — core has
  // zero references to any cloud/service package.
  it.each(['serve', 'dev'])("gives a neutral, plugin-pointing hint for '%s'", async (cmd) => {
    // Outside any workspace: in one whose project declares `dev` (this
    // repo does), the task's own `vx run` line is the answer (task-verb.test.ts).
    const os = await import('node:os')
    const { mkdtemp } = await import('node:fs/promises')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-cli-noservice-'))
    const origCwd = process.cwd()
    process.chdir(dir)
    try {
      expect(await run([cmd])).toBe(1)
    } finally {
      process.chdir(origCwd)
      await rm(dir, { recursive: true, force: true })
    }
    // One fact a line, each sentence whole: the message's own line breaks
    // once cut "See the plugin" from "guide: https://…".
    expect(stderr).toBe(
      `✗ vx  \`${cmd}\` is not a vx core command\n\n` +
        '  vx core runs tasks in-process\n' +
        '  A dashboard, remote cache and distributed execution come from plugins, not core\n' +
        '  See the plugin guide: https://vznjs.github.io/vx/docs/plugins/\n',
    )
    // Core must not name any specific service package.
    expect(stderr).not.toContain('vx-cloud')
    expect(stderr).not.toContain('@vzn/vx-cloud')
  })

  it('rejects run with no task — and says why the picker did not open', async () => {
    // The suite's stdin is not a terminal, so this is the non-TTY refusal,
    // not the picker: the line says so, or a user in CI is left wondering
    // why nothing was asked (item 621).
    // Outside any workspace there are no task names to offer.
    const origCwd = process.cwd()
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-run-no-task-'))
    try {
      process.chdir(dir)
      expect(await run(['run'])).toBe(1)
    } finally {
      process.chdir(origCwd)
      await rm(dir, { recursive: true, force: true })
    }
    expect(stderr).toBe(
      noticed(
        'vx run: missing task name (stdin is not a TTY, so no picker; vx run <task>, e.g. vx run build) (see `vx run --help`)\n',
      ),
    )
  })

  it('rejects run with bad flag value (parser error surfaced)', async () => {
    expect(await run(['run', 'build', '--concurrency', 'oops'])).toBe(1)
    expect(stderr).toContain('--concurrency must be')
  })

  it('--version is the only version form (no -V short alias)', async () => {
    expect(await run(['--version'])).toBe(0)
    expect(stdout).toMatch(/^vx \d/)
  })

  it('-V is rejected as unknown, pointing at --version (M-60)', async () => {
    expect(await run(['-V'])).toBe(1)
    expect(stderr).toBe(
      noticed(
        "vx: unknown flag: -V (did you mean --version?); a verb's flags follow the verb (see `vx help`)\n",
      ),
    )
  })
})

// vx requires git for input enumeration; every fixture workspace
// gets a quiet repo via this helper before chdir.
function initGitRepo(cwd: string): void {
  const run = (...args: string[]): void => {
    Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }
  run('init', '-q')
  run('config', 'user.email', 'test@vx.local')
  run('config', 'user.name', 'vx test')
}

describe('cli run() end-to-end against a real fixture workspace', () => {
  let workspaceRoot: string
  const origCwd = process.cwd()
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    // Output defaults are env-sensitive (truthy CI → full grouped
    // output). Pin a non-CI env so assertions on the flow defaults
    // hold both locally and on GitHub Actions.
    savedEnv['CI'] = process.env['CI']
    savedEnv['GITHUB_ACTIONS'] = process.env['GITHUB_ACTIONS']
    delete process.env['CI']
    delete process.env['GITHUB_ACTIONS']
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-cli-e2e-'))
    await writeFile(
      path.join(workspaceRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
    )
    await writeFile(
      path.join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: 'root', private: true }),
    )
    await writeLocalWorkspace(workspaceRoot)
    const pkgDir = path.join(workspaceRoot, 'packages', 'one')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'one', version: '0.0.0' }),
    )
    await writeFile(
      path.join(pkgDir, 'vx.config.mjs'),
      `export default {
        tasks: {
          hello: {
            exec: { command: "echo hello-cli" },
            inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
          },
        },
      }`,
    )
    initGitRepo(workspaceRoot)
    process.chdir(workspaceRoot)
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    process.chdir(origCwd)
    const { rm } = await import('node:fs/promises')
    await rm(workspaceRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('--dry-run prints a plan, never invokes the task, exits 0', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', '--all', 'hello', '--dry'])
    expect(code).toBe(0)
    expect(stdout).toContain('would run:')
    expect(stdout).toContain('one#hello')
    // The actual task would have echoed `hello-cli`; it must NOT run.
    expect(stdout).not.toContain('hello-cli')
  })

  // `--dry` called a cacheable task under a policy that reads and writes
  // nothing `no-cache`, the real run `miss` and its footer "1 miss": a
  // miss is a lookup that failed, and this run looked nothing up.
  for (const flag of ['--no-cache', '--cache-policy=local:']) {
    it(`${flag}: the plan and the run both call the task no-cache`, async () => {
      let stdout = ''
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      expect(await run(['run', '--all', 'hello', flag, '--dry'])).toBe(0)
      expect(stdout).toContain('no-cache (would exec)')
      stdout = ''
      expect(await run(['run', '--all', 'hello', flag])).toBe(0)
      expect(stdout).toMatch(/\n {12}local 1∅\n/)
      expect(stdout).not.toContain('miss')
    })
  }

  it('--dry-run --json emits parseable JSON', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', '--all', 'hello', '--dry=json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout) as { tasks: Array<Record<string, unknown>> }
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.tasks[0]?.['id']).toBe('one#hello')
    expect(parsed.tasks[0]?.['cacheStatus']).toBe('miss')
  })

  it('--all is a broad run: executed one-liner, raw output suppressed', async () => {
    let stdout = ''
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })

    const code = await run(['run', '--all', 'hello'])
    expect(code).toBe(0)
    expect(stdout).toContain('success miss     one#hello')
    expect(stdout).not.toContain('hello-cli')
  })

  it('errors when at workspace root with no scope flag (default = current project)', async () => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })

    const code = await run(['run', 'hello'])
    expect(code).toBe(1)
    expect(stderr).toBe(
      noticed(
        'vx run: not inside a project: run from a project directory, or pass --all or --filter <pattern> (see `vx run --help`)\n',
      ),
    )
    stderr = ''
    expect(await run(['watch', 'hello'])).toBe(1)
    expect(stderr).toBe(
      noticed(
        'vx watch: not inside a project: run from a project directory, or pass --all or --filter <pattern> (see `vx watch --help`)\n',
      ),
    )
  })

  it('cwd inside a project package resolves to that project', async () => {
    const path = await import('node:path')
    process.chdir(path.join(workspaceRoot, 'packages', 'one'))
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', 'hello'])
    expect(code).toBe(0)
    expect(stdout).toContain('hello-cli')
  })

  it('cwd inside a member reached through a link resolves to that member (item 1025)', async () => {
    // `cd packages/two` where `packages/two -> ../ext/two`: the kernel's
    // cwd is `ext/two`, discovery keeps `packages/two`, and the run said
    // "not inside a project".
    const path = await import('node:path')
    const { mkdir, symlink, writeFile } = await import('node:fs/promises')
    const real = path.join(workspaceRoot, 'ext', 'two')
    await mkdir(real, { recursive: true })
    await writeFile(path.join(real, 'package.json'), JSON.stringify({ name: 'two' }))
    await writeFile(
      path.join(real, 'vx.config.mjs'),
      `export default { tasks: { hello: { exec: { command: "echo hello-two" } } } }`,
    )
    await symlink(path.join('..', 'ext', 'two'), path.join(workspaceRoot, 'packages', 'two'))
    process.chdir(path.join(workspaceRoot, 'packages', 'two'))
    let stdout = ''
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })

    const code = await run(['run', 'hello'])
    expect({ code, ran: stdout.includes('hello-two'), stderr }).toEqual({
      code: 0,
      ran: true,
      stderr: '',
    })
  })

  it('an --exclude-dependencies name no project declares is refused, with the nearest (item 1026)', async () => {
    // `=helo` dropped nothing and the run went on, exit 0: a typo the flag
    // never reported.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const outcome = (args: string[]): Promise<number | string> =>
      run(args).then(
        (code) => code,
        (err: Error) => `${err.name}: ${err.message}`,
      )
    // `gen` is declared only by `two`, which a run scoped to `one` does not
    // load: it is judged against the workspace, not refused.
    const path = await import('node:path')
    const { mkdir, writeFile } = await import('node:fs/promises')
    const two = path.join(workspaceRoot, 'packages', 'two')
    await mkdir(two, { recursive: true })
    await writeFile(path.join(two, 'package.json'), JSON.stringify({ name: 'two' }))
    await writeFile(
      path.join(two, 'vx.config.mjs'),
      `export default { tasks: { gen: { exec: { command: "true" } } } }`,
    )
    process.chdir(path.join(workspaceRoot, 'packages', 'one'))
    expect({
      typo: await outcome(['run', 'one#hello', '--exclude-dependencies=helo']),
      known: await outcome(['run', 'one#hello', '--exclude-dependencies=hello']),
      elsewhere: await outcome(['run', 'hello', '--exclude-dependencies=gen']),
    }).toEqual({
      typo: 'UserError: --exclude-dependencies names a task no project declares: helo. Did you mean hello?',
      known: 0,
      elsewhere: 0,
    })
  })

  it('pkg#task syntax targets a specific project', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', 'one#hello'])
    expect(code).toBe(0)
    expect(stdout).toContain('hello-cli')
  })

  it('-F filter selects matching projects (broad: executed one-liner)', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', '--filter', 'one', 'hello'])
    expect(code).toBe(0)
    expect(stdout).toContain('success miss     one#hello')
    expect(stdout).not.toContain('hello-cli')
  })

  it('-F with no match errors clearly', async () => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })

    const code = await run(['run', '--filter', 'nope', 'hello'])
    expect(code).toBe(1)
    expect(stderr).toContain('no projects matched')
  })

  it('--affected with an empty change set exits 0 (nothing affected is not an error)', async () => {
    // A docs-only commit must not red the CI recipe
    // `vx run lint test build --affected=origin/<base>`.
    const commit = (...args: string[]): void => {
      Bun.spawnSync({
        cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
        cwd: workspaceRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      })
    }
    commit('add', '.')
    commit('commit', '-q', '-m', 'baseline')

    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })

    const code = await run(['run', '--affected=HEAD', 'hello'])
    expect(code).toBe(0)
    expect(stderr).toContain('nothing affected')
    expect(stderr).not.toContain('no projects matched')
  })

  it('when nothing matches at all, one error line names the patterns and the nearest project', async () => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    const code = await run(['run', '--filter', 'oen', 'hello'])
    expect(code).not.toBe(0)
    // The per-pattern warning is folded into the error: one line, not two
    // saying the same thing (the init walkthrough, 2026-09-04).
    expect(stderr).not.toContain('matched no projects')
    expect(stderr).toContain('no projects matched filter(s): oen\n\n  fix  one\n')
  })

  it('a `../` path filter is not a path form — refused loud, naming the pattern (parity L2)', async () => {
    // `./` is root-relative in vx by documented choice, so `../apps/*`
    // (Turbo's cwd-relative sibling form) has no meaning here; it falls
    // through to the name matcher and must say so, not select nothing
    // quietly.
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    const code = await run(['run', '--filter', '../packages/*', 'hello'])
    expect(code).not.toBe(0)
    expect(stderr).toContain('no projects matched filter(s): ../packages/*')
  })

  it('a filter that matched but walked to nothing, or names no project, says so (item 1030)', async () => {
    // `...^one` matched `one`, which nothing depends on, and was reported as
    // a typo; `...` was hinted "Did you mean one?"; a bare `!` excluded
    // nothing and every project ran.
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    const said = async (filter: string): Promise<[number, string]> => {
      stderr = ''
      const code = await run(['run', '--filter', filter, 'hello'])
      return [code, stderr.trim()]
    }
    expect([
      await said('...^one'),
      await said('one^...'),
      await said('...'),
      await said('!'),
    ]).toEqual([
      [
        1,
        noticed(
          'vx run: no projects selected: filter "...^one" matched one, and no project depends on it',
        ).trimEnd(),
      ],
      [
        1,
        noticed(
          'vx run: no projects selected: filter "one^..." matched one, which depends on no project',
        ).trimEnd(),
      ],
      [1, noticed('vx run: filter "..." names no project').trimEnd()],
      [1, noticed('vx run: filter "!" names no project').trimEnd()],
    ])
  })

  it('an exclusion that takes back every match says so, not "no projects matched"', async () => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    const code = await run(['run', '--filter', 'one', '--filter', '!one', 'hello'])
    expect([code, stderr.trim()]).toEqual([
      1,
      noticed(
        'vx run: no projects selected: !one excluded every project the other filters matched',
      ).trimEnd(),
    ])
  })

  it('a filter that matches nothing warns, even when another one matched', async () => {
    let stdout = ''
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })

    const code = await run(['run', '--filter', 'one', '--filter', 'noSuchPkg', 'hello'])
    expect(code).toBe(0)
    expect(stdout).toContain('success miss     one#hello')
    expect(stderr).toContain('noSuchPkg')
    expect(stderr).toContain('matched no projects')
  })

  it('-v prints a verbose summary table', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', '--all', '--verbosity', '1', 'hello'])
    expect(code).toBe(0)
    expect(stdout).toContain('TASK')
    expect(stdout).toContain('one#hello')
  })

  it('--verbosity 1: the table lists no group and prints above the footer', async () => {
    const { writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    await writeFile(
      path.join(workspaceRoot, 'packages', 'one', 'vx.config.mjs'),
      `export default {
        tasks: {
          hello: {
            exec: { command: "echo hello-cli" },
            inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
          },
          all: { dependsOn: ['hello'] },
        },
      }`,
    )
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(await run(['run', '--all', '--verbosity', '1', 'all'])).toBe(0)
    const lines = stdout.split('\n')
    const header = lines.findIndex((l) => l.startsWith('TASK'))
    const rows = lines.slice(header + 2, lines.indexOf('', header))
    // The footer counts no group; a `success 0ms` row for one
    // invented a task with no command.
    expect(rows.map((r) => r.split(/\s+/)[0])).toEqual(['one#hello'])
    // Nothing prints below the footer (owner rule).
    const footer = lines.findIndex((l) => l.startsWith('─ vx '))
    expect(header).toBeGreaterThan(-1)
    expect(footer).toBeGreaterThan(header)
  })

  it('exits 1 when a task fails', async () => {
    const { writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    await writeFile(
      path.join(workspaceRoot, 'packages', 'one', 'vx.config.mjs'),
      `export default {
        tasks: {
          fail: {
            exec: { command: "exit 9" },
          },
        },
      }`,
    )

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', '--all', 'fail'])
    expect(code).toBe(1)
  })

  it('honors -F and --concurrency through to the orchestrator', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await run(['run', 'hello', '--filter', 'one', '--concurrency', '1'])
    expect(code).toBe(0)
  })

  it('forwards `--` args to the underlying command', async () => {
    const { writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    await writeFile(
      path.join(workspaceRoot, 'packages', 'one', 'vx.config.mjs'),
      `export default {
        tasks: {
          echo: {
            exec: { command: "echo forwarded:" },
          },
        },
      }`,
    )

    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run([
      'run',
      '--all',
      'echo',
      '--output-logs',
      'full',
      '--',
      'hello',
      'world',
    ])
    expect(code).toBe(0)
    expect(stdout).toMatch(/forwarded: hello world/)
  })
})

describe('vx watch command (parser-side validation)', () => {
  let stdout: string
  let stderr: string

  beforeEach(() => {
    stdout = ''
    stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects watch with no task name, and says how to name one', async () => {
    expect(await run(['watch'])).toBe(1)
    expect(stderr).toBe(
      noticed(
        'vx watch: missing task name (vx watch <task>, e.g. vx watch build) (see `vx watch --help`)\n',
      ),
    )
  })

  it('rejects watch with --dry, and points at its help as every refusal does', async () => {
    expect(await run(['watch', 'build', '--dry'])).toBe(1)
    expect(stderr).toBe(
      noticed('vx watch: --dry is not supported in watch mode (see `vx watch --help`)\n'),
    )
  })

  it('rejects watch with --profile', async () => {
    expect(await run(['watch', 'build', '--profile'])).toBe(1)
    expect(stderr).toBe(
      noticed(
        'vx watch: --profile is not supported in watch mode (would overwrite per cycle) (see `vx watch --help`)\n',
      ),
    )
  })

  it('surfaces parser errors with the watch prefix', async () => {
    expect(await run(['watch', 'build', '--concurrency', 'oops'])).toBe(1)
    expect(stderr).toStartWith('✗ vx watch  ')
    expect(stderr).toContain('--concurrency must be')
  })
})

describe('vx watch end-to-end against a real fixture workspace', () => {
  let workspaceRoot: string
  const origCwd = process.cwd()
  const savedEnv: Record<string, string | undefined> = {}
  // Track the running watch loop so afterEach can tear it down BEFORE rm'ing
  // the workspace. Under heavy CI load a `waitFor` can time out and throw
  // before a test reaches its own `process.emit('SIGINT')`, leaving the loop
  // running; rm'ing its cwd then makes its next git cycle fail with "Unable to
  // read current working directory" (and cascade into the next test). The
  // `settled` flag guards against a double SIGINT after the loop already exited
  // (which would hit Node's default handler and kill the runner).
  let activeCmd: Promise<number> | undefined
  let activeSettled = true
  const startWatch = (args: string[]): Promise<number> => {
    activeSettled = false
    const p = run(args) as Promise<number>
    void p.then(
      () => {
        activeSettled = true
      },
      () => {
        activeSettled = true
      },
    )
    activeCmd = p
    return p
  }

  beforeEach(async () => {
    savedEnv['CI'] = process.env['CI']
    savedEnv['GITHUB_ACTIONS'] = process.env['GITHUB_ACTIONS']
    delete process.env['CI']
    delete process.env['GITHUB_ACTIONS']
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-e2e-'))
    await writeFile(
      path.join(workspaceRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
    )
    await writeFile(
      path.join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: 'root', private: true }),
    )
    await writeLocalWorkspace(workspaceRoot)
    const pkgDir = path.join(workspaceRoot, 'packages', 'one')
    await mkdir(pkgDir, { recursive: true })
    await mkdir(path.join(pkgDir, 'src'), { recursive: true })
    await writeFile(path.join(pkgDir, 'src', 'index.txt'), 'v0')
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'one', version: '0.0.0' }),
    )
    await writeFile(
      path.join(pkgDir, 'vx.config.mjs'),
      `export default {
        tasks: {
          hello: {
            exec: { command: "cat src/index.txt" },
            inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
          },
        },
      }`,
    )
    initGitRepo(workspaceRoot)
    process.chdir(workspaceRoot)
  })

  afterEach(async () => {
    // Tear down a still-running loop (a test that threw mid-body) BEFORE rm, so
    // an orphaned watch cycle never runs against a deleted cwd.
    if (activeCmd !== undefined && !activeSettled) {
      process.emit('SIGINT')
      await Promise.race([
        activeCmd.catch(() => undefined),
        new Promise((r) => setTimeout(r, 8000)),
      ])
    }
    activeCmd = undefined
    activeSettled = true
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    process.chdir(origCwd)
    const { rm } = await import('node:fs/promises')
    await rm(workspaceRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it(
    'a task with no cache block that writes into its project does not re-trigger itself forever',
    async () => {
      const path = await import('node:path')
      const { writeFile } = await import('node:fs/promises')
      // No `cache` block ⇒ no declared outputs ⇒ nothing is ignored by path;
      // the command writes `out.txt` inside the project on every run. Before
      // the content check the watcher re-ran on its own write without end
      // (reproduced on the init walkthrough, 2026-09-04).
      await writeFile(
        path.join(workspaceRoot, 'packages', 'one', 'vx.config.mjs'),
        `export default {
          tasks: {
            hello: { exec: { command: "cat src/index.txt > out.txt" } },
          },
        }`,
      )
      let stdout = ''
      watchOut = () => stdout
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stdout += String(chunk) // stderr too: the poller swap says why a cycle is late
        return true
      })
      const cmd = startWatch(['watch', '--all', 'hello'])
      await waitFor(() => stdout.includes('watching 1 project'))
      await writeFile(path.join(workspaceRoot, 'packages', 'one', 'src', 'index.txt'), 'v1')
      await waitFor(() => /^changed /m.test(stdout))
      // Long enough for a runaway loop (cycles take ~30 ms) to show itself.
      await new Promise((r) => setTimeout(r, 600))
      process.emit('SIGINT')
      expect(await cmd).toBe(0)
      const reRuns = (stdout.match(/^changed /gm) ?? []).length
      // The edit, plus at most one run its own write re-triggered before
      // the bytes were known.
      expect(reRuns).toBeLessThanOrEqual(2)
    },
    { timeout: 90_000 },
  )

  it(
    're-runs the task after a file change, then exits on SIGINT',
    async () => {
      const path = await import('node:path')
      const { writeFile } = await import('node:fs/promises')

      let stdout = ''
      watchOut = () => stdout
      let stderr = ''
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr += String(chunk)
        return true
      })

      // --output-logs full: watch cycles inherit the broad flow from
      // --all, which suppresses task output; the override keeps the
      // content assertions on `cat`'s output meaningful.
      const cmd = startWatch(['watch', '--all', 'hello', '--output-logs', 'full'])

      // Wait for the loop to say it is WATCHING, not merely for the initial
      // run's output: `runWatchLoop` installs its fs.watch handles only after
      // that output is flushed, so a write racing that gap is dropped by the
      // OS and no re-run ever fires. A lost event cannot be waited out, which
      // is why raising the timeout never fixed this. Every sibling test below
      // already waits on this line.
      await waitFor(() => stdout.includes('watching 1 project'))
      await writeFile(path.join(workspaceRoot, 'packages', 'one', 'src', 'index.txt'), 'v1')

      // Wait for the re-run to surface the new content.
      await waitFor(() => stdout.includes('v1'))

      // Send SIGINT so the watch loop exits cleanly.
      process.emit('SIGINT')
      const code = await cmd
      expect(code).toBe(0)
      expect(stdout).toMatch(/^changed /m)
      expect(stdout).toContain('v0')
      expect(stdout).toContain('v1')
      // Silence the stderr-may-have-content lint by referencing it.
      void stderr
    },
    { timeout: 90_000 },
  )

  it(
    'editor swap files (~ suffix) are ignored — no re-run cycle',
    async () => {
      const path = await import('node:path')
      const { writeFile } = await import('node:fs/promises')

      let stdout = ''
      watchOut = () => stdout
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stdout += String(chunk) // stderr too: the poller swap says why a cycle is late
        return true
      })

      const cmd = startWatch(['watch', '--all', 'hello'])
      await waitFor(() => stdout.includes('watching 1 project'))

      // Drop a typical editor swap file. The watch loop should ignore it.
      await writeFile(
        path.join(workspaceRoot, 'packages', 'one', 'src', 'index.txt~'),
        'editor-swap',
      )
      // Also write to a node_modules path under the project — must be ignored.
      await import('node:fs/promises').then((m) =>
        m.mkdir(path.join(workspaceRoot, 'packages', 'one', 'node_modules', 'dep'), {
          recursive: true,
        }),
      )
      await writeFile(
        path.join(workspaceRoot, 'packages', 'one', 'node_modules', 'dep', 'index.js'),
        'noise',
      )

      // Give the watch loop a moment; no `re-running` line should appear
      // after the initial run. The lines themselves, not their count: a
      // count of 1 on macOS CI (run 37089948846) did not say which path
      // started the cycle (M-70).
      await new Promise((r) => setTimeout(r, 400))
      expect(stdout.split('\n').filter((l) => l.startsWith('changed '))).toEqual([])

      process.emit('SIGINT')
      await cmd
    },
    { timeout: 90_000 },
  )

  it(
    'rapid file edits collapse into a single re-run cycle (debounce)',
    async () => {
      const path = await import('node:path')
      const { writeFile } = await import('node:fs/promises')

      let stdout = ''
      watchOut = () => stdout
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stdout += String(chunk) // stderr too: the poller swap says why a cycle is late
        return true
      })

      const cmd = startWatch(['watch', '--all', 'hello', '--output-logs', 'full'])
      await waitFor(() => stdout.includes('watching 1 project'))

      // Burst-write 5 versions of the same file within < debounce
      // window. Debounce should collapse to ONE re-run that reads the
      // final value.
      const src = path.join(workspaceRoot, 'packages', 'one', 'src', 'index.txt')
      for (let i = 0; i < 5; i++) {
        await writeFile(src, `burst-${i}`)
      }
      await writeFor('burst-4', () => stdout.includes('burst-4'))

      // Wait an extra debounce window to ensure no further cycles.
      await new Promise((r) => setTimeout(r, 300))
      const reRunCount = (stdout.match(/^changed /gm) ?? []).length
      // Allow up to 2 cycles in case the burst spanned two debounce
      // windows; the contract is "doesn't fire 5 cycles for 5 edits".
      expect(reRunCount).toBeGreaterThanOrEqual(1)
      expect(reRunCount).toBeLessThanOrEqual(2)
      expect(stdout).toContain('burst-4')

      process.emit('SIGINT')
      await cmd
    },
    { timeout: 90_000 },
  )

  it(
    'a workspace-root lockfile a plugin claims triggers a cycle',
    async () => {
      const path = await import('node:path')
      const { writeFile } = await import('node:fs/promises')
      // Core keys no root file: the lockfile is an event as a plugin's claim.
      await writeLockClaim(workspaceRoot, ['bun.lock'])

      let stdout = ''
      watchOut = () => stdout
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stdout += String(chunk) // stderr too: the poller swap says why a cycle is late
        return true
      })

      const cmd = startWatch(['watch', '--all', 'hello'])
      await waitFor(() => stdout.includes('watching 1 project'))

      // Touch the claimed lockfile at the root. Should trigger a cycle
      // even though no project dir saw the change.
      await writeFile(path.join(workspaceRoot, 'bun.lock'), '# lockfile bump')
      await waitFor(() => /^changed /m.test(stdout))

      process.emit('SIGINT')
      await cmd
    },
    { timeout: 90_000 },
  )

  it(
    'SIGTERM also exits the watch loop cleanly',
    async () => {
      let stdout = ''
      watchOut = () => stdout
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stdout += String(chunk) // stderr too: the poller swap says why a cycle is late
        return true
      })

      const cmd = startWatch(['watch', '--all', 'hello'])
      await waitFor(() => stdout.includes('watching 1 project'))

      process.emit('SIGTERM')
      const code = await cmd
      expect(code).toBe(0)
    },
    { timeout: 90_000 },
  )

  it(
    'workspaceFiles inputs switch to a recursive root watcher — root-subdir change re-runs',
    async () => {
      const path = await import('node:path')
      const { mkdir, writeFile } = await import('node:fs/promises')

      // Shared root-subdir file the task reads via inputs.workspaceFiles.
      await mkdir(path.join(workspaceRoot, 'shared'), { recursive: true })
      await writeFile(path.join(workspaceRoot, 'shared', 'base.txt'), 'ws0')
      await writeFile(
        path.join(workspaceRoot, 'packages', 'one', 'vx.config.mjs'),
        `export default {
          tasks: {
            hello: {
              exec: { command: "cat ../../shared/base.txt" },
              inputs: { files: ['src/**'], workspaceFiles: ['shared/**'] },
              cache: {
                outputs: { files: [] },
              },
            },
          },
        }`,
      )

      let stdout = ''
      watchOut = () => stdout
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stdout += String(chunk) // stderr too: the poller swap says why a cycle is late
        return true
      })

      const cmd = startWatch(['watch', '--all', 'hello', '--output-logs', 'full'])
      await waitFor(() => stdout.includes('watching '))

      // A change in a ROOT SUBDIR (not any project dir, not a lockfile)
      // must trigger a cycle — the per-project watchers can't see it.
      await writeFile(path.join(workspaceRoot, 'shared', 'base.txt'), 'ws1')
      await waitFor(() => stdout.includes('ws1'))

      process.emit('SIGINT')
      const code = await cmd
      expect(code).toBe(0)
      expect(stdout).toContain('ws0')
      expect(stdout).toContain('ws1')
    },
    { timeout: 90_000 },
  )
})

async function writeFor(
  _label: string,
  predicate: () => boolean,
  timeoutMs = 45_000,
): Promise<void> {
  await waitFor(predicate, timeoutMs)
}

// Default well under the watch tests' 30s wrapper but far above the old
// 10s — these e2e watch tests drive a debounced fs.watch + a full re-run
// and flake under concurrent suite load when the inner budget is tight.
/** The captured watch stdout, for waitFor's error: a red run names where it stalled. */
let watchOut: () => string = () => ''

async function waitFor(predicate: () => boolean, timeoutMs = 45_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      // The watch's own stdout so far: a timeout under load (three shard
      // runs on 2026-09-11) named nothing until this did.
      const seen = watchOut().slice(-2000)
      throw new Error(`waitFor timed out after ${timeoutMs}ms; watch stdout so far:\n${seen}`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('parseRunArgs', () => {
  it('parses task name with all flags defaulted', () => {
    const r = parseRunArgs(['build'])
    expect(r.tasks).toEqual(['build'])
    expect(r.filters).toEqual([])
    expect(r.all).toBe(false)
    expect(r.cache).toEqual({
      localRead: true,
      localWrite: true,
      remoteRead: true,
      remoteWrite: true,
    })
    expect(r.excludeDependencies).toEqual([])
    expect(r.verbosity).toBe(0)
    expect(r.dry).toBeUndefined()
    expect(r.profile).toBeUndefined()
    expect(r.forwardArgs).toEqual([])
  })

  it('parses pkg#task syntax untouched (split happens later)', () => {
    const r = parseRunArgs(['@scope/web#build'])
    expect(r.tasks).toEqual(['@scope/web#build'])
  })

  it('parses repeated --filter', () => {
    const r = parseRunArgs(['build', '--filter', 'foo', '--filter', '@scope/*'])
    expect(r.tasks).toEqual(['build'])
    expect(r.filters).toEqual(['foo', '@scope/*'])
  })

  it('parses --concurrency (no short alias)', () => {
    expect(parseRunArgs(['build', '--concurrency', '2']).settings['run.concurrency']).toBe(2)
    // The percent form resolves against this machine, never below one
    // worker, and over 100% is allowed for I/O-bound work.
    const cores = navigator.hardwareConcurrency
    expect(parseRunArgs(['build', '--concurrency', '50%']).settings['run.concurrency']).toBe(
      Math.max(1, Math.round(cores * 0.5)),
    )
    expect(parseRunArgs(['build', '--concurrency=200%']).settings['run.concurrency']).toBe(
      cores * 2,
    )
    expect(
      parseRunArgs(['build', '--concurrency', '1%']).settings['run.concurrency'],
    ).toBeGreaterThanOrEqual(1)
    expect(parseRunArgs(['build', '--concurrency', '%']).error).toBeDefined()
    expect(parseRunArgs(['build', '-c', '4']).error).toMatch(/unknown flag: -c\b/)
    // A near miss names the documented flag; a far one gets no guess.
    expect(parseRunArgs(['build', '--concurency', '4']).error).toBe(
      'unknown flag: --concurency (did you mean --concurrency?)',
    )
    expect(parseRunArgs(['build', '--zzz']).error).toBe('unknown flag: --zzz')
    // The candidate list itself: run's documented flags come from the help
    // text's `(for run)` sections, and prune's flag is not among them.
    const flags = documentedFlags('run')
    expect(flags).toContain('--concurrency')
    expect(flags).toContain('--affected')
    expect(flags).not.toContain('--older-than')
    expect(documentedFlags('no-such-verb')).toEqual([])
    // Only the flag an option line OPENS with is the verb's: a line of prose
    // naming another verb's flag put `--check` in run's list, and
    // `vx run --chek` was told "did you mean --check?".
    const fixture = [
      'Execution (for run):',
      '  --dry             Print the plan;',
      '                    pair with vx lock --check in CI.',
      'Cache (for prune):',
      '  --older-than <d>  Prune entries older than d.',
    ].join('\n')
    expect(documentedFlags('run', fixture)).toEqual(['--dry'])
  })

  it('vx <verb> --help is the reference cut to that verb, from the same text', () => {
    const run = verbHelpText('run')
    expect(run).toContain('Usage:\n  vx run [OPTIONS]')
    expect(run).toContain('Execution (for run):')
    expect(run).toContain('Planning (for run — skips execution):')
    expect(run).not.toContain('Cache management:')
    expect(run).not.toContain('vx last [RUNID]')
    expect(run).toContain('Full reference: vx help')
    const cache = verbHelpText('cache')
    expect(cache).toContain('vx cache clean --older-than 30d')
    expect(cache).toContain('--dry')
    expect(cache).not.toContain('Selection (for run):')
    const last = verbHelpText('last')
    expect(last).toContain('--list[=N]')
    expect(last).not.toContain('--older-than')
    // Every documented run flag is still in the run cut — the cut cannot
    // hide a flag the full text documents.
    for (const flag of documentedFlags('run')) expect(run).toContain(flag)
    // A verb the reference does not know gets the whole reference.
    expect(verbHelpText('no-such-verb')).toBe(helpText())
    // Another verb's flag is never suggested to `run`.
    expect(parseRunArgs(['build', '--older-tha', '1d']).error).toBe('unknown flag: --older-tha')
  })

  it('a verb cut takes only lines that START with its own `vx <verb>` form', () => {
    const flagsIn = (s: string): string[] =>
      [...new Set(s.match(/--[a-zA-Z][a-zA-Z-]*/g) ?? [])].sort()
    // A run flag's line that mentions "pair with `vx lock --check`" MID-LINE
    // (the removed `--frozen`'s did): without the start anchor that one
    // cross-reference drags the whole `Execution (for run)` block — 26
    // lines of run's flags — into `vx lock --help`. The exact set is the assertion; a `not.toContain` would pass
    // on any single flag leaking.
    expect(flagsIn(verbHelpText('lock'))).toEqual(['--check', '--format'])
    expect(flagsIn(verbHelpText('init'))).toEqual([
      '--dry',
      '--force',
      '--format',
      '--keep',
      '--mjs',
      '--native',
      '--plugin',
    ])
    expect(flagsIn(verbHelpText('cache'))).toEqual([
      '--cache-dir',
      '--dry',
      '--format',
      '--global',
      '--max-size',
      '--older-than',
    ])
  })

  it("`run`'s documented flags are exactly the flags of its `(for run)` sections", () => {
    // An exact set, not a spot check: `--dry` is in here only because
    // `Planning (for run — skips execution):` carries an em dash and so does
    // NOT match the section-header pattern, leaving the scanner inside the
    // previous `(for run)` section. Widen that pattern and it silently leaves
    // the list `vx run --dryy` suggests from.
    expect([...documentedFlags('run')].sort()).toEqual([
      '--affected',
      '--all',
      '--branch',
      '--cache-concurrency-download',
      '--cache-concurrency-restore',
      '--cache-concurrency-upload',
      '--cache-dir',
      '--cache-download',
      '--cache-policy',
      '--concurrency',
      '--continue',
      '--dry',
      '--exclude-dependencies',
      '--filter',
      '--force',
      '--no-cache',
      '--output-logs',
      '--profile',
      '--retries',
      '--schedule',
      '--timeout',
      '--verbosity',
    ])
  })

  it('the Plugin commands section appears only when there are plugin commands', () => {
    expect(helpText().includes('Plugin commands:')).toBe(false)
    // CONTROL: the section is emitted when the list is not empty, so the
    // claim above is about the gate and not about a heading that never ships.
    expect(helpText(['  vx deploy   ship it']).includes('Plugin commands:')).toBe(true)
  })

  it('a verb carrying regex syntax is an unknown verb, not a pattern', () => {
    // The verb is interpolated into a RegExp. Unescaped, `r.n` matched the
    // `vx run` Usage line and answered with a help cut for a verb that does
    // not exist, and `.*` matched most of the reference — while the doc
    // comment promised the whole thing for a verb it does not know.
    for (const verb of ['.*', 'r.n', '(run)', 'ru+n', '[rn]un', 'run|watch', 'run?']) {
      expect([verb, verbHelpText(verb)]).toEqual([verb, helpText()])
    }
  })

  it('parses --cache-dir (space + = forms) without colliding with --cache-policy', () => {
    expect(parseRunArgs(['build', '--cache-dir', '/tmp/x']).cacheDir).toBe('/tmp/x')
    expect(parseRunArgs(['build', '--cache-dir=./out/cache']).cacheDir).toBe('./out/cache')
    // --cache-policy still parses its own policy spec, undisturbed.
    expect(parseRunArgs(['build', '--cache-policy=local:r']).cacheDir).toBeUndefined()
    expect(parseRunArgs(['build']).cacheDir).toBeUndefined()
    expect(parseRunArgs(['build', '--cache-dir']).error).toBe('--cache-dir requires a path')
  })

  it('--cache-dir rejects a flag-shaped value in the space form', () => {
    // `--cache-dir $EMPTY --force` with an unquoted empty var: the arg
    // vanishes and `--force` would become the cache directory.
    expect(parseRunArgs(['build', '--cache-dir', '--force']).error).toMatch(
      /--cache-dir requires a path \(got flag --force; a path that starts with - needs --cache-dir=--force\)/,
    )
    // The `=` form still takes a literal leading dash if someone means it.
    expect(parseRunArgs(['build', '--cache-dir=-weird']).cacheDir).toBe('-weird')
  })

  it('--exclude-dependencies= (empty value) is rejected, not read as "exclude nothing"', () => {
    const r = parseRunArgs(['build', '--exclude-dependencies='])
    expect(r.error).toMatch(/--exclude-dependencies= needs a value/)
    // Both unambiguous forms keep working.
    expect(parseRunArgs(['build', '--exclude-dependencies']).excludeDependencies).toBe('all')
    expect(parseRunArgs(['build', '--exclude-dependencies=a,b']).excludeDependencies).toEqual([
      'a',
      'b',
    ])
  })

  it('parses --all (replaces -r / --recursive)', () => {
    expect(parseRunArgs(['build', '--all']).all).toBe(true)
  })

  it('--no-cache disables every cache axis', () => {
    expect(parseRunArgs(['build', '--no-cache']).cache).toEqual({
      localRead: false,
      localWrite: false,
      remoteRead: false,
      remoteWrite: false,
    })
  })

  it('--force skips reads but keeps writes (re-execute + refresh)', () => {
    expect(parseRunArgs(['build', '--force']).cache).toEqual({
      localRead: false,
      localWrite: true,
      remoteRead: false,
      remoteWrite: true,
    })
  })

  it('--cache-policy=<spec> sets named layers exactly and leaves others (= and space forms)', () => {
    // remote read-only: local stays rw (default), remote drops write.
    expect(parseRunArgs(['build', '--cache-policy=local:rw,remote:r']).cache).toEqual({
      localRead: true,
      localWrite: true,
      remoteRead: true,
      remoteWrite: false,
    })
    // local read-only, remote untouched (still rw).
    expect(parseRunArgs(['build', '--cache-policy=local:r']).cache).toEqual({
      localRead: true,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
    // remote: with empty flags turns remote fully off; local untouched.
    expect(parseRunArgs(['build', '--cache-policy=remote:']).cache).toEqual({
      localRead: true,
      localWrite: true,
      remoteRead: false,
      remoteWrite: false,
    })
    // Space form parses identically to the = form.
    expect(parseRunArgs(['build', '--cache-policy', 'local:r']).cache).toEqual({
      localRead: true,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
  })

  it('--cache-policy rejects unknown layers and flags', () => {
    expect(parseRunArgs(['build', '--cache-policy=disk:r']).error).toMatch(
      /^--cache-policy: invalid layer/,
    )
    expect(parseRunArgs(['build', '--cache-policy=local:x']).error).toMatch(
      /^--cache-policy: invalid flag/,
    )
    expect(parseRunArgs(['build', '--cache-policy=local']).error).toMatch(
      /^--cache-policy: invalid segment/,
    )
  })

  it('--no-cache beats --force regardless of order', () => {
    const allOff = {
      localRead: false,
      localWrite: false,
      remoteRead: false,
      remoteWrite: false,
    }
    expect(parseRunArgs(['build', '--no-cache', '--force']).cache).toEqual(allOff)
    expect(parseRunArgs(['build', '--force', '--no-cache']).cache).toEqual(allOff)
  })

  it('--force layers on top of a --cache-policy base (reads off, writes from spec)', () => {
    // --cache-policy=remote: turns remote off; --force then drops reads. Result:
    // local write-only re-exec with remote fully off.
    expect(parseRunArgs(['build', '--cache-policy=remote:', '--force']).cache).toEqual({
      localRead: false,
      localWrite: true,
      remoteRead: false,
      remoteWrite: false,
    })
  })

  it('--output-logs validates its mode and threads through', () => {
    const ok = parseRunArgs(['build', '--output-logs', 'errors-only'])
    expect(ok.error).toBeUndefined()
    expect(ok.settings['run.outputLogs']).toBe('errors-only')
    const bad = parseRunArgs(['build', '--output-logs', 'loud'])
    expect(bad.error).toContain('--output-logs must be')
  })

  it('parses --exclude-dependencies as "all" with no value', () => {
    expect(parseRunArgs(['build', '--exclude-dependencies']).excludeDependencies).toBe('all')
  })

  it('the camelCase spelling the flag shipped with names the kebab-case one', () => {
    // Every other flag is kebab-case; the old spelling is two edits past
    // the suggester's reach, so the error says it outright.
    expect(parseRunArgs(['build', '--excludeDependencies']).error).toMatch(
      /unknown flag: --excludeDependencies \(the flag is --exclude-dependencies\)/,
    )
    expect(parseRunArgs(['build', '--excludeDependencies=lint']).error).toMatch(
      /the flag is --exclude-dependencies/,
    )
  })

  it('parses --exclude-dependencies=name1,name2 as a name list', () => {
    expect(parseRunArgs(['build', '--exclude-dependencies=lint,test']).excludeDependencies).toEqual(
      ['lint', 'test'],
    )
  })

  it('parses --affected (no value) and --affected=<ref>', () => {
    expect(parseRunArgs(['build', '--affected']).affected).toBe('')
    expect(parseRunArgs(['build', '--affected=origin/main']).affected).toBe('origin/main')
  })

  it('parses --verbosity <n> (replaces -v / --verbose)', () => {
    expect(parseRunArgs(['build', '--verbosity', '1']).verbosity).toBe(1)
    expect(parseRunArgs(['build', '--verbosity', '2']).verbosity).toBe(2)
    expect(parseRunArgs(['build', '-v']).error).toMatch(/unknown flag: -v/)
    expect(parseRunArgs(['build', '--verbose']).error).toMatch(/unknown flag: --verbose/)
  })

  it('--verbosity rejects non-integer and negative values', () => {
    expect(parseRunArgs(['build', '--verbosity', 'high']).error).toMatch(/--verbosity must be/)
    expect(parseRunArgs(['build', '--verbosity', '-1']).error).toMatch(/--verbosity must be/)
  })

  it('parses --dry and --dry=json / --dry=text', () => {
    expect(parseRunArgs(['build', '--dry']).dry).toBe('text')
    expect(parseRunArgs(['build', '--dry=text']).dry).toBe('text')
    expect(parseRunArgs(['build', '--dry=json']).dry).toBe('json')
  })

  it('rejects invalid --dry=<format>', () => {
    expect(parseRunArgs(['build', '--dry=yaml']).error).toMatch(
      /--dry must be text or json \(got yaml\)/,
    )
  })

  it('an empty `=` value is a missing value, not a bad one', () => {
    expect(parseRunArgs(['build', '--dry=']).error).toBe(
      '--dry= requires a format (text or json); bare --dry prints text',
    )
    expect(parseRunArgs(['build', '--verbosity=']).error).toBe(
      '--verbosity requires a value (a non-negative integer)',
    )
  })

  it('parses --profile (default profile.json) and --profile=<path>', () => {
    expect(parseRunArgs(['build', '--profile']).profile).toBe('profile.json')
    expect(parseRunArgs(['build', '--profile=trace.json']).profile).toBe('trace.json')
  })

  it('rejects --profile with --dry (planning skips execution)', () => {
    expect(parseRunArgs(['build', '--dry', '--profile']).error).toMatch(/needs a real run/)
  })

  it('parses --retries <n> / --retries=<n> and validates it', () => {
    expect(parseRunArgs(['build', '--retries', '3']).settings['run.retries']).toBe(3)
    expect(parseRunArgs(['build', '--retries=0']).settings['run.retries']).toBe(0)
    expect(parseRunArgs(['build']).settings['run.retries']).toBeUndefined()
    // Negative / non-integer → non-negative-integer error.
    expect(parseRunArgs(['build', '--retries', '-1']).error).toMatch(/non-negative/)
    expect(parseRunArgs(['build', '--retries=1.5']).error).toMatch(/non-negative/)
    // Missing value.
    expect(parseRunArgs(['build', '--retries']).error).toBe(
      '--retries requires a value (a non-negative integer)',
    )
  })

  it('parses --timeout <ms> / --timeout=<ms> and validates it', () => {
    expect(parseRunArgs(['build', '--timeout', '5000ms']).settings['run.timeout']).toBe(5000)
    expect(parseRunArgs(['build', '--timeout=1000ms']).settings['run.timeout']).toBe(1000)
    expect(parseRunArgs(['build']).settings['run.timeout']).toBeUndefined()
    // 0 / negative → refused.
    expect(parseRunArgs(['build', '--timeout', '0ms']).error).toMatch(/must be a duration/)
    expect(parseRunArgs(['build', '--timeout=-5']).error).toMatch(/must be a duration/)
    // Missing value.
    expect(parseRunArgs(['build', '--timeout']).error).toBe(
      "--timeout requires a value (a duration like '500ms', '30s' or '5m', at most 24 days)",
    )
  })

  it('captures trailing args after `--` as forwardArgs', () => {
    const r = parseRunArgs(['build', '--', '--watch', '--bail'])
    expect(r.tasks).toEqual(['build'])
    expect(r.forwardArgs).toEqual(['--watch', '--bail'])
  })

  it('flags before `--` are parsed; flags after are forwarded literally', () => {
    const r = parseRunArgs(['--all', 'build', '--', '--verbosity', '--no-cache'])
    expect(r.all).toBe(true)
    expect(r.tasks).toEqual(['build'])
    expect(r.verbosity).toBe(0)
    expect(r.cache).toEqual({
      localRead: true,
      localWrite: true,
      remoteRead: true,
      remoteWrite: true,
    })
    expect(r.forwardArgs).toEqual(['--verbosity', '--no-cache'])
  })

  it('rejects unknown flag', () => {
    expect(parseRunArgs(['--bogus']).error).toMatch(/unknown flag/)
  })

  it('-f is not recognized (legacy)', () => {
    expect(parseRunArgs(['build', '-f']).error).toMatch(/unknown flag: -f/)
  })

  it('rejects missing flag value', () => {
    expect(parseRunArgs(['build', '--filter']).error).toBe(
      '--filter requires a value (a project name, glob or path, e.g. --filter app)',
    )
    // X-13: the next flag is no pattern (`--filter --dry` matched "--dry").
    expect(parseRunArgs(['build', '--filter', '--dry']).error).toBe(
      '--filter requires a value (a project name, glob or path, e.g. --filter app)',
    )
    // Each value-taking flag says what the value is, not only that it is missing.
    expect(
      ['--concurrency', '--cache-policy', '--verbosity'].map(
        (f) => parseRunArgs(['build', f]).error,
      ),
    ).toEqual([
      "--concurrency requires a value (a positive integer, or a share of the cores like '50%')",
      '--cache-policy requires a value (a spec like local:r, local:rw, remote:, or local:,remote:rw)',
      '--verbosity requires a value (a non-negative integer)',
    ])
  })

  // vx owns its flags (2026-10-22): another runner's spelling is an
  // unknown flag like any other, never rewritten or answered with vx's.
  // `vx run build --format json` was told "did you mean --force?": a run
  // with cache reads off, never the JSON the agent asked for.
  it('--format and --json on a run name where its JSON is, never --force', () => {
    for (const flag of ['--format', '--json'])
      expect(parseRunArgs(['build', flag, 'json']).error).toBe(
        `unknown flag: ${flag} (the run as JSON is \`vx last --format json\` after it; the plan is --dry=json)`,
      )
  })

  it("another runner's flag is an unknown flag", () => {
    for (const flag of [
      '-F',
      '-t',
      '-p',
      '-r',
      '--dry-run',
      '--skip-nx-cache',
      '--only',
      '--graph',
    ])
      expect(parseRunArgs(['build', flag, 'x']).error).toMatch(
        new RegExp(`unknown flag: ${flag}\\b`),
      )
  })

  it('rejects bad concurrency', () => {
    expect(parseRunArgs(['build', '--concurrency', 'abc']).error).toMatch(/--concurrency must be/)
  })

  it('multiple positionals are collected as tasks (Turbo-style `vx run a b`)', () => {
    expect(parseRunArgs(['a', 'b']).tasks).toEqual(['a', 'b'])
  })

  it('mixes bare and pkg#task positionals into tasks', () => {
    expect(parseRunArgs(['build', 'pkg#deploy', 'lint']).tasks).toEqual([
      'build',
      'pkg#deploy',
      'lint',
    ])
  })
})

describe('formatBytes', () => {
  it('formats values under 1 KB as bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('switches to KB at 1024', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(5_120)).toBe('5.0 KB')
  })

  it('drops the decimal once values are >= 10 in a unit', () => {
    expect(formatBytes(10_240)).toBe('10 KB')
  })

  it('switches to MB and GB', () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })

  it('switches to TB, and past 1024 TB to PB', () => {
    expect(formatBytes(4 * 1024 ** 4)).toBe('4.0 TB')
    expect(formatBytes(2048 * 1024 ** 4)).toBe('2 PB')
  })

  // The tier is the printed value's: 1 MiB less a byte printed `1024 KB`.
  it('a value that rounds up to the next tier prints in it', () => {
    expect(formatBytes(1024 ** 2 - 1)).toBe('1.0 MB')
    expect(formatBytes(10 * 1024 - 1)).toBe('10 KB')
    expect(formatBytes(1024 ** 5 - 1)).toBe('1 PB')
  })
})

describe('parseDuration', () => {
  it('parses seconds, minutes, hours, days', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(5 * 60_000)
    expect(parseDuration('2h')).toBe(2 * 3_600_000)
    expect(parseDuration('30d')).toBe(30 * 86_400_000)
  })

  it('rejects unknown units and missing numbers', () => {
    expect(parseDuration('30')).toBeNull()
    expect(parseDuration('30y')).toBeNull()
    expect(parseDuration('d')).toBeNull()
    expect(parseDuration('thirty')).toBeNull()
  })
})

describe('parseSize', () => {
  it('parses bytes, K, M, G, T (powers of 1024)', () => {
    expect(parseSize('512')).toBe(512)
    expect(parseSize('1K')).toBe(1024)
    expect(parseSize('5M')).toBe(5 * 1024 * 1024)
    expect(parseSize('1G')).toBe(1024 ** 3)
    expect(parseSize('2T')).toBe(2 * 1024 ** 4)
  })

  it('accepts optional B suffix and lowercase', () => {
    expect(parseSize('500MB')).toBe(500 * 1024 * 1024)
    expect(parseSize('1g')).toBe(1024 ** 3)
  })

  it('rejects malformed values', () => {
    expect(parseSize('1.5G')).toBeNull()
    expect(parseSize('lots')).toBeNull()
    expect(parseSize('')).toBeNull()
  })
})

describe('parsePruneArgs', () => {
  it('takes no bound as a clear', () => {
    expect(parsePruneArgs([]).error).toBeUndefined()
  })

  it('parses --older-than as a wall-clock cutoff', () => {
    const before = Date.now()
    const r = parsePruneArgs(['--older-than', '7d'])
    expect(r.error).toBeUndefined()
    expect(r.olderThanMs).toBeDefined()
    expect(r.olderThanMs!).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000 + 5)
    expect(r.olderThanMs!).toBeGreaterThanOrEqual(before - 7 * 86_400_000 - 5)
  })

  it('refuses a bare number for --max-size: it would read as bytes and evict the cache', () => {
    // `parseSize('10')` is 10 bytes — right for a computed size,
    // catastrophic as a cache cap. The explicit `10B` still passes.
    const r = parsePruneArgs(['--max-size', '10'])
    expect(r.error).toMatch(/10 bytes/)
    expect(r.error).toMatch(/10M, 10G/)
    expect(parsePruneArgs(['--max-size', '10B']).maxBytes).toBe(10)
    expect(parsePruneArgs(['--max-size', '10M']).maxBytes).toBe(10 * 1024 * 1024)
  })

  it('parses --max-size', () => {
    expect(parsePruneArgs(['--max-size', '1G']).maxBytes).toBe(1024 ** 3)
  })

  // Past these refusals an unparsed value is `null`: `Date.now() - null` is
  // a cutoff of NOW (every entry older than this instant) and a `null` cap
  // reaches the cache as a size limit. Neither refusal had a row (E-9's
  // sweep deleted each with the suite green).
  it('refuses a value it cannot parse instead of pruning by it', () => {
    expect(parsePruneArgs(['--older-than', 'abc'])).toEqual({
      error:
        '--older-than must be a duration like 30d, 24h or 60m (got abc) (see `vx cache --help`)',
    })
    expect(parsePruneArgs(['--older-than', '1.5d'])).toEqual({
      error:
        '--older-than must be a duration like 30d, 24h or 60m (got 1.5d) (see `vx cache --help`)',
    })
    expect(parsePruneArgs(['--max-size', 'abc'])).toEqual({
      error: '--max-size must be a size like 500M or 1G (got abc) (see `vx cache --help`)',
    })
    expect(parsePruneArgs(['--max-size', '1.5G'])).toEqual({
      error: '--max-size must be a size like 500M or 1G (got 1.5G) (see `vx cache --help`)',
    })
  })

  it('rejects missing flag values', () => {
    expect(parsePruneArgs(['--older-than']).error).toMatch(/requires a value/)
    expect(parsePruneArgs(['--max-size']).error).toMatch(/requires a value/)
  })

  it('rejects unknown flags', () => {
    expect(parsePruneArgs(['--bogus']).error).toMatch(/unknown flag/)
  })

  it('accepts both flags together', () => {
    const r = parsePruneArgs(['--older-than', '24h', '--max-size', '500M'])
    expect(r.olderThanMs).toBeDefined()
    expect(r.maxBytes).toBe(500 * 1024 * 1024)
  })
})

describe('vx cache clean command', () => {
  let workspaceRoot: string
  const origCwd = process.cwd()

  beforeEach(async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-prune-'))
    await writeFile(
      path.join(workspaceRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
    )
    await Bun.write(path.join(workspaceRoot, '.vx/workspace.mjs'), localWorkspaceSource())
    process.chdir(workspaceRoot)
  })

  afterEach(async () => {
    process.chdir(origCwd)
    const { rm } = await import('node:fs/promises')
    await rm(workspaceRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('errors with no subcommand at all, naming the one that exists', async () => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    expect(await run(['cache'])).toBe(1)
    expect(stderr).toBe(
      noticed(
        'vx cache: missing subcommand. Try `vx cache clean --older-than 30d` to trim the cache, or `vx cache clean` to clear it (see `vx cache --help`)\n',
      ),
    )
  })

  it('reports 0 entries pruned from an empty cache', async () => {
    let stdout = ''
    watchOut = () => stdout
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await run(['cache', 'clean', '--older-than', '1s'])
    expect(code).toBe(0)
    expect(stdout).toContain('nothing to free')
  })

  it('rejects unknown subcommand', async () => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    const code = await run(['cache', 'nope'])
    expect(code).toBe(1)
    expect(stderr).toContain('unknown subcommand')
  })

  // The words a user arrives with: `stats` is what the other runners call
  // it, and vx's answer is a different VERB, not a missing one. Walked the
  // first-run path to find this (2026-09-20) — the help screen lists only
  // `clean`, so a reader sent there learns what vx does not have.
  it.each([
    ['stats', '`vx info` reports the cache directory'],
    ['clear', '`vx cache clean` with no bound clears the whole cache'],
    ['dir', '`vx info` prints the cache directory'],
  ])('points %s at the verb that answers it', async (sub, hint) => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    expect(await run(['cache', sub])).toBe(1)
    expect(stderr).toContain(hint)
  })

  it('still offers the nearest subcommand for a typo of one that exists', async () => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    expect(await run(['cache', 'clen'])).toBe(1)
    expect(stderr).toContain('fix  clean')
  })
})

describe('--continue parsing', () => {
  it('bare --continue means always; explicit values parse; junk rejects', () => {
    expect(parseRunArgs(['build', '--continue']).continueMode).toBe('always')
    expect(parseRunArgs(['build', '--continue=never']).continueMode).toBe('never')
    expect(parseRunArgs(['build', '--continue=deps-ok']).continueMode).toBe('deps-ok')
    expect(parseRunArgs(['build', '--continue=sometimes']).error).toContain('--continue must be')
    expect(parseRunArgs(['build']).continueMode).toBeUndefined()
  })

  it('a mode written with a space is refused with the = form, not read as a task', () => {
    // `--continue never` used to run with `never` as a second task name and
    // fail with "No projects declare task(s): never".
    expect(parseRunArgs(['build', '--continue', 'never']).error).toBe(
      "--continue takes its mode with '=': --continue=never",
    )
    // A task name after a bare --continue is still a task name.
    const ok = parseRunArgs(['build', '--continue', 'test'])
    expect(ok.error).toBeUndefined()
    expect(ok.continueMode).toBe('always')
    expect(ok.tasks).toEqual(['build', 'test'])
  })

  it('EVERY mode is refused in the space form, not just the first one', () => {
    // The row above spells the refusal with `never`, so the lookahead's
    // other two members ride on it: drop either from the list and
    // `--continue deps-ok` goes back to being parsed as a bare --continue
    // plus a task named `deps-ok`, which is the exact "No projects declare
    // task(s)" dead end the refusal exists to replace. One argv per member.
    for (const mode of ['never', 'deps-ok', 'always'] as const) {
      expect(parseRunArgs(['build', '--continue', mode]).error).toBe(
        `--continue takes its mode with '=': --continue=${mode}`,
      )
    }
  })
})

describe('--cache-download accepts exactly its three modes', () => {
  it('names each one, in both spellings', () => {
    // `none` had no row: the enum guard lists it, and dropping that member
    // turns `--cache-download=none` — the form that keeps every intermediate
    // output remote — into an argument error. The modes decide which
    // outputs come home, so each is worth its own assertion rather than a
    // check that SOME value parses.
    for (const mode of ['all', 'toplevel', 'none'] as const) {
      expect(parseRunArgs(['build', `--cache-download=${mode}`]).settings['cache.download']).toBe(
        mode,
      )
      expect(parseRunArgs(['build', '--cache-download', mode]).settings['cache.download']).toBe(
        mode,
      )
    }
    // The control: the guard still refuses what is not a mode.
    expect(parseRunArgs(['build', '--cache-download=some']).error).toContain(
      '--cache-download must be',
    )
  })
})

describe('unknown-flag hints reach three edits', () => {
  it('--retr hints --retries, which is three edits away', () => {
    expect(parseRunArgs(['build', '--retr', '2']).error).toContain('(did you mean --retries?)')
    // The third edit is only for flags sharing a stem: a plain three-edit
    // budget hinted `--all` for `--zzz`.
    expect(parseRunArgs(['build', '--zzz']).error).not.toContain('did you mean')
  })

  it('a flag sharing the stem but past three edits gets no hint', () => {
    // The distance was capped at 3, so "three or more" read as three: the
    // same-stem budget offered `--concurrency` for `--continue-on-error`
    // (nine edits) and `--cache-policy` for `--cache-directory`.
    // `--continue-on-error` is `--continue` a word too long, which is the hint.
    expect(parseRunArgs(['build', '--continue-on-error']).error).toBe(
      'unknown flag: --continue-on-error (did you mean --continue?)',
    )
    expect(parseRunArgs(['build', '--cache-directory', 'd']).error).toBe(
      'unknown flag: --cache-directory',
    )
    // CONTROL: within three edits the stem still hints.
    expect(parseRunArgs(['build', '--timeouts']).error).toBe(
      'unknown flag: --timeouts (did you mean --timeout?)',
    )
  })
})

describe('nearest', () => {
  it('holds its budget exactly: a distance past it is never inside it', () => {
    expect(editDistance('abcdefgh', 'abcdzzzzzz', 4)).toBe(4)
    expect(editDistance('abcd', 'abcxyz', 4)).toBe(3)
    expect(nearest('continue-on-error', ['concurrency'], 3)).toBeUndefined()
    expect(nearest('retries', ['retry'], 3)).toBe('retry')
    // The default budget of two: unchanged.
    expect(nearest('buidl', ['build'])).toBe('build')
    expect(nearest('bxyzl', ['build'])).toBeUndefined()
  })

  // `--filter=x9` offered `fix  //`: two edits rewrite any two letters.
  it('a candidate the edits rewrite whole is no near miss', () => {
    expect(nearest('x9', ['//', 'packages/p1'])).toBeUndefined()
    expect(nearest('b', ['a'])).toBeUndefined()
    // CONTROL: a real typo of a short name still hints.
    expect(nearest('p1', ['p2'])).toBe('p2')
    expect(nearest('b', ['ab'])).toBe('ab')
  })
})

// turborepo#9277, #11428: run from a directory inside a project nested in
// another, the runner picked either project from one run to the next.
describe('the project a bare task runs in, from a nested subdirectory (e2e)', () => {
  it('is the deepest project containing the cwd, the same on every run', async () => {
    const root = await makeWorkspace({ prefix: 'vx-cwd-nested-' })
    try {
      await writeFile(
        path.join(root, 'pnpm-workspace.yaml'),
        'packages:\n  - "apps/*"\n  - "apps/*/api"\n',
      )
      for (const [name, rel] of [
        ['app1', 'apps/app1'],
        ['app1-api', 'apps/app1/api'],
      ] as const) {
        const dir = path.join(root, rel)
        await mkdir(path.join(dir, 'src'), { recursive: true })
        await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
        await Bun.write(path.join(dir, '.vx/workspace.mjs'), localWorkspaceSource())
        await writeFile(
          path.join(dir, 'vx.config.mjs'),
          `export default { tasks: { build: { exec: { command: 'true' } } } }`,
        )
      }
      const cwd = path.join(root, 'apps', 'app1', 'api', 'src')
      const answers = new Set<string>()
      for (let i = 0; i < 3; i++) answers.add((await planned(cwd, ['build'])).join())
      expect([...answers]).toEqual(['app1-api#build'])
      expect(await planned(path.join(root, 'apps', 'app1'), ['build'])).toEqual(['app1#build'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
