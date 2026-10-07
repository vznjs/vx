// What a miss marks after it writes (miss-save.ts), end to end: a later
// task in the same run that reads the written files through
// `cache.inputs.workspaceFiles` must key them, or its entry is saved under
// a key that does not describe what it read. The cache-layer rows call the
// marks directly; these hold `saveMiss`'s calls (A-26).

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache, OUTPUT_DIRS_RACY_MS } from '../src/cache/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { waitForProducers } from './helpers/local-workspace.js'

const silent = new Proxy({}, { get: () => () => undefined }) as Logger
const TIMEOUT = 30_000
let root: string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-marks-' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function keyedFiles(task: string): string[] {
  const c = new Cache(path.join(root, '.vx/cache'))
  try {
    const rows = c
      .dbHandle()
      .query(
        "SELECT i.name FROM entry_inputs i JOIN entries e ON e.hash = i.entry_hash WHERE e.project = ? AND i.kind = 'file'",
      )
      .all(task) as Array<{ name: string }>
    return rows.map((r) => r.name).sort()
  } finally {
    c.close()
  }
}

async function genAndReader(genOutputs: string, genCommand: string, reads: string): Promise<void> {
  await addProject(root, 'gen', {
    files: { 'src/a.txt': 'a' },
    config: `export default { tasks: { build: {
      exec: { command: '${genCommand}' },
      cache: { inputs: { files: ['src/**'] }, outputs: ${genOutputs} },
    } } }`,
  })
  await addProject(root, 'rd', {
    files: { 'src/r.txt': 'r' },
    deps: { gen: '*' },
    config: `export default { tasks: { build: {
      dependsOn: ['^build'],
      exec: { command: 'true' },
      cache: { inputs: { files: [], workspaceFiles: ['${reads}'], tasks: [] }, outputs: { files: [] } },
    } } }`,
  })
}

describe('a miss marks what it wrote for the rest of the run', () => {
  it(
    'a workspace output is keyed by a same-run workspaceFiles reader',
    async () => {
      await genAndReader(
        `{ files: [], workspaceFiles: ['shared/**'] }`,
        'mkdir -p ../../shared && echo g > ../../shared/gen.txt',
        'shared/**',
      )
      await waitForProducers(root)
      expect((await run({ cwd: root, tasks: ['build'], log: silent })).ok).toBe(true)
      expect(keyedFiles('rd')).toEqual(['shared/gen.txt'])
    },
    TIMEOUT,
  )

  it(
    "a project output is keyed by a same-run workspaceFiles reader of that project's tree",
    async () => {
      await genAndReader(
        `{ files: ['dist/**'] }`,
        'mkdir -p dist && echo g > dist/x.txt',
        'packages/gen/dist/**',
      )
      await waitForProducers(root)
      expect((await run({ cwd: root, tasks: ['build'], log: silent })).ok).toBe(true)
      expect(keyedFiles('rd')).toEqual(['packages/gen/dist/x.txt'])
    },
    TIMEOUT,
  )

  // Each alone: the partition drop covers the workspace partition, the marks
  // cover each project's own snapshot, so a row per mark reaches past the
  // other (the three were a masking trio).
  it(
    "a workspace output landing in another project's dir is keyed by that project's reader",
    async () => {
      await addProject(root, 'gen', {
        files: { 'src/a.txt': 'a' },
        config: `export default { tasks: { build: {
          exec: { command: 'echo g > ../rd/gen.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['packages/rd/gen.txt'] } },
        } } }`,
      })
      await addProject(root, 'rd', {
        files: { 'src/r.txt': 'r' },
        deps: { gen: '*' },
        config: `export default { tasks: { build: {
          dependsOn: ['^build'],
          exec: { command: 'true' },
          cache: { inputs: { files: ['*.txt', 'src/**'], tasks: [] }, outputs: { files: [] } },
        } } }`,
      })
      expect((await run({ cwd: root, tasks: ['build'], log: silent })).ok).toBe(true)
      expect(keyedFiles('rd')).toEqual(['packages/rd/gen.txt', 'packages/rd/src/r.txt'])
    },
    TIMEOUT,
  )

  it(
    "an undeclared write in the saving task's project is keyed by a workspace reader of that tree",
    async () => {
      await genAndReader(
        `{ files: ['dist/**'] }`,
        'mkdir -p dist notes && echo g > dist/x.txt && echo n > notes/y.txt',
        'packages/gen/notes/**',
      )
      expect((await run({ cwd: root, tasks: ['build'], log: silent })).ok).toBe(true)
      expect(keyedFiles('rd')).toEqual(['packages/gen/notes/y.txt'])
    },
    TIMEOUT,
  )
})

it(
  'the run-end snapshot of a task with workspace outputs too counts only its project rows',
  async () => {
    await addProject(root, 'gen', {
      files: { 'src/a.txt': 'a' },
      config: `export default { tasks: {
        build: {
          exec: { command: 'mkdir -p dist ../../shared && echo p > dist/p.txt && echo w > ../../shared/w.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'], workspaceFiles: ['shared/**'] } },
        },
        tail: { dependsOn: ['build'], exec: { command: 'sleep ${(OUTPUT_DIRS_RACY_MS * 3) / 1000}' } },
      } }`,
    })
    expect((await run({ cwd: root, tasks: ['tail'], log: silent })).ok).toBe(true)
    const c = new Cache(path.join(root, '.vx/cache'))
    try {
      const { hash } = c
        .dbHandle()
        .query("SELECT hash FROM entries WHERE task = 'build'")
        .get() as {
        hash: string
      }
      expect((c.loadOutputDirsBatch([hash]).get(hash) ?? []).map((r) => r.path)).toEqual(['dist'])
    } finally {
      c.close()
    }
  },
  TIMEOUT,
)
