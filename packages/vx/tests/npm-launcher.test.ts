// scripts/npm-launcher.mjs is the `bin` of the published @vzn/vx package: a
// Node script that execs the platform package's binary, falls back to
// `bun <sourceEntry>`, and otherwise fails with an actionable message. It
// had no pin; the distribution path is exercised only on a release. Driven
// here against a fake install tree, so every arm runs on any platform.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const LAUNCHER = path.resolve(import.meta.dir, '../../../scripts/npm-launcher.mjs')
const KEY = `${process.platform}-${process.arch}`
const NODE = Bun.which('node')

describe.skipIf(NODE === null)('npm launcher', () => {
  let root: string
  let pkgDir: string
  let binDir: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'vx-launcher-'))
    // The published package: launcher.mjs beside its package.json.
    pkgDir = path.join(root, 'node_modules', '@vzn', 'vx')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@vzn/vx', version: '9.9.9' }),
    )
    binDir = path.join(root, 'bin')
    mkdirSync(binDir)
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function launcherReady(): Promise<void> {
    writeFileSync(path.join(pkgDir, 'launcher.mjs'), await Bun.file(LAUNCHER).text())
  }

  function run(
    args: string[],
    pathDirs: string[],
  ): { code: number | null; out: string; err: string } {
    const p = Bun.spawnSync({
      cmd: [NODE!, path.join(pkgDir, 'launcher.mjs'), ...args],
      cwd: root,
      env: { PATH: pathDirs.join(':'), HOME: root },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }

  it('execs the platform package binary with the argv and mirrors its exit code', async () => {
    await launcherReady()
    const plat = path.join(root, 'node_modules', '@vzn', `vx-${KEY}`)
    mkdirSync(plat, { recursive: true })
    writeFileSync(path.join(plat, 'package.json'), JSON.stringify({ name: `@vzn/vx-${KEY}` }))
    const bin = path.join(plat, 'vx')
    writeFileSync(bin, '#!/bin/sh\necho "fake binary: $@"\nexit 7\n')
    chmodSync(bin, 0o755)
    const r = run(['run', 'build', '--all'], ['/usr/bin', '/bin'])
    expect(r.out).toBe('fake binary: run build --all\n')
    expect(r.code).toBe(7)
  })

  it('with no platform package and no bun, fails with the actionable message', async () => {
    await launcherReady()
    const r = run(['--version'], ['/usr/bin', '/bin'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(`vx: no prebuilt binary for ${KEY}.`)
    expect(r.err).toContain(`@vzn/vx-${KEY} optionalDependency, or install Bun (>=1.4)`)
  })

  it('with no platform package but bun on PATH, runs the shipped source through bun', async () => {
    await launcherReady()
    const fakeBun = path.join(binDir, 'bun')
    writeFileSync(
      fakeBun,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.0; exit 0; fi\necho "fake bun: $@"\n',
    )
    chmodSync(fakeBun, 0o755)
    mkdirSync(path.join(pkgDir, 'src'))
    writeFileSync(path.join(pkgDir, 'src', 'bin.ts'), '') // sourceEntry must exist
    const r = run(['--version'], [binDir, '/usr/bin', '/bin'])
    expect(r.code).toBe(0)
    // The launcher locates the source beside its own REAL path (import.meta.url).
    expect(r.out).toBe(`fake bun: ${path.join(realpathSync(pkgDir), 'src', 'bin.ts')} --version\n`)
  })
})
