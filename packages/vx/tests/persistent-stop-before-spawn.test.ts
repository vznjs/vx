// A persistent task awaits its key (and a sandboxed one the sandbox's
// arming, request and wrap) before it spawns. A stop that landed in
// between was never looked at again: the server came up after the
// teardown and a Ctrl-C took 7 s to end the run (2026-10-02).
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const config = `export default {
  tasks: { dev: { exec: { command: 'echo up > started.txt; echo up; exec sleep 30', persistent: { readyWhen: 'up' } } } },
}
`

describe('a persistent task stopped before its spawn', () => {
  // A hang-up forwards SIGTERM to a server (`forwardedSignal`): 143.
  it.each([
    ['SIGINT', 130],
    ['SIGHUP', 143],
  ])('on %s never spawns, and is aborted with exit %d', async (reason, code) => {
    const root = await makeWorkspace({ prefix: 'vx-persist-stop-' })
    try {
      const dir = await addProject(root, 'app', config)
      const stop = new AbortController()
      const start = Date.now()
      const r = await run({
        cwd: root,
        tasks: ['dev'],
        signal: stop.signal,
        log: {
          status() {},
          taskStdout() {},
          taskStderr() {},
          taskComplete() {},
          taskStart: () => stop.abort(reason),
        },
      })
      expect([
        r.outcomes.map((o) => [o.status, o.exitCode]),
        existsSync(path.join(dir, 'started.txt')),
      ]).toEqual([[['aborted', code]], false])
      expect(Date.now() - start).toBeLessThan(5000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('CONTROL: spawns when no stop came', async () => {
    const root = await makeWorkspace({ prefix: 'vx-persist-stop-' })
    try {
      const dir = await addProject(root, 'app', config)
      const r = await run({
        cwd: root,
        tasks: ['dev'],
        log: { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} },
      })
      expect([r.outcomes.map((o) => o.status), existsSync(path.join(dir, 'started.txt'))]).toEqual([
        ['success'],
        true,
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
