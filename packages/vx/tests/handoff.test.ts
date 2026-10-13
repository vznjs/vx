// A global vx hands every call to the project's own @vzn/vx (owner,
// 2026-10-13). Both halves: npm-launcher.sh's walk, driven against fake
// install trees with a PATH holding only the tools the script uses, and
// the compiled binary's (`localVx`, `handOff`).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { localVx } from '../src/handoff.js'

const LAUNCHER = path.resolve(import.meta.dir, '..', 'npm-launcher.sh')
const HANDOFF = path.resolve(import.meta.dir, '..', 'src', 'handoff.ts')
const KEY = `${process.platform}-${process.arch}`
const GLIBC = { x64: '/lib64/ld-linux-x86-64.so.2', arm64: '/lib/ld-linux-aarch64.so.1' }
const loaderPresent =
  process.platform !== 'linux' || existsSync(GLIBC[process.arch as keyof typeof GLIBC] ?? '/')

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-handoff-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function exe(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

/** `@vzn/vx` at `pkg` (the launcher) with a platform binary that says `who`, and a `.bin/vx` beside it. */
function install(
  nodeModules: string,
  who: string,
  pkg = path.join(nodeModules, '@vzn', 'vx'),
): void {
  mkdirSync(pkg, { recursive: true })
  writeFileSync(path.join(pkg, 'launcher.sh'), readFileSync(LAUNCHER))
  chmodSync(path.join(pkg, 'launcher.sh'), 0o755)
  writeFileSync(path.join(pkg, 'launcher.cjs'), '')
  exe(path.join(pkg, '..', `vx-${KEY}`, 'vx'), `echo "${who} [\${VX_HANDED_OFF-}] $*"`)
  mkdirSync(path.join(nodeModules, '.bin'), { recursive: true })
  symlinkSync(
    path.relative(path.join(nodeModules, '.bin'), path.join(pkg, 'launcher.sh')),
    path.join(nodeModules, '.bin', 'vx'),
  )
}

describe.skipIf(!loaderPresent)('npm-launcher.sh hands off', () => {
  const tools = path.join(root, 'tools')
  mkdirSync(tools)
  for (const t of ['sh', 'readlink', 'uname']) symlinkSync(Bun.which(t)!, path.join(tools, t))
  exe(path.join(tools, 'node'), 'echo "node $*"; exit 3')
  // A global npm install: <prefix>/lib/node_modules/@vzn/vx, linked from <prefix>/bin/vx.
  const globalNm = path.join(root, 'prefix', 'lib', 'node_modules')
  install(globalNm, 'global')
  const globalVx = path.join(root, 'prefix', 'bin', 'vx')
  mkdirSync(path.dirname(globalVx))
  symlinkSync('../lib/node_modules/@vzn/vx/launcher.sh', globalVx)
  // What the launcher names itself: the path it resolved through the link.
  const globalLauncher = `${root}/prefix/bin/../lib/node_modules/@vzn/vx/launcher.sh`

  const run = (cwd: string, env: Record<string, string> = {}): string =>
    Bun.spawnSync({ cmd: [globalVx, 'run', 'a'], cwd, env: { PATH: tools, ...env } })
      .stdout.toString()
      .trim()

  it('to the first local install from cwd up, one hop, naming the global', () => {
    const repo = path.join(root, 'repo')
    mkdirSync(path.join(repo, '.git'), { recursive: true })
    install(path.join(repo, 'node_modules'), 'local')
    mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true })
    expect(run(path.join(repo, 'apps', 'web'))).toBe(`local [${globalLauncher}] run a`)
  })

  it('runs itself with no local install, and stops at the git root', () => {
    // An install above the git root belongs to another project.
    const outer = path.join(root, 'outer')
    install(path.join(outer, 'node_modules'), 'outer')
    const inner = path.join(outer, 'inner')
    mkdirSync(path.join(inner, '.git'), { recursive: true })
    expect(run(inner)).toBe('global [] run a')
    // CONTROL: without the .git the walk reaches it.
    const bare = path.join(outer, 'bare')
    mkdirSync(bare)
    expect(run(bare)).toBe(`outer [${globalLauncher}] run a`)
  })

  it('never to itself: the global install is the local one', () => {
    expect(run(path.join(root, 'prefix', 'lib'))).toBe('global [] run a')
  })

  it('a pnpm symlinked node_modules: the global hands off, the local runs itself', () => {
    const repo = path.join(root, 'pnpm-repo')
    mkdirSync(path.join(repo, '.git'), { recursive: true })
    const nm = path.join(repo, 'node_modules')
    const real = path.join(nm, '.pnpm', '@vzn+vx@1.0.0', 'node_modules', '@vzn', 'vx')
    install(nm, 'local', real)
    mkdirSync(path.join(nm, '@vzn'), { recursive: true })
    symlinkSync(path.relative(path.join(nm, '@vzn'), real), path.join(nm, '@vzn', 'vx'))
    expect(run(repo)).toBe(`local [${globalLauncher}] run a`)
    const own = Bun.spawnSync({
      cmd: [path.join(nm, '.bin', 'vx'), 'x'],
      cwd: repo,
      env: { PATH: tools },
    })
    expect(own.stdout.toString().trim()).toBe('local [] x')
  })

  it('once handed off, never again', () => {
    const repo = path.join(root, 'repo')
    expect(run(repo, { VX_HANDED_OFF: '/elsewhere/vx' })).toBe('global [/elsewhere/vx] run a')
  })
})

describe('the compiled binary hands off', () => {
  const tree = path.join(root, 'bin-tree')
  const standalone = path.join(root, 'standalone', 'vx')
  exe(standalone, 'echo standalone')
  const repo = path.join(tree, 'repo')
  mkdirSync(path.join(repo, '.git'), { recursive: true })
  mkdirSync(path.join(repo, 'node_modules', '@vzn', 'vx'), { recursive: true })
  writeFileSync(path.join(repo, 'node_modules', '@vzn', 'vx', 'package.json'), '{}')
  exe(path.join(repo, 'node_modules', '.bin', 'vx'), 'echo "local [$VX_HANDED_OFF] $*"; exit 7')
  mkdirSync(path.join(repo, 'src'))

  it('finds the local install from a subdirectory; none past the git root', async () => {
    expect(await localVx(path.join(repo, 'src'), standalone, true)).toBe(
      path.join(repo, 'node_modules', '.bin', 'vx'),
    )
    const nested = path.join(repo, 'vendor', 'other')
    mkdirSync(path.join(nested, '.git'), { recursive: true })
    writeFileSync(path.join(nested, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(await localVx(nested, standalone, true)).toBeNull()
  })

  it('never from source, from an npm install (its launcher walked), or to itself', async () => {
    expect(await localVx(repo, standalone, false)).toBeNull()
    expect(await localVx(repo, '/g/lib/node_modules/@vzn/vx-linux-x64/vx', true)).toBeNull()
    // The local .bin entry is this very binary.
    const self = path.join(tree, 'self')
    mkdirSync(path.join(self, 'node_modules', '@vzn', 'vx'), { recursive: true })
    writeFileSync(path.join(self, 'node_modules', '@vzn', 'vx', 'package.json'), '{}')
    mkdirSync(path.join(self, 'node_modules', '.bin'))
    symlinkSync(standalone, path.join(self, 'node_modules', '.bin', 'vx'))
    expect(await localVx(self, standalone, true)).toBeNull()
  })

  it('runs the local vx with the arguments and exits with its code, naming itself', () => {
    const p = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `const { handOff, localVx } = await import(${JSON.stringify(HANDOFF)}); await handOff(await localVx(process.cwd(), ${JSON.stringify(standalone)}, true), ['run', 'a b'])`,
      ],
      cwd: repo,
      env: { PATH: process.env['PATH'] ?? '' },
    })
    expect([p.exitCode, p.stdout.toString().trim()]).toEqual([
      7,
      `local [${process.execPath}] run a b`,
    ])
  })
})
