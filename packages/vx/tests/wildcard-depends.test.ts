// e2e for dependsOn task-name patterns (`build.*` / `^build.*`). Spawns the
// real CLI: the graph expansion + scheduling + the group-transparency path
// only compose across a real invocation.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { writeEdges } from './helpers/plugin.js'
import {
  addProject as addProjectTo,
  gitIn,
  makeWorkspace as makeWorkspaceRoot,
} from './helpers/workspace.js'

setDefaultTimeout(30_000)

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

function makeWorkspace(): Promise<string> {
  return makeWorkspaceRoot({ prefix: 'vx-wildcard-e2e-', rootName: 'root' })
}

let edges: Record<string, string[]> = {}

async function addProject(
  root: string,
  name: string,
  config: string,
  deps: readonly string[] = [],
): Promise<void> {
  await addProjectTo(root, name, { config })
  edges[name] = [...deps]
  await writeEdges(root, edges)
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
  edges = {}
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
      ['lib'],
    )
    const r = await vx(root, ['run', 'app#test'])
    expect(r.code).toBe(0)
    // test ran AFTER both lib builds — their outputs were readable.
    const seen = await Bun.file(path.join(root, 'packages', 'app', 'seen.txt')).text()
    expect(seen).toContain('JS')
    expect(seen).toContain('DTS')
  })

  it("inputs.tasks: ['build.*'] COUPLES the dependent — upstream change re-runs it", async () => {
    // The stale-hit trap the adversarial review found: dependsOn expands the
    // pattern but a literal-matching filter would select ZERO upstream hashes,
    // so the dependent cache-hit stale bytes after the upstream changed. Both
    // surfaces must share the matcher.
    const config = `export default {
        tasks: {
          'build.x': {
            exec: { command: "cp src.txt out.txt" },
            inputs: { files: ['src.txt'] }, cache: { outputs: { files: ['out.txt'] } },
          },
          top: {
            dependsOn: ['build.*'],
            exec: { command: "cp out.txt final.txt" },
            inputs: { files: ['top-src.txt'], tasks: ['build.*'] },
            cache: {
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
    gitIn(root)('add', '-A')

    expect((await vx(root, ['run', 'app#top'])).code).toBe(0)
    expect(await Bun.file(path.join(dir, 'final.txt')).text()).toBe('v1')

    // Change ONLY the upstream's input; the pattern filter must carry the
    // upstream's new hash into top's key → top re-runs and sees v2.
    await writeFile(path.join(dir, 'src.txt'), 'v2-CHANGED')
    expect((await vx(root, ['run', 'app#top'])).code).toBe(0)
    expect(await Bun.file(path.join(dir, 'final.txt')).text()).toBe('v2-CHANGED')
  })

  it("inputs.tasks: ['acme-*#build'] COUPLES the dependent across projects", async () => {
    // Same trap as the sibling test above, in the PROJECT half of `pkg#task`:
    // matched literally it selected ZERO upstream hashes, so app cache-hit
    // stale bytes after its dependency changed.
    await addProject(
      root,
      'acme-core',
      `export default {
        tasks: {
          build: {
            exec: { command: 'cp src.txt out.txt' },
            inputs: { files: ['src.txt'] }, cache: { outputs: { files: ['out.txt'] } },
          },
        },
      }
      `,
    )
    await addProject(
      root,
      'app',
      `export default {
        tasks: {
          build: {
            dependsOn: ['^build'],
            exec: { command: 'echo ran >> ran.log && cp src.txt out.txt' },
            inputs: { files: ['src.txt'], tasks: ['acme-*#build'] },
            cache: {
              outputs: { files: ['out.txt'] },
            },
          },
        },
      }
      `,
      ['acme-core'],
    )
    const core = path.join(root, 'packages', 'acme-core')
    const app = path.join(root, 'packages', 'app')
    await writeFile(path.join(core, 'src.txt'), 'v1')
    await writeFile(path.join(app, 'src.txt'), 'const')
    gitIn(root)('add', '-A')

    expect((await vx(root, ['run', 'app#build'])).code).toBe(0)
    expect((await Bun.file(path.join(app, 'ran.log')).text()).trim().split('\n')).toHaveLength(1)

    // Change ONLY the dependency's input; the pattern filter must carry its
    // new hash into app's key → app re-runs instead of hitting stale bytes.
    await writeFile(path.join(core, 'src.txt'), 'v2-CHANGED')
    expect((await vx(root, ['run', 'app#build'])).code).toBe(0)
    expect((await Bun.file(path.join(app, 'ran.log')).text()).trim().split('\n')).toHaveLength(2)
  })

  // `**` matches every name as `*` does, so it is the same bare wildcard,
  // not a namespace pattern that adds every other task.
  for (const dep of ['*', '^*', '**', '^**']) {
    it(`a bare wildcard ${JSON.stringify(dep)} in dependsOn still fails loud`, async () => {
      await addProject(
        root,
        'app',
        `export default {
          tasks: {
            build: { dependsOn: ['${dep}'], exec: { command: 'echo x' } },
            other: { exec: { command: 'echo y' } },
          },
        }
        `,
      )
      const r = await vx(root, ['run', 'app#build'])
      expect(r.code).not.toBe(0)
      expect(r.err).toContain(`dependsOn does not accept bare wildcards (got "${dep}")`)
    })
  }
})
