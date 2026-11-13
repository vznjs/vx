// The published vx is a compiled binary, and SRT's Linux seccomp helper
// (`apply-seccomp`) is a file SRT looks for beside its own, then under
// `npm root -g`. The binary bundles SRT's JS without its `vendor/`, so
// 0.0.655 found no helper: no write observer and no AF_UNIX block. A
// refused write was reported by nothing (`tsc`: "EROFS … mkdir dist", no
// word of the sandbox, no fix), and every sandboxed run spawned npm to
// ask. Source runs found the vendored file, so no test saw it.

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { applySeccompPath } from '../src/sandbox/seccomp-helper.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('compiled sandbox test')
const pkg = path.resolve(import.meta.dir, '..')

describe.skipIf(!available || process.platform !== 'linux')('a compiled vx', () => {
  let tmp = ''
  let bin = ''
  let root = ''
  const env = (): Record<string, string> => ({
    PATH: process.env['PATH'] ?? '',
    HOME: path.join(tmp, 'home'),
    XDG_CACHE_HOME: path.join(tmp, 'xdg'),
    NO_COLOR: '1',
    // A compiled vx hands off to the workspace's own install.
    VX_HANDED_OFF: '1',
  })
  const vx = (...args: string[]): { code: number; out: string } => {
    const p = Bun.spawnSync({ cmd: [bin, ...args], cwd: root, env: env() })
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
  }

  beforeAll(async () => {
    tmp = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-compiled-sb-')))
    bin = path.join(tmp, 'vx')
    const built = Bun.spawnSync({
      cmd: [process.execPath, 'build', '--compile', 'src/bin.ts', '--outfile', bin],
      cwd: pkg,
      stderr: 'pipe',
    })
    if (built.exitCode !== 0) throw new Error(built.stderr.toString())
    root = realpathSync(await makeWorkspace({ prefix: 'vx-compiled-sb-ws-' }))
    await addProject(root, 'app', {
      files: { 'src/a.txt': 'a' },
      config: `export default { tasks: {
        leak: { exec: { command: 'echo x > out.txt', sandbox: { allow: { read: ['.'] } } } },
        quiet: { exec: { command: '{ echo x > out.txt; } 2>/dev/null; true', sandbox: { allow: { read: ['.'] } } } },
      } }\n`,
    })
    await gitInitCommit(root)
    const locked = vx('lock')
    if (locked.code !== 0) throw new Error(locked.out)
  }, 120_000)
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  it('names a refused write and its grant', () => {
    const r = vx('run', 'leak', '--all')
    expect(r.code).toBe(1)
    expect(r.out).toContain(`openat(${root}/packages/app/out.txt) = a write no grant covers`)
    expect(r.out).toContain('fix: exec.sandbox.allow: { write:')
  }, 60_000)

  it('fails a task that swallowed its refused write', () => {
    const r = vx('run', 'quiet', '--all')
    expect(r.out).toContain('a write no grant covers')
    expect(r.code).toBe(1)
  }, 60_000)

  it('copies the helper out once, as this user’s own file', () => {
    const dir = path.join(tmp, 'xdg', 'vx', 'helpers')
    const [name, ...rest] = readdirSync(dir)
    expect(rest).toEqual([])
    const file = path.join(dir, name!)
    const st = statSync(file)
    expect([st.mode & 0o777, statSync(dir).mode & 0o777]).toEqual([0o755, 0o700])
    vx('run', 'leak', '--all')
    expect(statSync(file).mtimeMs).toBe(st.mtimeMs)
  }, 60_000)
})

it.skipIf(process.platform !== 'linux')(
  'from source the helper is SRT’s vendored file',
  async () => {
    const p = await applySeccompPath()
    expect(p).toMatch(/sandbox-runtime\/vendor\/seccomp\/(x64|arm64)\/apply-seccomp$/)
    expect(existsSync(p!)).toBe(true)
  },
)
