// A task id needs both halves. `#build` and `app#` held a `#` and were
// answered with a null entry, which an agent reads as "never ran"; an empty
// run id was answered "no row matching" (stream F).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { handleToolCall } from '../src/tools.js'

const root = mkdtempSync(path.join(tmpdir(), 'vx-mcp-taskid-'))
writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ctx = { cacheDir: path.join(root, '.vx', 'cache'), workspaceRoot: root }
const said = (tool: string, args: unknown): Promise<string> =>
  handleToolCall(tool, args, ctx).then(
    () => 'answered',
    (e: Error) => e.message,
  )

it('a task id with an empty half is refused', async () => {
  for (const taskId of ['#build', 'app#', '#']) {
    expect(await said('explainCacheKey', { taskId })).toBe(
      'explainCacheKey: taskId must be a "project#task" string',
    )
    expect(await said('whyDidThisRerun', { taskId })).toBe(
      'whyDidThisRerun: taskId must be a "project#task" string',
    )
  }
})

it('an empty run id is refused', async () => {
  expect(await said('whyDidThisRerun', { taskId: 'app#build', runId: '' })).toBe(
    'whyDidThisRerun: runId, when given, must not be empty',
  )
})

it('a whole task id gets past the check', async () => {
  // CONTROL: answered, or refused for having no runs — never for its shape.
  expect(await said('explainCacheKey', { taskId: 'app#build' })).toBe('answered')
  expect(await said('whyDidThisRerun', { taskId: 'app#build' })).toBe(
    'whyDidThisRerun: no recorded runs for app#build',
  )
})
