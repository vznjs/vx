// A tool refuses a key it does not take. A misspelt filter was ignored:
// `getRunHistory({ tsk: 'build' })` answered every task's history, which
// an agent reads as the filtered answer (the class of item 1067).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { handleToolCall, listTools } from '../src/tools.js'

const root = mkdtempSync(path.join(tmpdir(), 'vx-mcp-args-'))
writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ctx = { cacheDir: path.join(root, '.vx', 'cache'), workspaceRoot: root }
const refusal = (tool: string, args: unknown): Promise<string> =>
  handleToolCall(tool, args, ctx).then(
    () => 'answered',
    (e: Error) => e.message,
  )

it('a key a tool does not take is refused, naming the ones it takes', async () => {
  expect(await refusal('getRunHistory', { tsk: 'build' })).toBe(
    'getRunHistory: unknown argument "tsk" — it takes project, task, limit',
  )
  expect(await refusal('getWorkspaceInfo', { verbose: true, x: 1 })).toBe(
    'getWorkspaceInfo: unknown arguments "verbose", "x" — it takes none',
  )
})

it('every key a tool publishes is still taken', async () => {
  // CONTROL: each tool, called with every key its schema lists, gets past
  // the key check (its own value checks may still refuse the values).
  for (const tool of listTools()) {
    const keys = Object.keys((tool.inputSchema['properties'] ?? {}) as object)
    const args = Object.fromEntries(keys.map((k) => [k, undefined]))
    const said = await refusal(tool.name, args)
    expect({ tool: tool.name, keyRefused: said.includes('unknown argument') }).toEqual({
      tool: tool.name,
      keyRefused: false,
    })
  }
})
