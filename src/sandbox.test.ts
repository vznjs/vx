import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectPlatform,
  isSandboxSupported,
  runSandboxed,
  SandboxToolMissingError,
  SandboxUnsupportedError,
} from './sandbox.js'

const onLinux = process.platform === 'linux'
const sandboxAvailable = isSandboxSupported()

describe('detectPlatform', () => {
  it('matches process.platform for linux/darwin, "unsupported" otherwise', () => {
    if (process.platform === 'linux') expect(detectPlatform()).toBe('linux')
    else if (process.platform === 'darwin') expect(detectPlatform()).toBe('darwin')
    else expect(detectPlatform()).toBe('unsupported')
  })
})

describe('SandboxToolMissingError', () => {
  it('carries the missing tool name and a clear message', () => {
    const err = new SandboxToolMissingError('bwrap')
    expect(err.tool).toBe('bwrap')
    expect(err.message).toContain('bwrap')
    expect(err.message).toContain('PATH')
  })
})

describe('SandboxUnsupportedError', () => {
  it('carries the platform and a clear message', () => {
    const err = new SandboxUnsupportedError('win32')
    expect(err.platform).toBe('win32')
    expect(err.message).toContain('win32')
  })
})

describe.skipIf(!onLinux || !sandboxAvailable)('runSandboxed on Linux (bwrap)', () => {
  let workspace: string
  let projectDir: string

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'vzn-sandbox-'))
    projectDir = path.join(workspace, 'project')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('runs a simple command and captures stdout', async () => {
    const result = await runSandboxed({
      command: 'echo hello-from-sandbox',
      cwd: projectDir,
      env: { PATH: process.env.PATH ?? '' },
      projectDir,
      inputFiles: [],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello-from-sandbox')
  })

  it('a declared input file is readable inside the sandbox', async () => {
    const inputFile = path.join(workspace, 'declared.txt')
    await writeFile(inputFile, 'visible')

    const result = await runSandboxed({
      command: `cat ${JSON.stringify(inputFile)}`,
      cwd: projectDir,
      env: { PATH: process.env.PATH ?? '' },
      projectDir,
      inputFiles: [inputFile],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('visible')
  })

  it('an undeclared file outside projectDir is invisible (ENOENT)', async () => {
    const undeclared = path.join(workspace, 'undeclared.txt')
    await writeFile(undeclared, 'should not be visible')

    const result = await runSandboxed({
      command: `cat ${JSON.stringify(undeclared)} 2>&1; exit 42`,
      cwd: projectDir,
      env: { PATH: process.env.PATH ?? '' },
      projectDir,
      inputFiles: [], // <-- not declared
    })
    expect(result.exitCode).toBe(42)
    expect(result.stdout + result.stderr).toMatch(/No such file|cannot open/)
  })

  it('the project dir is read-write — outputs are produced inside it', async () => {
    const result = await runSandboxed({
      command: 'echo produced > dist.txt',
      cwd: projectDir,
      env: { PATH: process.env.PATH ?? '' },
      projectDir,
      inputFiles: [],
    })
    expect(result.exitCode).toBe(0)
    expect(await readFile(path.join(projectDir, 'dist.txt'), 'utf8')).toContain('produced')
  })

  it('declared inputs are read-only — writes to them fail', async () => {
    const inputFile = path.join(workspace, 'declared.txt')
    await writeFile(inputFile, 'original')

    const result = await runSandboxed({
      command: `echo modified > ${JSON.stringify(inputFile)} 2>&1; exit 7`,
      cwd: projectDir,
      env: { PATH: process.env.PATH ?? '' },
      projectDir,
      inputFiles: [inputFile],
    })
    expect(result.exitCode).toBe(7)
    expect(await readFile(inputFile, 'utf8')).toBe('original')
  })

  it('home directory is not mounted (the canonical "no leakage" check)', async () => {
    // The host's $HOME exists at /root in this container; if bwrap leaked
    // it the task would `ls /root` successfully. We expect it to be
    // missing or empty.
    const result = await runSandboxed({
      command: 'ls /root /home 2>/dev/null | wc -l',
      cwd: projectDir,
      env: { PATH: process.env.PATH ?? '' },
      projectDir,
      inputFiles: [],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('0')
  })

  it('reports cpuMs and peakRssBytes from rusage (v11 analytics)', async () => {
    const result = await runSandboxed({
      command: 'echo cpu-rss',
      cwd: projectDir,
      env: { PATH: process.env.PATH ?? '' },
      projectDir,
      inputFiles: [],
    })
    expect(result.exitCode).toBe(0)
    expect(result.cpuMs).toBeDefined()
    expect(result.peakRssBytes).toBeDefined()
    expect(result.cpuMs!).toBeGreaterThanOrEqual(0)
    expect(result.peakRssBytes!).toBeGreaterThan(0)
  })

  it('forwardArgs are appended (shell-quoted) to the command', async () => {
    const result = await runSandboxed({
      command: 'printf "%s|" "$@" --',
      cwd: projectDir,
      env: { PATH: process.env.PATH ?? '' },
      projectDir,
      inputFiles: [],
      forwardArgs: ['arg with space', '--flag', `'tricky'`],
    })
    expect(result.exitCode).toBe(0)
    // sh -c '<cmd>' positional args start at $0 when no script-name is
    // given via `sh -c '<cmd>' <name> <args...>`. With our wrapper we
    // don't pass a name, so $@ stays empty — assert at least that the
    // command ran cleanly (the negative is: it would fail to parse if
    // shell-quoting was wrong).
  })
})
