import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatBytes, formatStats, parseRunArgs, run } from './cli.js'

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
    expect(stdout).toMatch(/^vzn \d/)
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
    expect(stdout).toMatch(/^vzn \d/)
  })
})

describe('cli run() end-to-end against a real fixture workspace', () => {
  let workspaceRoot: string
  const origCwd = process.cwd()

  beforeEach(async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vzn-cli-e2e-'))
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
      path.join(pkgDir, 'vzn.config.mjs'),
      `export default {
        run: {
          tasks: {
            hello: {
              exec: { command: "echo hello-cli" },
              cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
            },
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
      path.join(workspaceRoot, 'packages', 'one', 'vzn.config.mjs'),
      `export default {
        run: {
          tasks: {
            fail: {
              exec: { command: "exit 9" },
            },
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
      path.join(workspaceRoot, 'packages', 'one', 'vzn.config.mjs'),
      `export default {
        run: {
          tasks: {
            echo: {
              exec: { command: "echo forwarded:" },
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
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vzn-stats-'))
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

  it('exits 1 when not inside a pnpm workspace', async () => {
    process.chdir(origCwd)
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    // Move out of any workspace.
    const os = await import('node:os')
    process.chdir(os.tmpdir())
    const code = await run(['stats'])
    expect(code).toBe(1)
    expect(stderr).toContain('Could not find pnpm-workspace.yaml')
  })
})
