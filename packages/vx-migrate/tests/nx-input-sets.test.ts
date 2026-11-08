// Nx hashes a target's `{projectRoot}` filesets and its `{workspaceRoot}`
// ones as separate sets, each `!` acting only inside its own. The mapper
// folded a `{workspaceRoot}` path under the project into the project's
// `files`, where core subtracts every `!` from every entry: production's
// `!{projectRoot}/jest.config.[jt]s` took out the target's own
// `{workspaceRoot}/libs/a/jest.config.ts`, and an edit to it replayed the
// old output where Nx re-ran (stale hit).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-input-sets-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const named = {
  default: ['{projectRoot}/**/*'],
  production: ['default', '!{projectRoot}/jest.config.[jt]s'],
}

async function meta(name: string, rel: string): Promise<PackageMeta> {
  const dir = path.join(root, rel)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  return { name, dir, packageJson: { name } as never, configPath: null }
}

async function inputsOf(inputs: unknown[]): Promise<unknown> {
  const a = await meta('a', 'libs/a')
  const targets = {
    build: { command: 'tsc', cache: true, inputs, outputs: ['{projectRoot}/dist'] },
  }
  const g = {
    nodes: { a: { name: 'a', data: { root: 'libs/a', targets, namedInputs: named } } },
    dependencies: {},
  } as NxGraph
  const m = await mapNxWorkspace(root, [a], g, { cacheable: new Set() })
  return m.projects[0]!.tasks.find((t) => t.name === 'build')!.task!['inputs']
}

it("a project set's `!` keeps a `{workspaceRoot}` path into the project", async () => {
  const inputs = (await inputsOf(['production', '{workspaceRoot}/libs/a/jest.config.ts'])) as {
    files: string[]
  }
  expect(inputs.files).toContain('**/*')
  expect(inputs.files).toContain('jest.config.ts')
  expect(inputs.files).not.toContain('!jest.config.[jt]s')
})

it("a workspace set's `!` keeps the project set's files", async () => {
  expect(await inputsOf(['{projectRoot}/**/*', '!{workspaceRoot}/libs/a/x.ts'])).toEqual({
    files: ['**/*'],
  })
})

it('a `!` still acts inside its own set', async () => {
  expect(await inputsOf(['production'])).toEqual({ files: ['**/*', '!jest.config.[jt]s'] })
})

// A node vx does not run is walked through: its files join the reader's
// `workspaceFiles`, its project set beside the workspace sets.
async function walkedThrough(appInputs: unknown[], prod: unknown[]): Promise<string[]> {
  const app = await meta('app', 'apps/app')
  await mkdir(path.join(root, 'libs', 't'), { recursive: true })
  const g = {
    nodes: {
      app: {
        name: 'app',
        data: {
          root: 'apps/app',
          targets: { build: { command: 'b', cache: true, inputs: appInputs } },
        },
      },
      t: { name: 't', data: { root: 'libs/t', namedInputs: { prod } } },
    },
    dependencies: { app: [{ target: 't' }] },
  } as unknown as NxGraph
  const m = await mapNxWorkspace(root, [app], g, { cacheable: new Set() })
  const build = m.projects[0]!.tasks.find((t) => t.name === 'build')!
  return (build.task!['inputs'] as { workspaceFiles: string[] }).workspaceFiles
}

it("a walked-through node's project `!` keeps a workspace set's files", async () => {
  const own = ['{projectRoot}/**/*', '!{projectRoot}/x.ts']
  for (const ws of [
    await walkedThrough(['^prod'], [...own, '{workspaceRoot}/libs/t/x.ts']),
    await walkedThrough(['^prod'], [...own, '{workspaceRoot}/libs/**/*.ts']),
    await walkedThrough(['^prod', '{workspaceRoot}/libs/**/*.ts'], own),
  ]) {
    expect(ws).toContain('libs/t/**/*')
    expect(ws).not.toContain('!libs/t/x.ts')
  }
})
