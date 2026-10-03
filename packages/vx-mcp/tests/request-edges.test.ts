// Edges of the request envelope the protocol rows left unheld (F stream,
// B-100): a method that is no string is an invalid request with its id
// echoed, never a lookup of `5` or `null` as a method name; and a line of
// several megabytes is answered whole, the session going on after it.
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it } from 'bun:test'
import { handleMessage, serve } from '../src/server.js'

const ctx = { cacheDir: path.join(os.tmpdir(), 'vx-mcp-edges-none'), workspaceRoot: os.tmpdir() }

async function* chunks(bytes: Uint8Array, size = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}

describe('the request envelope', () => {
  it('a method that is no string is an invalid request, its id echoed', async () => {
    const answers = await Promise.all(
      [5, null, ['ping'], { name: 'ping' }].map((method, id) =>
        handleMessage(JSON.stringify({ jsonrpc: '2.0', id, method }), ctx),
      ),
    )
    expect(answers as unknown[]).toEqual(
      [0, 1, 2, 3].map((id) => ({
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'invalid request' },
      })),
    )
  })

  it('a line of several megabytes is answered, and the next one too', async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(5 << 20) })
    const input = `${big}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`
    const lines: string[] = []
    await serve(chunks(new TextEncoder().encode(input)), (l) => lines.push(l), ctx)
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ])
  })
})
