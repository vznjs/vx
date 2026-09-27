// A sandboxed task with no write grant writes into the sandbox's scratch,
// never the disk, and may still exit 0: the empty-outputs warning names
// that cause (miss-save.ts). Unsafe: it runs a sandbox, which cannot nest
// inside a sandboxed shard (A-24).

import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox empty-outputs test')

describe.skipIf(!available)('the empty-outputs warning for a sandboxed task', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-sb-empty-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const warnings = async (write: string): Promise<string[]> => {
    await addProject(root, 'app', {
      files: { 'src/a.txt': 'a' },
      config: `export default { tasks: { build: {
        exec: { command: 'true', sandbox: { allow: { read: ['.']${write} } } },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['build/**'] } },
      } } }`,
    })
    const lines: string[] = []
    const log = new Proxy(
      {},
      { get: (_, k) => (k === 'status' ? (l: string) => lines.push(l) : () => undefined) },
    ) as Logger
    expect((await run({ cwd: root, tasks: ['build'], log, handleSignals: false })).ok).toBe(true)
    return lines.filter((l) => l.includes('matched no files'))
  }

  it('with no write grant, the warning says its writes never reached disk', async () => {
    expect(await warnings('')).toEqual([
      '[vx] app#build: cache.outputs matched no files (build/**) — an empty artifact is saved; a later hit restores nothing — the task is sandboxed and declares no exec.sandbox.allow.write, so its writes never reached disk',
    ])
  })

  it('control: with a write grant, the plain warning', async () => {
    expect(await warnings(", write: ['build']")).toEqual([
      '[vx] app#build: cache.outputs matched no files (build/**) — an empty artifact is saved; a later hit restores nothing',
    ])
  })
})
