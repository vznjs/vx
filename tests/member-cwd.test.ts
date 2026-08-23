// e2e for the DOCUMENTED default invocation mode: `vx run <task>` from inside
// a package directory. Discovery must resolve the declaring workspace root,
// not the member — otherwise `^task` edges vanish, the cache key loses its
// upstream fold (stale hits) and a second cache dir appears under the member.
// Only a real invocation composes discovery + graph + hashing + cache.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

setDefaultTimeout(30_000)

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(p.stderr)}`)
}

async function vx(cwd: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

// stat, not Bun.file().exists() — the latter is false for directories.
async function exists(p: string): Promise<boolean> {
  return await stat(p).then(
    () => true,
    () => false,
  )
}

describe('running from inside a workspace member', () => {
  let root: string
  let a: string
  let b: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-member-cwd-'))
    a = path.join(root, 'packages', 'a')
    b = path.join(root, 'packages', 'b')
    await mkdir(path.join(a, 'src'), { recursive: true })
    await mkdir(path.join(b, 'src'), { recursive: true })

    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    )
    await writeLocalWorkspace(root)
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n.vx\nout\nran.log\n')

    await writeFile(path.join(b, 'package.json'), JSON.stringify({ name: 'b', version: '1.0.0' }))
    await writeFile(
      path.join(b, 'vx.config.mjs'),
      `export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p out && cp src/in.txt out/o.txt' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } },
          },
        },
      }
      `,
    )
    await writeFile(path.join(b, 'src', 'in.txt'), 'v1')

    await writeFile(
      path.join(a, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { b: '1.0.0' } }),
    )
    await writeFile(
      path.join(a, 'vx.config.mjs'),
      `export default {
        tasks: {
          build: {
            dependsOn: ['^build'],
            exec: { command: 'echo ran >> ran.log && mkdir -p out && cp src/in.txt out/o.txt' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } },
          },
        },
      }
      `,
    )
    await writeFile(path.join(a, 'src', 'in.txt'), 'v1')

    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 't@vx.local')
    git(root, 'config', 'user.name', 'vx')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'init')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('pulls in the `^build` upstream and caches at the workspace root', async () => {
    const r = await vx(a, ['run', 'build'])
    expect(r.code).toBe(0)
    // b#build is only in the graph if discovery found the declaring root: the
    // member-as-workspace reading has no sibling to resolve `^build` against.
    expect(await exists(path.join(b, 'out', 'o.txt'))).toBe(true)
    expect(await exists(path.join(root, '.vx'))).toBe(true)
    expect(await exists(path.join(a, '.vx'))).toBe(false)
  })

  it('re-runs the dependent when the upstream input changes', async () => {
    expect((await vx(a, ['run', 'build'])).code).toBe(0)
    expect((await readFile(path.join(a, 'ran.log'), 'utf8')).trim().split('\n')).toHaveLength(1)

    // Change ONLY the upstream's input. Its key changes, folds into a#build's
    // key, and a#build must execute again — a stale hit here would serve
    // outputs built against an input that no longer exists.
    await writeFile(path.join(b, 'src', 'in.txt'), 'v2-CHANGED')
    expect((await vx(a, ['run', 'build'])).code).toBe(0)
    expect((await readFile(path.join(a, 'ran.log'), 'utf8')).trim().split('\n')).toHaveLength(2)
  })
})
