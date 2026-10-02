// A scoped run enumerates git over the projects that own a task, not the
// dependency closure it loads for the `^` walk: a `lint` of one package
// walked the whole 1,000-project tree for it (~60 ms of git where the one
// project's pathspec takes ~7).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { prepareRun } from '../src/orchestrator/index.js'
import { gitInit } from './helpers/workspace.js'

const TIMEOUT = 30_000

const log: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-scoped-git-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
  const pkg = async (name: string, deps: Record<string, string>, config: string) => {
    const dir = path.join(root, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, dependencies: deps }))
    await writeFile(path.join(dir, 'src', 'index.js'), `export const name = '${name}'\n`)
    await writeFile(path.join(dir, 'vx.config.mjs'), config)
  }
  const build = `build: {
      dependsOn: ['^build'],
      exec: { command: 'true' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },`
  await pkg('lib', {}, `export default { tasks: { ${build} } }\n`)
  await pkg(
    'app',
    { lib: 'workspace:*' },
    `export default {
  tasks: {
    ${build}
    lint: {
      exec: { command: 'true' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
  },
}
`,
  )
  gitInit(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The project dirs the run's git enumeration partitioned, as names. */
async function partitioned(task: string): Promise<{ nodes: string[]; dirs: string[] }> {
  const p = await prepareRun({ cwd: root, tasks: [task], projects: ['app'], concurrency: 1 }, log)
  try {
    return {
      nodes: [...p.nodes.keys()].sort(),
      dirs: [...p.gitFilesCache.keys()].map((d) => path.basename(d)).sort(),
    }
  } finally {
    p.cache.close()
  }
}

describe("a scoped run's git enumeration", () => {
  it(
    'covers the projects that own a task, not the closure the scope loaded',
    async () => {
      expect(await partitioned('lint')).toEqual({ nodes: ['app#lint'], dirs: ['app'] })
    },
    TIMEOUT,
  )

  it(
    'CONTROL: a `^` task keys its dependency, which is partitioned too',
    async () => {
      expect(await partitioned('build')).toEqual({
        nodes: ['app#build', 'lib#build'],
        dirs: ['app', 'lib'],
      })
    },
    TIMEOUT,
  )
})
