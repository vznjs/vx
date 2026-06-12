import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import {
  formatBytes,
  parseDuration,
  parsePruneArgs,
  parseRunArgs,
  parseSize,
  run,
} from '../src/cli/index.js'

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

  it('rejects unknown command', async () => {
    expect(await run(['nope'])).toBe(1)
    expect(stderr).toContain('unknown command')
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
    expect(stdout).toContain('● one#hello ── success •')
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
    expect(stdout).toContain('● one#hello ── success •')
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
      const cmd = run(['watch', '--all', 'hello', '--output-logs', 'full'])

      // Wait for the initial run to appear in stdout, then write a change.
      await waitFor(() => stdout.includes('v0'))
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
    { timeout: 20_000 },
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

      const cmd = run(['watch', '--all', 'hello'])
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
    { timeout: 20_000 },
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

      const cmd = run(['watch', '--all', 'hello', '--output-logs', 'full'])
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
    { timeout: 20_000 },
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

      const cmd = run(['watch', '--all', 'hello'])
      await waitFor(() => stdout.includes('watching 1 project'))

      // Touch a lockfile at the root. Should trigger a cycle even
      // though no project dir saw the change.
      await writeFile(path.join(workspaceRoot, 'bun.lock'), '# lockfile bump')
      await waitFor(() => stdout.includes('re-running'))

      process.emit('SIGINT')
      await cmd
    },
    { timeout: 20_000 },
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

      const cmd = run(['watch', '--all', 'hello'])
      await waitFor(() => stdout.includes('watching 1 project'))

      process.emit('SIGTERM')
      const code = await cmd
      expect(code).toBe(0)
    },
    { timeout: 20_000 },
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

      const cmd = run(['watch', '--all', 'hello', '--output-logs', 'full'])
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
    { timeout: 20_000 },
  )
})

async function writeFor(
  _label: string,
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  await waitFor(predicate, timeoutMs)
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
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
    expect(r.noCache).toBe(false)
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
  })

  it('parses --all (replaces -r / --recursive)', () => {
    expect(parseRunArgs(['build', '--all']).all).toBe(true)
    expect(parseRunArgs(['build', '-r']).error).toMatch(/unknown flag: -r/)
    expect(parseRunArgs(['build', '--recursive']).error).toMatch(/unknown flag: --recursive/)
  })

  it('parses --no-cache and --force (alias)', () => {
    expect(parseRunArgs(['build', '--no-cache']).noCache).toBe(true)
    expect(parseRunArgs(['build', '--force']).noCache).toBe(true)
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
    expect(r.noCache).toBe(false)
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
