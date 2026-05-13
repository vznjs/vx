import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import {
  formatBytes,
  formatStats,
  formatStatsJson,
  parseDuration,
  parsePruneArgs,
  parseRunArgs,
  parseSize,
  parseStatsArgs,
  run,
} from '../src/cli.js'

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
    expect(await run(['run', 'build', '-c', 'oops'])).toBe(1)
    expect(stderr).toContain('invalid concurrency')
  })

  it('--version uses -V (lowercase -v is reserved for --verbose)', async () => {
    expect(await run(['-V'])).toBe(0)
    expect(stdout).toMatch(/^vx \d/)
  })
})

describe('cli run() end-to-end against a real fixture workspace', () => {
  let workspaceRoot: string
  const origCwd = process.cwd()

  beforeEach(async () => {
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
    process.chdir(workspaceRoot)
  })

  afterEach(async () => {
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

    const code = await run(['run', '-r', 'hello', '--dry-run'])
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

    const code = await run(['run', '-r', 'hello', '--dry-run', '--json'])
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

    const code = await run(['run', '-r', 'hello', '--graph'])
    expect(code).toBe(0)
    expect(stdout).toContain('digraph TaskGraph')
    expect(stdout).toContain('"one#hello"')
    expect(stdout).not.toContain('hello-cli')
  })

  it('exits 0 and prints task output when run with -r from workspace root', async () => {
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

    const code = await run(['run', '-r', 'hello'])
    expect(code).toBe(0)
    expect(stdout).toContain('hello-cli')
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

  it('-F filter selects matching projects', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await run(['run', '-F', 'one', 'hello'])
    expect(code).toBe(0)
    expect(stdout).toContain('hello-cli')
  })

  it('-F with no match errors clearly', async () => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })

    const code = await run(['run', '-F', 'nope', 'hello'])
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

    const code = await run(['run', '-r', '-v', 'hello'])
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

    const code = await run(['run', '-r', 'fail'])
    expect(code).toBe(1)
  })

  it('honors -F and --concurrency through to the orchestrator', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await run(['run', 'hello', '-F', 'one', '--concurrency', '1'])
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

    const code = await run(['run', '-r', 'echo', '--', 'hello', 'world'])
    expect(code).toBe(0)
    expect(stdout).toMatch(/forwarded: hello world/)
  })
})

describe('parseRunArgs', () => {
  it('parses task name', () => {
    const r = parseRunArgs(['build'])
    expect(r.task).toBe('build')
    expect(r.filters).toEqual([])
    expect(r.recursive).toBe(false)
    expect(r.noCache).toBe(false)
    expect(r.ignoreDependsOn).toBe(false)
    expect(r.verbose).toBe(false)
    expect(r.forwardArgs).toEqual([])
  })

  it('parses pkg#task syntax untouched (split happens later)', () => {
    const r = parseRunArgs(['@scope/web#build'])
    expect(r.task).toBe('@scope/web#build')
  })

  it('parses repeated --filter / -F', () => {
    const r = parseRunArgs(['build', '-F', 'foo', '--filter', '@scope/*'])
    expect(r.task).toBe('build')
    expect(r.filters).toEqual(['foo', '@scope/*'])
  })

  it('parses --concurrency', () => {
    expect(parseRunArgs(['build', '-c', '4']).concurrency).toBe(4)
    expect(parseRunArgs(['build', '--concurrency', '2']).concurrency).toBe(2)
  })

  it('parses --recursive / -r', () => {
    expect(parseRunArgs(['build', '--recursive']).recursive).toBe(true)
    expect(parseRunArgs(['build', '-r']).recursive).toBe(true)
  })

  it('parses --no-cache', () => {
    expect(parseRunArgs(['build', '--no-cache']).noCache).toBe(true)
  })

  it('--cache is accepted as a no-op (parity flag)', () => {
    const r = parseRunArgs(['build', '--cache'])
    expect(r.error).toBeUndefined()
    expect(r.noCache).toBe(false)
  })

  it('parses --ignore-depends-on', () => {
    expect(parseRunArgs(['build', '--ignore-depends-on']).ignoreDependsOn).toBe(true)
  })

  it('parses --verbose / -v', () => {
    expect(parseRunArgs(['build', '--verbose']).verbose).toBe(true)
    expect(parseRunArgs(['build', '-v']).verbose).toBe(true)
  })

  it('parses --dry-run and --dry as the same flag', () => {
    expect(parseRunArgs(['build', '--dry-run']).dryRun).toBe(true)
    expect(parseRunArgs(['build', '--dry']).dryRun).toBe(true)
  })

  it('parses --graph and --json', () => {
    expect(parseRunArgs(['build', '--graph']).graph).toBe(true)
    expect(parseRunArgs(['build', '--json']).json).toBe(true)
  })

  it('rejects --dry-run combined with --graph (mutually exclusive)', () => {
    const r = parseRunArgs(['build', '--dry-run', '--graph'])
    expect(r.error).toMatch(/mutually exclusive/)
  })

  it('captures trailing args after `--` as forwardArgs', () => {
    const r = parseRunArgs(['build', '--', '--watch', '--bail'])
    expect(r.task).toBe('build')
    expect(r.forwardArgs).toEqual(['--watch', '--bail'])
  })

  it('flags before `--` are parsed; flags after are forwarded literally', () => {
    const r = parseRunArgs(['-r', 'build', '--', '-v', '--no-cache'])
    expect(r.recursive).toBe(true)
    expect(r.task).toBe('build')
    expect(r.verbose).toBe(false)
    expect(r.noCache).toBe(false)
    expect(r.forwardArgs).toEqual(['-v', '--no-cache'])
  })

  it('rejects unknown flag', () => {
    expect(parseRunArgs(['--bogus']).error).toMatch(/unknown flag/)
  })

  it('-f / --force is no longer recognized', () => {
    expect(parseRunArgs(['build', '-f']).error).toMatch(/unknown flag: -f/)
    expect(parseRunArgs(['build', '--force']).error).toMatch(/unknown flag: --force/)
  })

  it('-p / --project is no longer recognized', () => {
    expect(parseRunArgs(['build', '-p', 'foo']).error).toMatch(/unknown flag: -p/)
  })

  it('rejects missing flag value', () => {
    expect(parseRunArgs(['build', '-F']).error).toMatch(/requires a value/)
  })

  it('rejects bad concurrency', () => {
    expect(parseRunArgs(['build', '-c', 'abc']).error).toMatch(/invalid concurrency/)
  })

  it('rejects double positional', () => {
    expect(parseRunArgs(['a', 'b']).error).toMatch(/unexpected positional/)
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

describe('parseStatsArgs', () => {
  it('defaults to json=false', () => {
    expect(parseStatsArgs([])).toEqual({ json: false })
  })

  it('parses --json', () => {
    expect(parseStatsArgs(['--json'])).toEqual({ json: true })
  })

  it('rejects unknown args', () => {
    const r = parseStatsArgs(['--bogus'])
    expect(r.error).toBe('unknown argument: --bogus')
  })
})

describe('formatStatsJson', () => {
  it('emits a parseable JSON object with all fields', () => {
    const out = formatStatsJson({
      entryCount: 42,
      totalBytes: 5 * 1024 * 1024,
      runCountLast24h: 100,
      hitCountLast24h: 73,
    })
    expect(out.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed).toEqual({
      entryCount: 42,
      totalBytes: 5 * 1024 * 1024,
      runCountLast24h: 100,
      hitCountLast24h: 73,
      hitRateLast24h: 0.73,
    })
  })

  it('returns null hitRate when there are no runs (distinct from 0%)', () => {
    const out = formatStatsJson({
      entryCount: 0,
      totalBytes: 0,
      runCountLast24h: 0,
      hitCountLast24h: 0,
    })
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed['hitRateLast24h']).toBeNull()
  })
})

describe('formatStats', () => {
  it('renders zero state with n/a hit rate', () => {
    const out = formatStats({
      entryCount: 0,
      totalBytes: 0,
      runCountLast24h: 0,
      hitCountLast24h: 0,
    })
    expect(out).toContain('Entries:           0')
    expect(out).toContain('Total size:        0 B')
    expect(out).toContain('Hits  (24h):       0  (n/a)')
  })

  it('renders populated state with hit-rate percentage', () => {
    const out = formatStats({
      entryCount: 42,
      totalBytes: 5 * 1024 * 1024,
      runCountLast24h: 100,
      hitCountLast24h: 73,
    })
    expect(out).toContain('Entries:           42')
    expect(out).toContain('Total size:        5.0 MB')
    expect(out).toContain('Runs (24h):        100')
    expect(out).toContain('Hits  (24h):       73  (73.0%)')
  })
})

describe('cli stats command', () => {
  let workspaceRoot: string
  const origCwd = process.cwd()

  beforeEach(async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-stats-'))
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

  it('prints cache statistics from an empty workspace', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await run(['stats'])
    expect(code).toBe(0)
    expect(stdout).toContain('Cache statistics')
    expect(stdout).toContain('Entries:           0')
  })

  it('--json emits parseable JSON instead of the human format', async () => {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await run(['stats', '--json'])
    expect(code).toBe(0)
    expect(stdout).not.toContain('Cache statistics')
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    expect(parsed).toEqual({
      entryCount: 0,
      totalBytes: 0,
      runCountLast24h: 0,
      hitCountLast24h: 0,
      hitRateLast24h: null,
    })
  })

  it('errors clearly on unknown stats args', async () => {
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    const code = await run(['stats', '--bogus'])
    expect(code).toBe(1)
    expect(stderr).toContain('unknown argument: --bogus')
  })

  it('exits 1 when not inside a workspace', async () => {
    process.chdir(origCwd)
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    // Walk to filesystem root — neither pnpm-workspace.yaml nor a
    // package.json should exist there.
    process.chdir('/')
    const code = await run(['stats'])
    expect(code).toBe(1)
    expect(stderr).toContain('Could not find a workspace root')
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
