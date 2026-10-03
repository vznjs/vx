// A remote executor gives a task back with `executorFallback(reason)` (a
// remote that never started it, B-100): core runs the same task on the
// local floor, its output on disk, and says why once. A task placed
// `remote: 'only'` must not run here: it fails naming the reason.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/index.js'
import { CORE_INDEX, localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

let root = ''
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-exec-fallback-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function fixture(remote: 'only' | undefined): Promise<void> {
  await Bun.write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', workspaces: ['a'] }),
  )
  await Bun.write(path.join(root, 'a', 'package.json'), JSON.stringify({ name: 'a' }))
  await Bun.write(path.join(root, 'a', 'src', 'x.txt'), 'x\n')
  await Bun.write(
    path.join(root, 'a', 'vx.config.mjs'),
    `export default { tasks: { gen: {
       exec: { command: 'echo here > out.txt'${remote === 'only' ? ", remote: 'only'" : ''} },
       cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
     } } }`,
  )
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource(
      [
        pluginSource(
          'org/gives-back',
          `{ executor() {
             return {
               name: 'gives-back',
               remote: true,
               async execute() {
                 throw executorFallback('no worker started it')
               },
             }
           } }`,
        ),
      ],
      `import { executorFallback } from ${JSON.stringify(CORE_INDEX)}\n`,
    ),
  )
  await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
}

async function runIt() {
  const said: string[] = []
  const stderr: string[] = []
  const r = await run({
    cwd: root,
    tasks: ['gen'],
    projects: ['a'],
    handleSignals: false,
    log: {
      runStart: () => undefined,
      taskStart: () => undefined,
      taskStdout: () => undefined,
      taskStderr: (_n: unknown, c: string) => stderr.push(c),
      taskComplete: () => undefined,
      runEnd: () => undefined,
      status: (l: string) => said.push(l),
    },
  })
  const out = Bun.file(path.join(root, 'a', 'out.txt'))
  return {
    ok: r.ok,
    statuses: r.outcomes.map((o) => o.status),
    out: (await out.exists()) ? await out.text() : 'absent',
    said: said.filter((l) => l.includes('a#gen')),
    stderr: stderr.join('').trim(),
  }
}

describe('a remote executor that gives a task back', () => {
  it('has it run here, its output on disk, and says why once', async () => {
    await fixture(undefined)
    expect(await runIt()).toEqual({
      ok: true,
      statuses: ['success'],
      out: 'here\n',
      said: ['[vx] a#gen: no worker started it — running it here'],
      stderr: '',
    })
  })

  it("refuses a remote: 'only' task, which must not run here", async () => {
    await fixture('only')
    const named =
      "plugin 'org/gives-back' (executor 'gives-back') failed in execute: no worker started it, and remote: 'only' keeps it off this machine"
    expect(await runIt()).toEqual({
      ok: false,
      statuses: ['failed'],
      out: 'absent',
      said: [],
      stderr: `${named}\n[vx] a#gen: ${named}`,
    })
  })
})
