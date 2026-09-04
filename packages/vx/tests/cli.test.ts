import { documentedFlags } from '../src/cli/help.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import {
  formatBytes,
  parseDuration,
  parsePruneArgs,
  parseRunArgs,
  parseSize,
  run,
} from '../src/cli/index.js'
import { formatRunReportMarkdown } from '../src/orchestrator/index.js'

describe('cli run()', () => {
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

  it('prints help with no args', async () => {
    expect(await run([])).toBe(0)
    expect(stdout).toContain('Usage:')
  })

  it('prints version', async () => {
    expect(await run(['--version'])).toBe(0)
    expect(stdout).toMatch(/^vx \d/)
  })

  // Every verb answered `unknown flag: --help` and exited 1 until
  // 2026-09-04 — the one thing every user types first. The list is the
  // dispatcher's own verbs; a new verb that forgets this fails here.
  it.each([
    'run',
    'watch',
    'cache',
    'lock',
    'migrate',
    'init',
    'upgrade',
    'show',
    'info',
    'why',
    'last',
    'prune',
  ])('`vx %s --help` prints help and exits 0', async (verb) => {
    expect(await run([verb, '--help'])).toBe(0)
    expect(stdout).toContain('Usage:')
    expect(stderr).toBe('')
  })

  // Every argument error points at the verb's own help, which is only
  // useful because `vx <verb> --help` prints something (same day). A verb
  // that grows a new parser and forgets the pointer fails here.
  it.each([
    ['show', ['show', '--json']],
    ['run', ['run', '--concurency', '2', 'build']],
    ['last', ['last', '--lst']],
    ['migrate', ['migrate', '--dyr']],
    ['why', ['why', '--fmt', 'x']],
    ['prune', ['prune', '--dockerr', 'app']],
    ['lock', ['lock', '--chk']],
    ['info', ['info', 'extra']],
    ['cache', ['cache', 'bogus']],
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
    // printing help. A real task name would EXECUTE, which a unit test must
    // not do in this repo.
    expect(await run(['run', 'no-such-task-xyz', '--', '--help'])).not.toBe(0)
    expect(stdout).not.toContain('Usage:')
    expect(`${stdout}${stderr}`).toContain('no-such-task-xyz')
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
    expect(await run([cmd])).toBe(1)
    expect(stderr).toContain('plugin')
    expect(stderr).not.toContain('unknown command')
    // Core must not name any specific service package.
    expect(stderr).not.toContain('vx-cloud')
    expect(stderr).not.toContain('@vzn/vx-cloud')
  })

  it('rejects run with no task', async () => {
    expect(await run(['run'])).toBe(1)
    expect(stderr).toContain('missing task name')
  })

  it('rejects run with bad flag value (parser error surfaced)', async () => {
    expect(await run(['run', 'build', '--concurrency', 'oops'])).toBe(1)
    expect(stderr).toContain('invalid concurrency')
  })

  it('--version is the only version form (no -V short alias)', async () => {
    expect(await run(['--version'])).toBe(0)
    expect(stdout).toMatch(/^vx \d/)
  })

  it('-V is rejected as unknown', async () => {
    expect(await run(['-V'])).toBe(1)
    expect(stderr).toContain('unknown command')
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
            cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
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

  it('--graph prints Graphviz DOT, skips execution', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', '--all', 'hello', '--graph'])
    expect(code).toBe(0)
    expect(stdout).toContain('digraph TaskGraph')
    expect(stdout).toContain('"one#hello"')
    expect(stdout).not.toContain('hello-cli')
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
    expect(stderr).toContain('not inside a project')
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
    expect(stderr).toContain('no projects matched filter(s): oen. Did you mean one?')
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

  it('--report=markdown prints a markdown table to stdout', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', '--all', 'hello', '--report=markdown'])
    expect(code).toBe(0)
    // Header + the moon-style table with one row for the task.
    expect(stdout).toContain('## vx run')
    expect(stdout).toContain('| Task | Status | Cache | Duration |')
    expect(stdout).toMatch(/\| one#hello \| success \| miss \|/)
  })

  it('bare --report defaults to markdown', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', '--all', 'hello', '--report'])
    expect(code).toBe(0)
    expect(stdout).toContain('| Task | Status | Cache | Duration |')
  })

  // The documented step-summary recipe was `--report=markdown >> $FILE`, but
  // the status logger writes to stdout too, so the redirect captured frames,
  // meter bars and `::group::` commands above the table. `--report-file`
  // writes the report and nothing else.
  it('--report-file writes ONLY the report — no frames, no meters', async () => {
    const path = await import('node:path')
    const { readFile } = await import('node:fs/promises')
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const target = path.join(workspaceRoot, 'summary.md')
    const code = await run([
      'run',
      '--all',
      'hello',
      '--output-logs',
      'full',
      `--report-file=${target}`,
    ])
    expect(code).toBe(0)
    const written = await readFile(target, 'utf8')
    expect(written).toContain('| Task | Status | Cache | Duration |')
    expect(written).toMatch(/\| one#hello \| success \| miss \|/)
    // The whole point: everything the logger printed to stdout stays out.
    expect(written).not.toContain('┌─')
    expect(written).not.toContain('▰')
    expect(written).not.toContain('$ echo hello-cli')
    expect(written.startsWith('## vx run')).toBe(true)
    // …and stdout did carry that noise, so the assertion above is not
    // passing because the run printed nothing.
    expect(stdout).toContain('┌─')
    // No `--report`, so the table is NOT also on stdout.
    expect(stdout).not.toContain('| Task | Status | Cache | Duration |')
  })

  it('--report-file appends, so a shared step summary is never truncated', async () => {
    const path = await import('node:path')
    const { readFile, writeFile } = await import('node:fs/promises')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const target = path.join(workspaceRoot, 'summary.md')
    await writeFile(target, 'FROM-AN-EARLIER-STEP\n')
    expect(await run(['run', '--all', 'hello', `--report-file=${target}`])).toBe(0)
    expect(await run(['run', '--all', 'hello', `--report-file=${target}`])).toBe(0)
    const written = await readFile(target, 'utf8')
    // Another step's content survives — GitHub documents the summary file as
    // append-only and several steps write to it.
    expect(written).toContain('FROM-AN-EARLIER-STEP')
    expect(written.match(/^## vx run/gm)?.length).toBe(2)
  })

  it('--report and --report-file together write both sinks', async () => {
    const path = await import('node:path')
    const { readFile } = await import('node:fs/promises')
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const target = path.join(workspaceRoot, 'summary.md')
    const code = await run([
      'run',
      '--all',
      'hello',
      '--report=markdown',
      `--report-file=${target}`,
    ])
    expect(code).toBe(0)
    expect(stdout).toContain('| Task | Status | Cache | Duration |')
    expect(await readFile(target, 'utf8')).toContain('| Task | Status | Cache | Duration |')
  })

  it('no --report flag prints no markdown table', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', '--all', 'hello'])
    expect(code).toBe(0)
    expect(stdout).not.toContain('| Task | Status | Cache | Duration |')
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

  it('rejects watch with no task name', async () => {
    expect(await run(['watch'])).toBe(1)
    expect(stderr).toContain('missing task name')
  })

  it('rejects watch with --dry', async () => {
    expect(await run(['watch', 'build', '--dry'])).toBe(1)
    expect(stderr).toContain('--dry / --graph are not supported in watch mode')
  })

  it('rejects watch with --graph', async () => {
    expect(await run(['watch', 'build', '--graph'])).toBe(1)
    expect(stderr).toContain('--dry / --graph are not supported in watch mode')
  })

  it('rejects watch with --summarize', async () => {
    expect(await run(['watch', 'build', '--summarize'])).toBe(1)
    expect(stderr).toContain('--summarize / --profile are not supported')
  })

  it('rejects watch with --profile', async () => {
    expect(await run(['watch', 'build', '--profile'])).toBe(1)
    expect(stderr).toContain('--summarize / --profile are not supported')
  })

  it('surfaces parser errors with the watch prefix', async () => {
    expect(await run(['watch', 'build', '--concurrency', 'oops'])).toBe(1)
    expect(stderr).toContain('vx watch:')
    expect(stderr).toContain('invalid concurrency')
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
            cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
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
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const cmd = startWatch(['watch', '--all', 'hello'])
      await waitFor(() => stdout.includes('watching 1 project'))
      await writeFile(path.join(workspaceRoot, 'packages', 'one', 'src', 'index.txt'), 'v1')
      await waitFor(() => /re-running\.\.\./.test(stdout))
      // Long enough for a runaway loop (cycles take ~30 ms) to show itself.
      await new Promise((r) => setTimeout(r, 1500))
      process.emit('SIGINT')
      expect(await cmd).toBe(0)
      const reRuns = (stdout.match(/re-running\.\.\./g) ?? []).length
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
      expect(stdout).toContain('vx watch: initial run')
      expect(stdout).toMatch(/re-running\.\.\./)
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
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

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
      // after the initial run.
      await new Promise((r) => setTimeout(r, 400))
      const reRunCount = (stdout.match(/re-running\.\.\./g) ?? []).length
      expect(reRunCount).toBe(0)

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
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

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
      const reRunCount = (stdout.match(/re-running\.\.\./g) ?? []).length
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
    'workspace-root lockfile changes trigger a cycle (workspace fingerprint)',
    async () => {
      const path = await import('node:path')
      const { writeFile } = await import('node:fs/promises')

      let stdout = ''
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      const cmd = startWatch(['watch', '--all', 'hello'])
      await waitFor(() => stdout.includes('watching 1 project'))

      // Touch a lockfile at the root. Should trigger a cycle even
      // though no project dir saw the change.
      await writeFile(path.join(workspaceRoot, 'bun.lock'), '# lockfile bump')
      await waitFor(() => stdout.includes('re-running'))

      process.emit('SIGINT')
      await cmd
    },
    { timeout: 90_000 },
  )

  it(
    'SIGTERM also exits the watch loop cleanly',
    async () => {
      let stdout = ''
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout += String(chunk)
        return true
      })
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

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
              cache: {
                inputs: { files: ['src/**'], workspaceFiles: ['shared/**'] },
                outputs: { files: [] },
              },
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

      const cmd = startWatch(['watch', '--all', 'hello', '--output-logs', 'full'])
      await waitFor(() => stdout.includes('watching the workspace root'))

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
async function waitFor(predicate: () => boolean, timeoutMs = 45_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`)
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
    expect(r.graph).toBeUndefined()
    expect(r.summarize).toBeUndefined()
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
    expect(parseRunArgs(['build', '--concurrency', '2']).concurrency).toBe(2)
    expect(parseRunArgs(['build', '-c', '4']).error).toMatch(/unknown flag: -c/)
    // A near miss names the documented flag; a far one gets no guess.
    expect(parseRunArgs(['build', '--concurency', '4']).error).toBe(
      'unknown flag: --concurency (did you mean --concurrency?) (see `vx run --help`)',
    )
    expect(parseRunArgs(['build', '--zzz']).error).toBe('unknown flag: --zzz (see `vx run --help`)')
    // The candidate list itself: run's documented flags come from the help
    // text's `(for run)` sections, and prune's flag is not among them.
    const flags = documentedFlags('run')
    expect(flags).toContain('--concurrency')
    expect(flags).toContain('--affected')
    expect(flags).not.toContain('--older-than')
    expect(documentedFlags('no-such-verb')).toEqual([])
    // Another verb's flag is never suggested to `run`.
    expect(parseRunArgs(['build', '--older-tha', '1d']).error).toBe(
      'unknown flag: --older-tha (see `vx run --help`)',
    )
  })

  it('parses --cache-dir (space + = forms) without colliding with --cache', () => {
    expect(parseRunArgs(['build', '--cache-dir', '/tmp/x']).cacheDir).toBe('/tmp/x')
    expect(parseRunArgs(['build', '--cache-dir=./out/cache']).cacheDir).toBe('./out/cache')
    // --cache still parses its own policy spec, undisturbed.
    expect(parseRunArgs(['build', '--cache=local:r']).cacheDir).toBeUndefined()
    expect(parseRunArgs(['build']).cacheDir).toBeUndefined()
    expect(parseRunArgs(['build', '--cache-dir']).error).toMatch(/--cache-dir requires a value/)
  })

  it('parses --verify in all five forms + rejects unknown modes', () => {
    // bare / =determinism → determinism (+ fingerprint for free — fp1 exists anyway)
    expect(parseRunArgs(['build', '--verify']).verify).toEqual({
      determinism: true,
      inputs: false,
      fingerprint: true,
    })
    expect(parseRunArgs(['build', '--verify=determinism']).verify).toEqual({
      determinism: true,
      inputs: false,
      fingerprint: true,
    })
    // =inputs → input-completeness only (fingerprint-free by mode clarity)
    expect(parseRunArgs(['build', '--verify=inputs']).verify).toEqual({
      determinism: false,
      inputs: true,
      fingerprint: false,
    })
    // =fingerprint → fingerprint only (no re-run, no sandbox)
    expect(parseRunArgs(['build', '--verify=fingerprint']).verify).toEqual({
      determinism: false,
      inputs: false,
      fingerprint: true,
    })
    // =all → everything
    expect(parseRunArgs(['build', '--verify=all']).verify).toEqual({
      determinism: true,
      inputs: true,
      fingerprint: true,
    })
    // absent → undefined (zero-cost default)
    expect(parseRunArgs(['build']).verify).toBeUndefined()
    // unknown mode → loud error naming the valid set (incl. the new mode)
    expect(parseRunArgs(['build', '--verify=bogus']).error).toMatch(
      /--verify must be determinism \| inputs \| fingerprint \| all/,
    )
  })

  it('parses --verify-allow as a comma list of task ids (space + = forms)', () => {
    expect(parseRunArgs(['build', '--verify-allow=a#build,b#test']).verifyAllow).toEqual([
      'a#build',
      'b#test',
    ])
    // The space form is what docs/cli.md documents — it must not be an
    // unknown flag.
    const spaced = parseRunArgs(['build', '--verify-allow', 'a#build,b#test'])
    expect(spaced.error).toBeUndefined()
    expect(spaced.verifyAllow).toEqual(['a#build', 'b#test'])
    expect(spaced.tasks).toEqual(['build'])
    expect(parseRunArgs(['build']).verifyAllow).toEqual([])
    expect(parseRunArgs(['build', '--verify-allow']).error).toMatch(
      /--verify-allow requires a value/,
    )
    // A swallowed flag is never a task id.
    expect(parseRunArgs(['build', '--verify-allow', '--force']).error).toMatch(
      /--verify-allow requires a value, got flag: --force/,
    )
  })

  it('--cache-dir rejects a flag-shaped value in the space form', () => {
    // `--cache-dir $EMPTY --force` with an unquoted empty var: the arg
    // vanishes and `--force` would become the cache directory.
    expect(parseRunArgs(['build', '--cache-dir', '--force']).error).toMatch(
      /--cache-dir requires a path, got flag: --force/,
    )
    // The `=` form still takes a literal leading dash if someone means it.
    expect(parseRunArgs(['build', '--cache-dir=-weird']).cacheDir).toBe('-weird')
  })

  it('--excludeDependencies= (empty value) is rejected, not read as "exclude nothing"', () => {
    const r = parseRunArgs(['build', '--excludeDependencies='])
    expect(r.error).toMatch(/--excludeDependencies= needs a value/)
    // Both unambiguous forms keep working.
    expect(parseRunArgs(['build', '--excludeDependencies']).excludeDependencies).toBe('all')
    expect(parseRunArgs(['build', '--excludeDependencies=a,b']).excludeDependencies).toEqual([
      'a',
      'b',
    ])
  })

  it('parses --all (replaces -r / --recursive)', () => {
    expect(parseRunArgs(['build', '--all']).all).toBe(true)
    expect(parseRunArgs(['build', '-r']).error).toMatch(/unknown flag: -r/)
    expect(parseRunArgs(['build', '--recursive']).error).toMatch(/unknown flag: --recursive/)
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

  it('--cache=<spec> sets named layers exactly and leaves others (= and space forms)', () => {
    // remote read-only: local stays rw (default), remote drops write.
    expect(parseRunArgs(['build', '--cache=local:rw,remote:r']).cache).toEqual({
      localRead: true,
      localWrite: true,
      remoteRead: true,
      remoteWrite: false,
    })
    // local read-only, remote untouched (still rw).
    expect(parseRunArgs(['build', '--cache=local:r']).cache).toEqual({
      localRead: true,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
    // remote: with empty flags turns remote fully off; local untouched.
    expect(parseRunArgs(['build', '--cache=remote:']).cache).toEqual({
      localRead: true,
      localWrite: true,
      remoteRead: false,
      remoteWrite: false,
    })
    // Space form parses identically to the = form.
    expect(parseRunArgs(['build', '--cache', 'local:r']).cache).toEqual({
      localRead: true,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
  })

  it('--cache rejects unknown layers and flags', () => {
    expect(parseRunArgs(['build', '--cache=disk:r']).error).toMatch(/invalid --cache layer/)
    expect(parseRunArgs(['build', '--cache=local:x']).error).toMatch(/invalid --cache flag/)
    expect(parseRunArgs(['build', '--cache=local']).error).toMatch(/invalid --cache segment/)
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

  it('--force layers on top of a --cache base (reads off, writes from spec)', () => {
    // --cache=remote: turns remote off; --force then drops reads. Result:
    // local write-only re-exec with remote fully off.
    expect(parseRunArgs(['build', '--cache=remote:', '--force']).cache).toEqual({
      localRead: false,
      localWrite: true,
      remoteRead: false,
      remoteWrite: false,
    })
  })

  it('--output-logs validates its mode and threads through', () => {
    const ok = parseRunArgs(['build', '--output-logs', 'errors-only'])
    expect(ok.error).toBeUndefined()
    expect(ok.outputLogs).toBe('errors-only')
    const bad = parseRunArgs(['build', '--output-logs', 'loud'])
    expect(bad.error).toContain('--output-logs must be')
  })

  it('parses --excludeDependencies as "all" with no value', () => {
    expect(parseRunArgs(['build', '--excludeDependencies']).excludeDependencies).toBe('all')
    expect(parseRunArgs(['build', '--ignore-depends-on']).error).toMatch(/unknown flag/)
    expect(parseRunArgs(['build', '--only']).error).toMatch(/unknown flag/)
  })

  it('parses --excludeDependencies=name1,name2 as a name list', () => {
    expect(parseRunArgs(['build', '--excludeDependencies=lint,test']).excludeDependencies).toEqual([
      'lint',
      'test',
    ])
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
    expect(parseRunArgs(['build', '--verbosity', 'high']).error).toMatch(/invalid verbosity/)
    expect(parseRunArgs(['build', '--verbosity', '-1']).error).toMatch(/invalid verbosity/)
  })

  it('parses --dry and --dry=json / --dry=text', () => {
    expect(parseRunArgs(['build', '--dry']).dry).toBe('text')
    expect(parseRunArgs(['build', '--dry=text']).dry).toBe('text')
    expect(parseRunArgs(['build', '--dry=json']).dry).toBe('json')
    expect(parseRunArgs(['build', '--dry-run']).error).toMatch(/unknown flag: --dry-run/)
  })

  it('rejects invalid --dry=<format>', () => {
    expect(parseRunArgs(['build', '--dry=yaml']).error).toMatch(/invalid --dry value: yaml/)
  })

  it('parses --graph (stdout) and --graph=<path>', () => {
    expect(parseRunArgs(['build', '--graph']).graph).toBe('')
    expect(parseRunArgs(['build', '--graph=g.dot']).graph).toBe('g.dot')
  })

  it('rejects --dry combined with --graph (mutually exclusive)', () => {
    expect(parseRunArgs(['build', '--dry', '--graph']).error).toMatch(/mutually exclusive/)
  })

  it('parses --summarize (default path) and --summarize=<path>', () => {
    expect(parseRunArgs(['build', '--summarize']).summarize).toBe('')
    expect(parseRunArgs(['build', '--summarize=out.json']).summarize).toBe('out.json')
  })

  it('parses --profile (default profile.json) and --profile=<path>', () => {
    expect(parseRunArgs(['build', '--profile']).profile).toBe('profile.json')
    expect(parseRunArgs(['build', '--profile=trace.json']).profile).toBe('trace.json')
  })

  it('rejects --summarize / --profile with --dry or --graph', () => {
    expect(parseRunArgs(['build', '--dry', '--summarize']).error).toMatch(/need a real run/)
    expect(parseRunArgs(['build', '--graph', '--profile']).error).toMatch(/need a real run/)
  })

  it('rejects --graph with --summarize and --dry with --profile (planning skips execution)', () => {
    expect(parseRunArgs(['build', '--graph', '--summarize']).error).toMatch(/need a real run/)
    expect(parseRunArgs(['build', '--dry', '--profile']).error).toMatch(/need a real run/)
  })

  it('parses --retry <n> / --retry=<n> and validates it', () => {
    expect(parseRunArgs(['build', '--retry', '3']).retries).toBe(3)
    expect(parseRunArgs(['build', '--retry=0']).retries).toBe(0)
    expect(parseRunArgs(['build']).retries).toBeUndefined()
    // Negative / non-integer → non-negative-integer error.
    expect(parseRunArgs(['build', '--retry', '-1']).error).toMatch(/non-negative/)
    expect(parseRunArgs(['build', '--retry=1.5']).error).toMatch(/non-negative/)
    // Missing value.
    expect(parseRunArgs(['build', '--retry']).error).toMatch(/--retry requires a value/)
  })

  it('parses --timeout <ms> / --timeout=<ms> and validates it', () => {
    expect(parseRunArgs(['build', '--timeout', '5000']).timeout).toBe(5000)
    expect(parseRunArgs(['build', '--timeout=1000']).timeout).toBe(1000)
    expect(parseRunArgs(['build']).timeout).toBeUndefined()
    // 0 / negative → positive-integer error.
    expect(parseRunArgs(['build', '--timeout', '0']).error).toMatch(/positive integer/)
    expect(parseRunArgs(['build', '--timeout=-5']).error).toMatch(/positive integer/)
    // Missing value.
    expect(parseRunArgs(['build', '--timeout']).error).toMatch(/--timeout requires a value/)
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

  it('-p / --project is no longer recognized', () => {
    expect(parseRunArgs(['build', '-p', 'foo']).error).toMatch(/unknown flag: -p/)
  })

  it('rejects missing flag value', () => {
    expect(parseRunArgs(['build', '--filter']).error).toMatch(/requires a value/)
  })

  it('-F short alias is no longer recognized', () => {
    expect(parseRunArgs(['build', '-F', 'foo']).error).toMatch(/unknown flag: -F/)
  })

  it('rejects bad concurrency', () => {
    expect(parseRunArgs(['build', '--concurrency', 'abc']).error).toMatch(/invalid concurrency/)
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

  it('parses --tag k=v (space form) and is repeatable', () => {
    const r = parseRunArgs(['build', '--tag', 'env=ci', '--tag', 'branch=main'])
    expect(r.error).toBeUndefined()
    expect(r.tags).toEqual({ env: 'ci', branch: 'main' })
  })

  it('parses --tag=k=v (equals form)', () => {
    expect(parseRunArgs(['build', '--tag=env=ci']).tags).toEqual({ env: 'ci' })
  })

  it('--tag splits on the first = so values may contain =', () => {
    expect(parseRunArgs(['build', '--tag=url=https://x?a=b']).tags).toEqual({
      url: 'https://x?a=b',
    })
  })

  it('defaults --tag to an empty object', () => {
    expect(parseRunArgs(['build']).tags).toEqual({})
  })

  it('rejects --tag with an empty key', () => {
    expect(parseRunArgs(['build', '--tag', '=ci']).error).toMatch(/invalid --tag/)
    expect(parseRunArgs(['build', '--tag=']).error).toMatch(/invalid --tag/)
    expect(parseRunArgs(['build', '--tag=novalue']).error).toMatch(/invalid --tag/)
  })

  it('parses --report and --report=markdown', () => {
    expect(parseRunArgs(['build', '--report']).report).toBe('markdown')
    expect(parseRunArgs(['build', '--report=markdown']).report).toBe('markdown')
  })

  it('defaults --report to undefined', () => {
    expect(parseRunArgs(['build']).report).toBeUndefined()
  })

  it('parses --report-file in both forms, and never as --report', () => {
    expect(parseRunArgs(['build', '--report-file=out.md']).reportFile).toBe('out.md')
    expect(parseRunArgs(['build', '--report-file', 'out.md']).reportFile).toBe('out.md')
    // `--report-file` must not be swallowed by the `--report` branch — the
    // report would then go to stdout and the path become a task name.
    expect(parseRunArgs(['build', '--report-file=out.md']).report).toBeUndefined()
    expect(parseRunArgs(['build', '--report-file=out.md']).tasks).toEqual(['build'])
    expect(parseRunArgs(['build']).reportFile).toBeUndefined()
  })

  it('rejects an empty or flag-shaped --report-file value', () => {
    expect(parseRunArgs(['build', '--report-file=']).error).toMatch(/--report-file requires a path/)
    expect(parseRunArgs(['build', '--report-file']).error).toMatch(/--report-file requires a path/)
    expect(parseRunArgs(['build', '--report-file', '--all']).error).toMatch(/got flag: --all/)
  })

  it('rejects a non-markdown --report value (json reserved)', () => {
    expect(parseRunArgs(['build', '--report=json']).error).toMatch(/invalid --report value/)
    expect(parseRunArgs(['build', '--report=foo']).error).toMatch(/invalid --report value/)
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
  it('rejects empty args', () => {
    expect(parsePruneArgs([]).error).toMatch(/--older-than|--max-size/)
  })

  it('parses --older-than as a wall-clock cutoff', () => {
    const before = Date.now()
    const r = parsePruneArgs(['--older-than', '7d'])
    expect(r.error).toBeUndefined()
    expect(r.olderThanMs).toBeDefined()
    expect(r.olderThanMs!).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000 + 5)
    expect(r.olderThanMs!).toBeGreaterThanOrEqual(before - 7 * 86_400_000 - 5)
  })

  it('parses --max-size', () => {
    expect(parsePruneArgs(['--max-size', '1G']).maxBytes).toBe(1024 ** 3)
  })

  it('rejects missing flag values', () => {
    expect(parsePruneArgs(['--older-than']).error).toMatch(/requires a value/)
    expect(parsePruneArgs(['--max-size']).error).toMatch(/requires a value/)
  })

  it('rejects unknown flags', () => {
    expect(parsePruneArgs(['--bogus']).error).toMatch(/unknown argument/)
  })

  it('accepts both flags together', () => {
    const r = parsePruneArgs(['--older-than', '24h', '--max-size', '500M'])
    expect(r.olderThanMs).toBeDefined()
    expect(r.maxBytes).toBe(500 * 1024 * 1024)
  })
})

describe('vx cache prune command', () => {
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
    process.chdir(workspaceRoot)
  })

  afterEach(async () => {
    process.chdir(origCwd)
    const { rm } = await import('node:fs/promises')
    await rm(workspaceRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('errors when called with no policy', async () => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    const code = await run(['cache', 'prune'])
    expect(code).toBe(1)
    expect(stderr).toContain('--older-than')
  })

  it('reports 0 entries pruned from an empty cache', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await run(['cache', 'prune', '--older-than', '1s'])
    expect(code).toBe(0)
    expect(stdout).toContain('Pruned 0 entries')
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
})

describe('formatRunReportMarkdown', () => {
  it('renders a totals header and one table row per task', () => {
    const md = formatRunReportMarkdown({
      ok: true,
      outcomes: [
        { taskId: 'web#build', status: 'success', exitCode: 0, durationMs: 1234 },
        { taskId: 'web#test', status: 'cache-hit', exitCode: 0, durationMs: 5, restored: true },
        {
          taskId: 'api#test',
          status: 'cache-hit-remote',
          exitCode: 0,
          durationMs: 3,
          restored: false,
        },
      ],
    })
    expect(md).toContain('## vx run — passed')
    expect(md).toContain('**3 tasks**')
    expect(md).toContain('3 success')
    expect(md).toContain('2 cached')
    expect(md).toContain('| Task | Status | Cache | Duration |')
    expect(md).toContain('| web#build | success | miss | 1.23s |')
    expect(md).toContain('| web#test | success | local | 5ms |')
    // remote hit with restored:false materialized nothing → up-to-date.
    expect(md).toContain('| api#test | success | up-to-date | 3ms |')
  })

  it('marks the header failed and renders the exit code', () => {
    const md = formatRunReportMarkdown({
      ok: false,
      outcomes: [
        { taskId: 'web#build', status: 'failed', exitCode: 2, durationMs: 40 },
        { taskId: 'web#test', status: 'skipped', exitCode: 0, durationMs: 0 },
      ],
    })
    expect(md).toContain('## vx run — failed')
    expect(md).toContain('1 failed')
    expect(md).toContain('1 skipped')
    expect(md).toContain('| web#build | failed (exit 2) | miss | 40ms |')
    expect(md).toContain('| web#test | skipped | — | 0ms |')
  })

  it('keeps aborted tasks out of the totals but still names them', () => {
    const md = formatRunReportMarkdown({
      ok: true,
      outcomes: [
        { taskId: 'web#build', status: 'success', exitCode: 0, durationMs: 10 },
        { taskId: 'web#dev', status: 'aborted', exitCode: 143, durationMs: 99 },
      ],
    })
    // Aborted did no work, so it joins no outcome bucket and no total. It is
    // still named: a run carrying one exits non-zero, and a report that shows
    // only green rows leaves that red undiagnosable.
    expect(md).toContain('**1 task**')
    expect(md).toContain('1 aborted')
    expect(md).toContain('| web#dev | aborted | — | 99ms |')
  })

  it('escapes pipes and newlines so a hostile task name cannot break the table', () => {
    const md = formatRunReportMarkdown({
      ok: true,
      outcomes: [
        { taskId: 'p1#evil|col', status: 'success', exitCode: 0, durationMs: 3 },
        { taskId: 'p1#evil\nrow', status: 'success', exitCode: 0, durationMs: 4 },
      ],
    })
    const rows = md.split('\n').filter((l) => l.startsWith('| p1#'))
    // Two tasks → exactly two rows: an unescaped newline splits one into two.
    expect(rows.length).toBe(2)
    // Every row keeps the header's 4 columns: an unescaped `|` adds a 5th.
    for (const row of rows) {
      expect(row.split(/(?<!\\)\|/).length - 2).toBe(4)
    }
    expect(md).toContain('| p1#evil\\|col | success | miss | 3ms |')
    expect(md).toContain('| p1#evil row | success | miss | 4ms |')
  })

  // "N saved" is the report's headline claim and it summed the wrong number:
  // a cache hit's `durationMs` is the RESTORE this run paid, not the exec time
  // the entry was stored with. Measured on a real fixture, a task that takes
  // 2.01s cold reported "6ms saved".
  it('"saved" sums the STORED exec time, not the restore cost', () => {
    const md = formatRunReportMarkdown({
      ok: true,
      outcomes: [
        {
          taskId: 'web#build',
          status: 'cache-hit',
          exitCode: 0,
          durationMs: 6,
          storedDurationMs: 2006,
          restored: true,
        },
        {
          taskId: 'api#build',
          status: 'cache-hit-remote',
          exitCode: 0,
          durationMs: 4,
          storedDurationMs: 1000,
          restored: true,
        },
      ],
    })
    // 2006 + 1000 = 3.01s of work skipped — not the 10ms it cost to restore.
    expect(md).toContain('3.01s saved')
    expect(md).not.toContain('10ms saved')
    // The per-task Duration column stays what THIS run spent.
    expect(md).toContain('| web#build | success | local | 6ms |')
  })

  it('claims no saving for a hit that does not know what it skipped', () => {
    // Only reachable across a version skew. Substantiating "saved" with the
    // restore cost is the defect; saying nothing is the honest degrade.
    const md = formatRunReportMarkdown({
      ok: true,
      outcomes: [
        { taskId: 'web#build', status: 'cache-hit', exitCode: 0, durationMs: 7, restored: true },
      ],
    })
    expect(md).not.toContain('saved')
    expect(md).toContain('1 cached')
  })

  // Three surfaces describe one run. The terminal summary and `--summarize`
  // share `tallyOutcomes` and so cannot disagree; the report had its own copy
  // with no group filter (it could not have one — `OutcomeView` carried no
  // `isGroup`), so every organizational node was counted as a successful task
  // AND rendered as a row claiming `success | miss | 0ms`.
  it('excludes group tasks from the totals and from the table', () => {
    const md = formatRunReportMarkdown({
      ok: true,
      outcomes: [
        { taskId: 'pkg#real', status: 'success', exitCode: 0, durationMs: 6 },
        { taskId: 'pkg#grp', status: 'success', exitCode: 0, durationMs: 0, isGroup: true },
      ],
    })
    expect(md).toContain('**1 task**')
    expect(md).toContain('1 success')
    expect(md).toContain('| pkg#real | success | miss | 6ms |')
    expect(md).not.toContain('pkg#grp')
  })

  it('a group node never contributes a duration or a cache bucket', () => {
    const md = formatRunReportMarkdown({
      ok: true,
      outcomes: [
        {
          taskId: 'pkg#hit',
          status: 'cache-hit',
          exitCode: 0,
          durationMs: 3,
          storedDurationMs: 500,
          restored: true,
        },
        // A group's rolled-up outcome reads `success` with 0ms; counting it
        // would report 2 tasks / 2 success for one task's worth of work.
        { taskId: 'pkg#ci', status: 'success', exitCode: 0, durationMs: 0, isGroup: true },
      ],
    })
    expect(md).toContain('**1 task**')
    expect(md).toContain('1 cached')
    expect(md).toContain('500ms saved')
    expect(md).toContain('0ms total') // the group added no executed time
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
})
