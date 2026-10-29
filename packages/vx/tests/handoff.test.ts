// A global vx hands every call to the project's own @vzn/vx
// (2026-10-13). Both halves: npm-launcher.sh's walk, driven against fake
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
import { localVx, upgradesOnlyItself } from '../src/handoff.js'

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
    mkdirSync(path.join(repo, '.vx'), { recursive: true })
    writeFileSync(path.join(repo, '.vx/workspace.ts'), '')
    install(path.join(repo, 'node_modules'), 'local')
    mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true })
    expect(run(path.join(repo, 'apps', 'web'))).toBe(`local [${globalLauncher}] run a`)
  })

  it('runs `vx upgrade -g` itself: it moves only the global (2026-10-16)', () => {
    const repo = path.join(root, 'repo')
    for (const argv of [
      ['upgrade', '-g'],
      ['upgrade', 'v1.2.3', '--global'],
    ]) {
      expect(
        Bun.spawnSync({ cmd: [globalVx, ...argv], cwd: repo, env: { PATH: tools } })
          .stdout.toString()
          .trim(),
      ).toBe(`global [] ${argv.join(' ')}`)
    }
  })

  it('runs itself with no workspace, and stops at the git root', () => {
    // A workspace above the git root belongs to another project.
    const outer = path.join(root, 'outer')
    install(path.join(outer, 'node_modules'), 'outer')
    mkdirSync(path.join(outer, '.vx'), { recursive: true })
    writeFileSync(path.join(outer, '.vx/workspace.mjs'), '')
    const inner = path.join(outer, 'inner')
    mkdirSync(path.join(inner, '.git'), { recursive: true })
    expect(run(inner)).toBe('global [] run a')
    // CONTROL: without the .git the walk reaches it.
    const bare = path.join(outer, 'bare')
    mkdirSync(bare)
    expect(run(bare)).toBe(`outer [${globalLauncher}] run a`)
  })

  it("from a submodule to the superproject's install; a worktree's .git file stops the walk", () => {
    const sup = path.join(root, 'super')
    mkdirSync(path.join(sup, '.git'), { recursive: true })
    mkdirSync(path.join(sup, '.vx'), { recursive: true })
    writeFileSync(path.join(sup, '.vx/workspace.ts'), '')
    install(path.join(sup, 'node_modules'), 'super')
    const sub = path.join(sup, 'mods', 'sub')
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/mods/sub\n')
    expect(run(sub)).toBe(`super [${globalLauncher}] run a`)
    const wt = path.join(sup, 'wt')
    mkdirSync(wt)
    writeFileSync(path.join(wt, '.git'), `gitdir: ${sup}/.git/worktrees/wt\n`)
    expect(run(wt)).toBe('global [] run a')
  })

  // A root-owned file stands in for another user's: only root can chown.
  it.skipIf(process.getuid?.() === 0)('never to a vx another user owns', () => {
    const planted = path.join(root, 'shared')
    mkdirSync(path.join(planted, 'node_modules', '@vzn', 'vx'), { recursive: true })
    mkdirSync(path.join(planted, 'node_modules', '.bin'))
    symlinkSync(Bun.which('echo')!, path.join(planted, 'node_modules', '.bin', 'vx'))
    mkdirSync(path.join(planted, '.vx'), { recursive: true })
    writeFileSync(path.join(planted, '.vx/workspace.ts'), '')
    mkdirSync(path.join(planted, 'mine'))
    expect(run(path.join(planted, 'mine'))).toBe('global [] run a')
  })

  it('never to itself: the global install is the local one', () => {
    mkdirSync(path.join(root, 'prefix', 'lib', '.vx'), { recursive: true })
    writeFileSync(path.join(root, 'prefix', 'lib', '.vx/workspace.ts'), '')
    expect(run(path.join(root, 'prefix', 'lib'))).toBe('global [] run a')
  })

  it('a pnpm symlinked node_modules: the global hands off, the local runs itself', () => {
    const repo = path.join(root, 'pnpm-repo')
    mkdirSync(path.join(repo, '.git'), { recursive: true })
    mkdirSync(path.join(repo, '.vx'), { recursive: true })
    writeFileSync(path.join(repo, '.vx/workspace.ts'), '')
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
  writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(path.join(repo, '.vx'), { recursive: true })
  writeFileSync(path.join(repo, '.vx/workspace.ts'), '')
  mkdirSync(path.join(repo, 'node_modules', '@vzn', 'vx'), { recursive: true })
  writeFileSync(path.join(repo, 'node_modules', '@vzn', 'vx', 'package.json'), '{}')
  exe(path.join(repo, 'node_modules', '.bin', 'vx'), 'echo "local [$VX_HANDED_OFF] $*"; exit 7')
  mkdirSync(path.join(repo, 'src'))

  it("finds the workspace root's install from a subdirectory; none past the git root", async () => {
    expect(await localVx(path.join(repo, 'src'), standalone, true)).toBe(
      path.join(repo, 'node_modules', '.bin', 'vx'),
    )
    const nested = path.join(repo, 'vendor', 'other')
    mkdirSync(path.join(nested, '.git'), { recursive: true })
    writeFileSync(path.join(nested, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(await localVx(nested, standalone, true)).toBeNull()
  })

  // The launcher's `[ -z "${VX_HANDED_OFF-}" ]` reads empty as unset; the
  // binary read it as handed off and stayed global.
  it('an empty VX_HANDED_OFF is no hand-off yet, as the launcher reads it', async () => {
    const was = process.env['VX_HANDED_OFF']
    try {
      process.env['VX_HANDED_OFF'] = ''
      expect(await localVx(repo, standalone, true)).toBe(
        path.join(repo, 'node_modules', '.bin', 'vx'),
      )
      // Control: a set one stops the hop.
      process.env['VX_HANDED_OFF'] = '/elsewhere/vx'
      expect(await localVx(repo, standalone, true)).toBeNull()
    } finally {
      if (was === undefined) delete process.env['VX_HANDED_OFF']
      else process.env['VX_HANDED_OFF'] = was
    }
  })

  it("from a submodule to the superproject's install", async () => {
    const sub = path.join(repo, 'mods', 'sub')
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/mods/sub\n')
    expect(await localVx(sub, standalone, true)).toBe(path.join(repo, 'node_modules', '.bin', 'vx'))
  })

  it('never from source, from an npm install (its launcher walked), or to itself', async () => {
    expect(await localVx(repo, standalone, false)).toBeNull()
    expect(await localVx(repo, '/g/lib/node_modules/@vzn/vx-linux-x64/vx', true)).toBeNull()
    // The local .bin entry is this very binary.
    const self = path.join(tree, 'self')
    mkdirSync(path.join(self, 'node_modules', '@vzn', 'vx'), { recursive: true })
    writeFileSync(path.join(self, 'node_modules', '@vzn', 'vx', 'package.json'), '{}')
    mkdirSync(path.join(self, 'node_modules', '.bin'))
    mkdirSync(path.join(self, '.vx'), { recursive: true })
    writeFileSync(path.join(self, '.vx/workspace.ts'), '')
    symlinkSync(standalone, path.join(self, 'node_modules', '.bin', 'vx'))
    expect(await localVx(self, standalone, true)).toBeNull()
  })

  it('never for `vx upgrade -g`, which moves only the global', () => {
    expect(
      [['upgrade', '-g'], ['upgrade', '--global', 'v1'], ['upgrade'], ['run', '-g'], []].map(
        upgradesOnlyItself,
      ),
    ).toEqual([true, true, false, false, false])
  })

  it('never to a vx another user owns', async () => {
    const other = (process.getuid?.() ?? 0) + 1
    expect(await localVx(path.join(repo, 'src'), standalone, true, other)).toBeNull()
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

  // Turbo #6724: a SIGTERM sent to the global vx alone (a process
  // manager, `kill`) must reach the local vx it handed off to.
  it('passes a SIGTERM sent to it alone on to the local vx', async () => {
    const bin = path.join(root, 'traps', 'vx')
    // Bounded: a broken hand-off leaves no shell looping after the test.
    exe(
      bin,
      "trap 'echo got-term; exit 0' TERM\necho ready\ni=0; while [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done",
    )
    const p = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `const { handOff } = await import(${JSON.stringify(HANDOFF)}); await handOff(${JSON.stringify(bin)}, [])`,
      ],
      env: { PATH: process.env['PATH'] ?? '' },
      stdout: 'pipe',
    })
    const reader = p.stdout.getReader()
    let out = ''
    while (!out.includes('ready\n')) {
      const { value, done } = await reader.read()
      if (done) break
      out += new TextDecoder().decode(value)
    }
    p.kill('SIGTERM')
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      out += new TextDecoder().decode(value)
    }
    expect([await p.exited, out]).toEqual([0, 'ready\ngot-term\n'])
  })

  // A shell running `vx run` in a script stops on Ctrl-C only when its
  // child DIED of SIGINT; handed off, vx exited 130 and the script ran
  // its next line (cli.md § Exit codes: vx dies of the signal).
  it('dies of the stop signal the local vx died of', () => {
    const bin = path.join(root, 'dies', 'vx')
    exe(bin, 'kill -s "$1" $$\nexit 9')
    const handed = (sig: string) =>
      Bun.spawnSync({
        cmd: [
          process.execPath,
          '-e',
          `const { handOff } = await import(${JSON.stringify(HANDOFF)}); await handOff(${JSON.stringify(bin)}, [${JSON.stringify(sig)}])`,
        ],
        env: { PATH: process.env['PATH'] ?? '' },
      })
    for (const sig of ['INT', 'TERM', 'HUP']) {
      const p = handed(sig)
      expect(`${p.exitCode} ${p.signalCode}`).toBe(`null SIG${sig}`)
    }
    // Any other signal keeps the shell's code.
    expect(handed('USR1').exitCode).toBe(128 + os.constants.signals.SIGUSR1)
  })
})
