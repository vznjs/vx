// npm-launcher.sh is the published @vzn/vx package's `bin`: it execs the
// platform package's binary from the shell, with no Node start, and hands
// anything else to launcher.cjs. Driven against fake install trees in the
// three layouts package managers make, with a PATH holding only the tools
// the script uses and a `node` that records it was called.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const LAUNCHER = path.resolve(import.meta.dir, '..', 'npm-launcher.sh')
const KEY = `${process.platform}-${process.arch}`
const GLIBC = { x64: '/lib64/ld-linux-x86-64.so.2', arm64: '/lib/ld-linux-aarch64.so.1' }
// The script takes the prebuilt binary only where its loader exists, as the
// cjs launcher does; on a musl host every row would read the fallback.
const loaderPresent =
  process.platform !== 'linux' || existsSync(GLIBC[process.arch as keyof typeof GLIBC] ?? '/')

function exe(file: string, body: string): void {
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

describe.skipIf(!loaderPresent)('npm launcher (sh)', () => {
  let root: string
  let tools: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'vx-launcher-sh-'))
    tools = path.join(root, 'tools')
    mkdirSync(tools)
    for (const t of ['sh', 'readlink', 'uname']) symlinkSync(Bun.which(t)!, path.join(tools, t))
    exe(path.join(tools, 'node'), 'echo "node $*"; exit 3')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** A package dir holding the launcher pair, and its platform binary at `binAt` (if any). */
  function install(pkgDir: string, binAt?: string): void {
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(path.join(pkgDir, 'launcher.sh'), readFileSync(LAUNCHER))
    chmodSync(path.join(pkgDir, 'launcher.sh'), 0o755)
    writeFileSync(path.join(pkgDir, 'launcher.cjs'), '')
    if (binAt !== undefined) {
      mkdirSync(path.dirname(binAt), { recursive: true })
      exe(binAt, 'echo "bin $*"; exit 7')
    }
  }

  function run(cmd: string[]): { code: number | null; out: string } {
    const p = Bun.spawnSync({
      cmd,
      cwd: root,
      env: { PATH: tools },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: p.exitCode, out: (p.stdout.toString() + p.stderr.toString()).trim() }
  }

  it('npm: through the .bin symlink, execs the hoisted platform binary with the argv and its exit', () => {
    const nm = path.join(root, 'node_modules')
    install(path.join(nm, '@vzn', 'vx'), path.join(nm, '@vzn', `vx-${KEY}`, 'vx'))
    mkdirSync(path.join(nm, '.bin'))
    symlinkSync('../@vzn/vx/launcher.sh', path.join(nm, '.bin', 'vx'))
    expect(run([path.join(nm, '.bin', 'vx'), 'run', 'a b'])).toEqual({
      code: 7,
      out: 'bin run a b',
    })
  })

  it('pnpm: through a symlinked package directory, finds the sibling in the store', () => {
    const store = path.join(root, 'node_modules', '.pnpm', '@vzn+vx@1', 'node_modules', '@vzn')
    install(path.join(store, 'vx'), path.join(store, `vx-${KEY}`, 'vx'))
    mkdirSync(path.join(root, 'node_modules', '@vzn'))
    symlinkSync(path.join(store, 'vx'), path.join(root, 'node_modules', '@vzn', 'vx'))
    // pnpm's .bin shim runs `sh <package dir>/launcher.sh`.
    const launcher = path.join(root, 'node_modules', '@vzn', 'vx', 'launcher.sh')
    expect(run([path.join(tools, 'sh'), launcher, '--version'])).toEqual({
      code: 7,
      out: 'bin --version',
    })
  })

  it('npm, unhoisted: finds the platform package under its own node_modules', () => {
    const pkg = path.join(root, 'node_modules', '@vzn', 'vx')
    install(pkg, path.join(pkg, 'node_modules', '@vzn', `vx-${KEY}`, 'vx'))
    expect(run([path.join(pkg, 'launcher.sh'), 'x'])).toEqual({ code: 7, out: 'bin x' })
  })

  it('with no platform binary, hands the argv to launcher.cjs under node', () => {
    const pkg = path.join(root, 'node_modules', '@vzn', 'vx')
    install(pkg)
    expect(run([path.join(pkg, 'launcher.sh'), 'run', 'b'])).toEqual({
      code: 3,
      out: `node ${pkg}/launcher.cjs run b`,
    })
  })

  it('control: a platform binary that is not executable is not taken', () => {
    const pkg = path.join(root, 'node_modules', '@vzn', 'vx')
    const bin = path.join(root, 'node_modules', '@vzn', `vx-${KEY}`, 'vx')
    install(pkg, bin)
    chmodSync(bin, 0o644)
    expect(run([path.join(pkg, 'launcher.sh')]).code).toBe(3)
  })
})
