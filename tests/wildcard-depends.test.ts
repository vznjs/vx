// e2e for dependsOn task-name patterns (`build.*` / `^build.*`). Spawns the
// real CLI: the graph expansion + scheduling + the group-transparency path
// only compose across a real invocation.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'

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

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-wildcard-e2e-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
  await mkdir(path.join(root, 'packages'), { recursive: true })
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 't@vx.local')
  git(root, 'config', 'user.name', 'vx')
  return root
}

async function addProject(
  root: string,
  name: string,
  config: string,
  deps: Record<string, string> = {},
): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', dependencies: deps }),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
}

async function vx(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
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

let root: string
beforeEach(async () => {
  root = await makeWorkspace()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('dependsOn patterns e2e', () => {
  it("a 'lint.*' group runs every matching sibling through the real CLI", async () => {
    await addProject(
      root,
      'app',
      `export default {
        tasks: {
          lint: { dependsOn: ['lint.*'] },
          'lint.a': { exec: { command: "echo LINT-A > a.txt" } },
          'lint.b': { exec: { command: "echo LINT-B > b.txt" } },
          build: { exec: { command: "echo BUILD > build.txt" } },
        },
      }
      `,
    )
    const r = await vx(root, ['run', 'app#lint'])
    expect(r.code).toBe(0)
    const dir = path.join(root, 'packages', 'app')
    expect(await Bun.file(path.join(dir, 'a.txt')).text()).toContain('LINT-A')
    expect(await Bun.file(path.join(dir, 'b.txt')).text()).toContain('LINT-B')
    // The non-matching sibling never ran.
    expect(await Bun.file(path.join(dir, 'build.txt')).exists()).toBe(false)
  })

  it("'^build.*' orders after every matching task of the dependency", async () => {
    await addProject(
      root,
      'lib',
      `export default {
        tasks: {
          'build.js': { exec: { command: "echo JS > js.txt" } },
          'build.dts': { exec: { command: "echo DTS > dts.txt" } },
        },
      }
      `,
    )
    await addProject(
      root,
      'app',
      `export default {
        tasks: {
          test: {
            dependsOn: ['^build.*'],
            exec: { command: "cat ../lib/js.txt ../lib/dts.txt > seen.txt" },
          },
        },
      }
      `,
      { lib: 'workspace:*' },
    )
    const r = await vx(root, ['run', 'app#test'])
    expect(r.code).toBe(0)
    // test ran AFTER both lib builds — their outputs were readable.
    const seen = await Bun.file(path.join(root, 'packages', 'app', 'seen.txt')).text()
    expect(seen).toContain('JS')
    expect(seen).toContain('DTS')
  })

  it("cache.inputs.tasks: ['build.*'] COUPLES the dependent — upstream change re-runs it", async () => {
    // The stale-hit trap the adversarial review found: dependsOn expands the
    // pattern but a literal-matching filter would select ZERO upstream hashes,
    // so the dependent cache-hit stale bytes after the upstream changed. Both
    // surfaces must share the matcher.
    const config = `export default {
        tasks: {
          'build.x': {
            exec: { command: "cp src.txt out.txt" },
            cache: { inputs: { files: ['src.txt'] }, outputs: { files: ['out.txt'] } },
          },
          top: {
            dependsOn: ['build.*'],
            exec: { command: "cp out.txt final.txt" },
            cache: {
              inputs: { files: ['top-src.txt'], tasks: ['build.*'] },
              outputs: { files: ['final.txt'] },
            },
          },
        },
      }
      `
    await addProject(root, 'app', config)
    const dir = path.join(root, 'packages', 'app')
    await writeFile(path.join(dir, 'src.txt'), 'v1')
    await writeFile(path.join(dir, 'top-src.txt'), 'const')
    git(root, 'add', '-A')

    expect((await vx(root, ['run', 'app#top'])).code).toBe(0)
    expect(await Bun.file(path.join(dir, 'final.txt')).text()).toBe('v1')

    // Change ONLY the upstream's input; the pattern filter must carry the
    // upstream's new hash into top's key → top re-runs and sees v2.
    await writeFile(path.join(dir, 'src.txt'), 'v2-CHANGED')
    expect((await vx(root, ['run', 'app#top'])).code).toBe(0)
    expect(await Bun.file(path.join(dir, 'final.txt')).text()).toBe('v2-CHANGED')
  })

  it('a bare wildcard in dependsOn still fails loud', async () => {
    await addProject(
      root,
      'app',
      `export default {
        tasks: { build: { dependsOn: ['*'], exec: { command: 'echo x' } } },
      }
      `,
    )
    const r = await vx(root, ['run', 'app#build'])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('bare wildcards')
  })
})
