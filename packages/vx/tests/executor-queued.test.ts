// A remote executor that held a task waiting for a machine (vx-dte's warm-up)
// says how long (`ExecuteResult.queuedMs`): that wait is the task's queue
// time, not its run. Its span read 1.7 s for a 0.4 s task, queued 1 ms.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

const WAIT_MS = 600

let root = ''
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-exec-queued-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it("a remote executor's wait for a machine is the task's queue time, not its span", async () => {
  await Bun.write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', workspaces: ['a'] }),
  )
  await Bun.write(path.join(root, 'a', 'package.json'), JSON.stringify({ name: 'a' }))
  await Bun.write(path.join(root, 'a', 'src', 'x.txt'), 'x\n')
  await Bun.write(
    path.join(root, 'a', 'vx.config.mjs'),
    `export default { tasks: { gen: {
       exec: { command: 'echo here > out.txt' },
       inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
     } } }`,
  )
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/waits',
        `{ executor() {
           return {
             name: 'waits',
             capabilities: { remote: true },
             async execute(req) {
               await new Promise((r) => setTimeout(r, ${WAIT_MS}))
               await Bun.write(req.cwd + '/out.txt', 'here\\n')
               return { exitCode: 0, durationMs: 5, stdout: '', stderr: '', violations: [], where: 'w#1', queuedMs: ${WAIT_MS} }
             },
           }
         } }`,
      ),
    ]),
  )
  await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
  writeFileSync(path.join(root, '.gitignore'), '.vx/cache\n')
  const r = await run({
    cwd: root,
    tasks: ['gen'],
    projects: ['a'],
    handleSignals: false,
    log: {
      runStart: () => undefined,
      taskStart: () => undefined,
      taskStdout: () => undefined,
      taskStderr: () => undefined,
      taskComplete: () => undefined,
      runEnd: () => undefined,
      status: () => undefined,
    },
  })
  expect(r.outcomes.map((o) => o.status)).toEqual(['success'])
  const t = r.outcomes[0]!.timing!
  expect(t.queuedMs).toBeGreaterThanOrEqual(WAIT_MS)
  expect(Number(t.endNs! - t.startNs!) / 1e6).toBeLessThan(WAIT_MS)
  expect(r.outcomes[0]!.durationMs).toBe(5)
})
