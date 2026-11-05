// A refused write reaches SRT's store over a Unix socket vx serves, not
// with the task's exit. A task that refused a write and ended at once was
// read before its record arrived, and failed with no violation named: the
// mkdir CONTROL in sandbox-mkdir-ancestor went red on main once, and 38 of
// 200 such tasks run 16 at a time reported nothing.
import { realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  collectRecords,
  initSandbox,
  releaseBridges,
  resetSandbox,
  resolveSandboxConfig,
  wrapSandboxedCommand,
} from '../src/exec/sandbox-runtime.js'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox observer drain test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')(
  'a fast task that refused a write',
  () => {
    let root: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-observer-drain-' }))
    })
    afterEach(() => rm(root, { recursive: true, force: true }))

    it('names the refusal, however many end at once', async () => {
      const projects = 32
      for (let i = 0; i < projects; i++) {
        const dir = await addProject(root, `p${i}`, {
          config: `export default { tasks: { t: { exec: {
          command: 'mkdir -p node_modules/.cache/tool',
          sandbox: { allow: { read: ['.'] } },
        } } } }\n`,
        })
        await mkdir(`${dir}/node_modules/dep`, { recursive: true })
      }
      const unnamed: string[] = []
      for (let round = 0; round < 3; round++) {
        const r = await run({ cwd: root, tasks: ['t'], concurrency: 16, log: quiet })
        expect(r.outcomes.map((o) => o.status)).toEqual(Array(projects).fill('failed'))
        for (const o of r.outcomes) if ((o.sandboxViolations ?? 0) === 0) unnamed.push(o.node.id)
      }
      expect(unnamed).toEqual([])
    }, 120_000)
  },
)

// A fixed count of event-loop turns after the exit was a guess at when the
// observer's record is in: 2 held here, and 4 of 24 such tasks lost theirs
// on a loaded CI worker. A record already sent but not yet accepted when the
// exit is seen is the case, made here on purpose: socat writes it with the
// loop held, so no turn passes between the send and the read.
describe.skipIf(!available || process.platform !== 'linux')(
  'the observer read after an exit',
  () => {
    afterEach(() => resetSandbox())

    it('holds every record sent before it, however late it is accepted', async () => {
      await initSandbox()
      const dir = realpathSync(await makeWorkspace({ prefix: 'vx-observer-late-' }))
      const w = await wrapSandboxedCommand({
        command: 'true',
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        config: resolveSandboxConfig({}, dir),
      })
      releaseBridges(w.tag)
      await rm(dir, { recursive: true, force: true })
      const socket = /--setenv SRT_OBSERVE_SOCK (\S+)/.exec(w.wrapped)?.[1] ?? ''
      expect(socket).toEndWith('.sock')
      const store = SandboxManager.getSandboxViolationStore()
      for (let i = 0; i < 20; i++) {
        const command = `: 'late-${i}'; mkdir x`
        const take = collectRecords(store, command, socket)
        const encodedCommand = Buffer.from(command.slice(0, 100)).toString('base64')
        const line = JSON.stringify({ encodedCommand, syscall: 'mkdirat', path: `/late/${i}` })
        const sent = Bun.spawnSync(['socat', '-', `UNIX-CONNECT:${socket}`], {
          stdin: Buffer.from(`${line}\n`),
        })
        expect(sent.exitCode).toBe(0)
        expect((await take(true)).map((v) => v.line)).toEqual([`deny mkdirat /late/${i}`])
      }
    }, 60_000)
  },
)
