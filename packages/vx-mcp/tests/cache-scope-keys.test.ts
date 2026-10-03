// getCacheStats' scope takes `project` alone. A `task` beside it was
// ignored, and the project's numbers came back as if the task's.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { handleToolCall } from '../src/tools.js'

const root = mkdtempSync(path.join(tmpdir(), 'vx-mcp-scope-'))
writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ctx = { cacheDir: path.join(root, '.vx', 'cache'), workspaceRoot: root }
const said = (scope: unknown): Promise<string> =>
  handleToolCall('getCacheStats', { scope }, ctx).then(
    (r) => JSON.stringify(r['scope']),
    (e: Error) => e.message,
  )

it('a scope key beside project is refused', async () => {
  expect(await said({ project: 'a', task: 'build' })).toBe(
    'getCacheStats: scope must be "all" or { "project": "<name>" }',
  )
})

it('project alone is the scope', async () => {
  expect(await said({ project: 'a' })).toBe('{"project":"a"}')
  expect(await said('all')).toBe('"all"')
})
