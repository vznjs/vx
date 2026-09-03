// The stdio JSON-RPC surface: `handleMessage` in-process for the protocol
// shapes, and the real thing — `vx mcp` from the core entry point, in a
// workspace that declares the plugin — driven over stdin/stdout the way an
// agent drives it.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Cache, VERSION } from '@vzn/vx'
import { handleMessage, PROTOCOL_VERSION, serve } from '../src/server.js'

const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
const PLUGIN_ENTRY = path.resolve(import.meta.dir, '../src/index.ts')
const LOCAL_EXECUTOR = path.resolve(import.meta.dir, '../../vx/src/plugins/local-executor/index.ts')
const LOCAL_CACHE = path.resolve(import.meta.dir, '../../vx/src/plugins/local-cache/index.ts')

let root: string
let ctx: { cacheDir: string; workspaceRoot: string }

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-server-'))
  ctx = { cacheDir: path.join(root, '.vx', 'cache'), workspaceRoot: root }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await mkdir(path.join(root, 'packages', 'a', 'src'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(path.join(root, 'packages', 'a', 'src', 'x.js'), 'x')
  await writeFile(
    path.join(root, 'packages', 'a', 'vx.config.mjs'),
    "export default { tasks: { build: { exec: { command: 'echo built' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n",
  )
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { localExecutorPlugin } from ${JSON.stringify(LOCAL_EXECUTOR)}\n` +
      `import { localCachePlugin } from ${JSON.stringify(LOCAL_CACHE)}\n` +
      `import { mcp } from ${JSON.stringify(PLUGIN_ENTRY)}\n` +
      `export default { plugins: [mcp(), localExecutorPlugin(), localCachePlugin()] }\n`,
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  // One real run, so the cache has an entry and the history a row.
  const run = Bun.spawnSync({
    cmd: [process.execPath, CORE_BIN, 'run', 'build', '--all'],
    cwd: root,
  })
  expect(run.exitCode).toBe(0)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const req = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })

describe('handleMessage', () => {
  it('initialize answers with the tools capability and echoes a known client version', async () => {
    const r = (await handleMessage(
      req(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      }),
      ctx,
    )) as { result: Record<string, unknown> }
    expect(r.result['protocolVersion']).toBe('2024-11-05')
    expect(r.result['capabilities']).toEqual({ tools: {} })
    expect(r.result['serverInfo']).toEqual({ name: 'vx', version: VERSION })
    const unknown = (await handleMessage(
      req(2, 'initialize', { protocolVersion: '1999-01-01' }),
      ctx,
    )) as {
      result: Record<string, unknown>
    }
    expect(unknown.result['protocolVersion']).toBe(PROTOCOL_VERSION)
  })

  it('a notification gets no reply; an unknown method is -32601; garbage is -32700', async () => {
    expect(
      await handleMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        ctx,
      ),
    ).toBeNull()
    const unknown = (await handleMessage(req(3, 'resources/list'), ctx)) as {
      error: { code: number }
    }
    expect(unknown.error.code).toBe(-32601)
    const garbage = (await handleMessage('{not json', ctx)) as { error: { code: number } }
    expect(garbage.error.code).toBe(-32700)
  })

  it('tools/list advertises the four tools with object schemas', async () => {
    const r = (await handleMessage(req(4, 'tools/list'), ctx)) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string } }> }
    }
    expect(r.result.tools.map((t) => t.name).sort()).toEqual([
      'explainCacheKey',
      'getCacheStats',
      'getRunHistory',
      'whyDidThisRerun',
    ])
    for (const t of r.result.tools) expect(t.inputSchema.type).toBe('object')
  })

  it('tools/call returns text content; a tool refusal is an isError result, not a protocol error', async () => {
    const ok = (await handleMessage(
      req(5, 'tools/call', { name: 'getCacheStats', arguments: {} }),
      ctx,
    )) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean }
    }
    expect(ok.result.isError).toBeUndefined()
    const stats = JSON.parse(ok.result.content[0]!.text) as { entryCount: number }
    expect(stats.entryCount).toBe(1)
    const refused = (await handleMessage(
      req(6, 'tools/call', { name: 'explainCacheKey', arguments: { taskId: 'no-hash' } }),
      ctx,
    )) as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(refused.result.isError).toBe(true)
    expect(refused.result.content[0]!.text).toContain('project#task')
    const missing = (await handleMessage(req(7, 'tools/call', { name: 'nope' }), ctx)) as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    expect(missing.result.isError).toBe(true)
    expect(missing.result.content[0]!.text).toContain('unknown tool')
  })
})

describe('vx mcp over stdio (the real entry point)', () => {
  it('answers initialize, tools/list and a tools/call, then exits when stdin closes', async () => {
    const p = Bun.spawn({
      cmd: [process.execPath, CORE_BIN, 'mcp'],
      cwd: root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    p.stdin.write(
      [
        req(1, 'initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        req(2, 'tools/list'),
        req(3, 'tools/call', { name: 'getRunHistory', arguments: { project: 'a' } }),
      ].join('\n') + '\n',
    )
    p.stdin.end()
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    expect({ code, err }).toEqual({ code: 0, err: '' })
    const replies = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> })
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3])
    expect((replies[1]!.result['tools'] as unknown[]).length).toBe(4)
    const history = JSON.parse(
      (replies[2]!.result['content'] as Array<{ text: string }>)[0]!.text,
    ) as {
      runs: Array<{ project: string; task: string }>
    }
    expect(history.runs.map((r) => `${r.project}#${r.task}`)).toEqual(['a#build'])
  }, 20_000)

  it('is listed by vx help and unknown outside the workspace', async () => {
    const help = Bun.spawnSync({ cmd: [process.execPath, CORE_BIN, 'help'], cwd: root })
    expect(new TextDecoder().decode(help.stdout)).toContain('vx mcp')
    const outside = Bun.spawnSync({ cmd: [process.execPath, CORE_BIN, 'mcp'], cwd: os.tmpdir() })
    expect(outside.exitCode).toBe(1)
    expect(new TextDecoder().decode(outside.stderr)).toContain('unknown command: mcp')
  })
})

describe('the command context carries the workspace’s declared cacheDir', () => {
  it('a relocated cache is the one vx mcp reads — never an assumed .vx/cache', async () => {
    // `vx cache prune` once hardcoded `<root>/.vx/cache` and pruned the wrong
    // directory for anyone who relocated their cache; here the failure would
    // be quieter — an agent told the workspace has never run a task.
    const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-cachedir-'))
    try {
      await writeFile(path.join(ws, 'package.json'), JSON.stringify({ name: 'ws2', private: true }))
      await writeFile(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeFile(
        path.join(ws, 'vx.workspace.mjs'),
        `import { localExecutorPlugin } from ${JSON.stringify(LOCAL_EXECUTOR)}\n` +
          `import { localCachePlugin } from ${JSON.stringify(LOCAL_CACHE)}\n` +
          `import { mcp } from ${JSON.stringify(PLUGIN_ENTRY)}\n` +
          `export default { cacheDir: 'build/.vx-cache', plugins: [mcp(), localExecutorPlugin(), localCachePlugin()] }\n`,
      )
      const cache = new Cache(path.join(ws, 'build', '.vx-cache'))
      cache.recordRun({
        hash: 'c1',
        project: 'custom',
        task: 'build',
        status: 'success',
        exitCode: 0,
        durationMs: 5,
        forwardArgs: [],
        startedAt: Date.now() - 100,
        endedAt: Date.now() - 95,
        runId: 'rc',
        cacheHit: false,
      })
      cache.close()
      const p = Bun.spawn({
        cmd: [process.execPath, CORE_BIN, 'mcp'],
        cwd: ws,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      p.stdin.write(req(1, 'tools/call', { name: 'getCacheStats', arguments: {} }) + '\n')
      p.stdin.end()
      const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()])
      expect(code).toBe(0)
      const reply = JSON.parse(out.trim()) as { result: { content: Array<{ text: string }> } }
      const stats = JSON.parse(reply.result.content[0]!.text) as { runCountLast24h: number }
      expect(stats.runCountLast24h).toBe(1)
      expect(await Bun.file(path.join(ws, '.vx', 'cache', 'cache.db')).exists()).toBe(false)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }, 20_000)
})

// Keep the fixture's cache handle contract honest: a Cache opened on the
// workspace this server serves sees the run the setup made.
it('the fixture really has one entry', () => {
  const cache = new Cache(ctx.cacheDir)
  try {
    expect(cache.stats().entryCount).toBe(1)
  } finally {
    cache.close()
  }
})

// The stdio framing, fed chunks directly. A chunk boundary inside a
// multi-byte character is the case a per-chunk decoder cannot survive: it
// yielded `p��#build`, and the tool answered for a task that does not exist.
describe('serve (stdio framing)', () => {
  async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
    for (const p of parts) {
      await Bun.sleep(1)
      yield p
    }
  }

  it('reassembles a multi-byte character split across chunks, and a line split across chunks', async () => {
    const msg =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'explainCacheKey', arguments: { taskId: 'pé#build' } },
      }) + '\n'
    const bytes = new TextEncoder().encode(msg)
    const lead = msg.indexOf('é') // ASCII before it: char index == byte index
    expect(bytes[lead]).toBe(0xc3) // precondition: the cut is INSIDE the character
    const lines: string[] = []
    await serve(chunks(bytes.slice(0, lead + 1), bytes.slice(lead + 1)), (l) => lines.push(l), ctx)
    expect(lines).toHaveLength(1)
    const reply = JSON.parse(lines[0]!) as { result: { content: { text: string }[] } }
    const body = JSON.parse(reply.result.content[0]!.text) as { taskId: string; project: string }
    expect(body).toMatchObject({ taskId: 'pé#build', project: 'pé' })
  })

  it('handles several messages in one chunk and a trailing message with no newline', async () => {
    const two =
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) // no trailing newline
    const lines: string[] = []
    await serve(chunks(new TextEncoder().encode(two)), (l) => lines.push(l), ctx)
    expect(lines.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 2])
  })
})
