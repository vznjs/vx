// What item 808's mutation sweep found unheld in server.ts and tools.ts:
// each row fails with one line of src/ undone.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Cache, type RunRecord } from '@vzn/vx'
import { handleMessage, serve } from '../src/server.js'
import { handleToolCall } from '../src/tools.js'

let root: string
let ctx: { cacheDir: string; workspaceRoot: string }

async function pkg(name: string, config: string): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
}

const run = (over: Partial<RunRecord> & { task: string; runId: string }): RunRecord => ({
  hash: 'h',
  project: 'a',
  status: 'failed',
  exitCode: 1,
  durationMs: 10,
  forwardArgs: [],
  startedAt: Date.now() - 1000,
  endedAt: Date.now() - 900,
  cpuMs: 1,
  peakRssBytes: 0,
  cacheHit: false,
  ...over,
})

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-sweep-'))
  ctx = { cacheDir: path.join(root, '.vx', 'cache'), workspaceRoot: root }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await pkg(
    'a',
    `export default { tasks: {
      build: { description: 'compile', exec: { command: 'tsc' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } },
      dev: { exec: { command: 'vite', persistent: { readyWhen: 'ready' } } },
      all: { dependsOn: ['build'] },
    } }\n`,
  )
  await pkg('b', "export default { tasks: { build: { exec: { command: 'echo b' } } } }\n")
  const cache = new Cache(ctx.cacheDir)
  try {
    cache.recordRuns([
      run({ task: 'skipped', runId: 'r1', status: 'skipped', exitCode: 0, blockedBy: 'a#build' }),
      run({ task: 'slow', runId: 'r1', exitCode: 143, timedOut: true }),
      run({ task: 'boxed', runId: 'r1', sandboxViolations: 2 }),
    ])
    const entry = cache.dbHandle().query(
      `INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, stdout, created_at, accessed_at)
         VALUES (?, 'a', 'build', ?, 0, 1, 1, '', ?, ?)`,
    )
    entry.run('old', 'tsc --old', 1_000, 1_000)
    entry.run('new', 'tsc', 2_000, 2_000)
  } finally {
    cache.close()
  }
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('listTasks, exactly', () => {
  it('a project narrows the answer to that project, every field as resolved', async () => {
    expect(await handleToolCall('listTasks', { project: 'a' }, ctx)).toEqual({
      projects: [
        {
          name: 'a',
          dir: path.join(root, 'packages', 'a'),
          tasks: [
            {
              name: 'build',
              id: 'a#build',
              description: 'compile',
              command: 'tsc',
              dependsOn: [],
              cached: true,
            },
            {
              name: 'dev',
              id: 'a#dev',
              command: 'vite',
              dependsOn: [],
              cached: false,
              persistent: true,
            },
            { name: 'all', id: 'a#all', command: null, dependsOn: ['build'], cached: false },
          ],
        },
      ],
    })
  })

  it('an empty project name is refused, not read as "every project"', async () => {
    await expect(handleToolCall('listTasks', { project: '' }, ctx)).rejects.toThrow(
      'listTasks: project must be a non-empty string',
    )
  })
})

describe('getRunHistory and explainCacheKey, what they read', () => {
  it('a run row carries its blocker, its timeout and its violation count', async () => {
    const got = (await handleToolCall('getRunHistory', { project: 'a' }, ctx)) as {
      runs: Array<Record<string, unknown>>
    }
    const byTask = new Map(got.runs.map((r) => [r['task'], r]))
    expect([
      byTask.get('skipped')!['blockedBy'],
      byTask.get('slow')!['timedOut'],
      byTask.get('boxed')!['sandboxViolations'],
    ]).toEqual(['a#build', true, 2])
  })

  it('the latest of a task’s entries is the one explained', async () => {
    const got = (await handleToolCall('explainCacheKey', { taskId: 'a#build' }, ctx)) as {
      latestEntry: { hash: string; command: string }
    }
    expect([got.latestEntry.hash, got.latestEntry.command]).toEqual(['new', 'tsc'])
  })
})

describe('the server, exactly', () => {
  it('initialize names the server and says what it is', async () => {
    const r = (await handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      ctx,
    )) as { result: { instructions: string } }
    expect(r.result.instructions).toBe(
      'Read-only view of this workspace’s vx cache and run history. Nothing here runs a task.',
    )
  })

  it('a tool result is the JSON, indented two spaces', async () => {
    const r = (await handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'explainCacheKey', arguments: { taskId: 'a#build' } },
      }),
      ctx,
    )) as { result: { content: Array<{ text: string }> } }
    const text = r.result.content[0]!.text
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2))
    expect(text).toContain('\n  "taskId": "a#build"')
  })

  it('a tool that fails for its own reasons is -32603 carrying the reason', async () => {
    // A cache.db that is not a database: SQLite's own error, not a
    // UserError, and the agent is told it rather than a bare "internal error".
    const broken = path.join(root, 'broken-cache')
    await mkdir(broken, { recursive: true })
    await writeFile(path.join(broken, 'cache.db'), 'not a sqlite database at all. '.repeat(100))
    const r = (await handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'getCacheStats', arguments: {} },
      }),
      { cacheDir: broken, workspaceRoot: root },
    )) as { error: { code: number; message: string } }
    expect(r.error).toEqual({ code: -32603, message: 'file is not a database' })
  })

  it('a blank or whitespace-only line is no message and gets no reply', async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode(
        `\n   \n\t\n${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })}\n`,
      )
    }
    const lines: string[] = []
    await serve(chunks(), (l) => lines.push(l), ctx)
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { jsonrpc: '2.0', id: 4, result: {} },
    ])
  })
})
