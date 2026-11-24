// A sandboxed task with no write grant writes into the sandbox's scratch,
// never the disk, and may still exit 0: the missing-output failure names
// that cause (attempt-outputs.ts `missingOutputs`). Unsafe: it runs a sandbox, which cannot nest
// inside a sandboxed shard (A-24).

import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import type { Logger } from '../src/report/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox empty-outputs test')

describe.skipIf(!available)('the missing-output failure of a sandboxed task', () => {
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
        inputs: { files: ['src/**'] }, outputs: { files: ['build/**'] }, cache: true,
      } } }`,
    })
    const lines: string[] = []
    const log = new Proxy(
      {},
      {
        get: (_, k) => (k === 'warn' ? (l: string) => lines.push(l.trim()) : () => undefined),
      },
    ) as Logger
    expect((await run({ cwd: root, tasks: ['build'], log, handleSignals: false })).ok).toBe(false)
    return lines.filter((l) => l.includes('matched no files'))
  }

  it('with no write grant, the line says its writes never reached disk', async () => {
    expect(await warnings('')).toEqual([
      '[vx] app#build: outputs matched no files (build/**) — the command exited 0 but never wrote it, so the task fails and nothing is cached: write it, or fix the pattern — the task is sandboxed and declares no exec.sandbox.allow.write, so its writes never reached disk',
    ])
  })

  it('control: with a write grant, the unsandboxed line', async () => {
    expect(await warnings(", write: ['build']")).toEqual([
      '[vx] app#build: outputs matched no files (build/**) — the command exited 0 but never wrote it, so the task fails and nothing is cached: write it, or fix the pattern — it wrote none of its outputs: one written only sometimes (test coverage, written only with coverage on) cannot be declared, so drop it from outputs or run the command so it writes it',
    ])
  })
})
