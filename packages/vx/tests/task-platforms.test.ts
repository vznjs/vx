// `exec.platforms`: a task runs on a machine it lists. Off one, a local run
// skips it and what depends on it, green; CI and an executor that routes by
// platform refuse the run before any task starts (2026-10-23).
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { hostPlatform } from '../src/exec/index.js'
import { type Logger } from '../src/report/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { lock, planRun, run } from './helpers/orchestrator.js'
import { formatPlanJson, formatPlanText } from '../src/cli/plan-format.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const HOST = hostPlatform()
const OTHER = HOST === 'linux-x64' ? 'darwin-arm64' : 'linux-x64'
const CI_VARS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI']

const CONFIG = `export default {
  tasks: {
    other: { exec: { command: 'touch other.txt', platforms: ['${OTHER}'] } },
    after: { dependsOn: ['other'], exec: { command: 'touch after.txt' } },
    here: { exec: { command: 'touch here.txt', platforms: ['${OTHER}', '${HOST}'] } },
  },
}
`

let root: string
let saved: Record<string, string | undefined>
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-platforms-' })
  saved = Object.fromEntries(CI_VARS.map((k) => [k, process.env[k]]))
  for (const k of CI_VARS) delete process.env[k]
})
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(root, { recursive: true, force: true })
})

function logger(lines: string[]): Logger {
  return {
    status: (m) => void lines.push(m),
    taskStdout() {},
    taskStderr: (_n, t) => void lines.push(t),
    taskComplete() {},
  }
}

describe('exec.platforms', () => {
  it('skips a task off its platforms, and its dependants, without failing the run', async () => {
    const dir = await addProject(root, 'app', CONFIG)
    const lines: string[] = []
    const r = await run({ cwd: dir, tasks: ['after', 'here'], log: logger(lines) })
    const by = new Map(r.outcomes.map((o) => [o.node.id, o]))
    expect(r.ok).toBe(true)
    expect(by.get('app#other')?.status).toBe('skipped')
    expect(by.get('app#other')?.otherPlatform).toEqual({ needs: [OTHER], host: HOST })
    // No failure blocked it: its exit is the platform skip's 0, not a failure's 1.
    expect([
      by.get('app#after')?.status,
      by.get('app#after')?.blockedBy,
      by.get('app#after')?.exitCode,
      by.get('app#other')?.exitCode,
    ]).toEqual(['skipped', 'app#other', 0, 0])
    expect(by.get('app#here')?.status).toBe('success')
    expect(await Bun.file(path.join(dir, 'other.txt')).exists()).toBe(false)
    expect(await Bun.file(path.join(dir, 'after.txt')).exists()).toBe(false)
    expect(lines.filter((l) => l.includes('skipped on'))).toEqual([
      `[vx] skipped on ${HOST}, with what depends on them: app#other needs ${OTHER}`,
    ])
  })

  // `--continue=always` runs a FAILURE's dependants; a platform skip is no
  // failure, and its dependant ran with nothing beneath it and turned the
  // run red.
  it('skips the dependants under --continue=always too', async () => {
    const dir = await addProject(root, 'app', CONFIG)
    const r = await run({
      cwd: dir,
      tasks: ['after', 'here'],
      continueMode: 'always',
      log: logger([]),
    })
    const by = new Map(r.outcomes.map((o) => [o.node.id, o]))
    expect(r.ok).toBe(true)
    expect([by.get('app#after')?.status, by.get('app#after')?.blockedBy]).toEqual([
      'skipped',
      'app#other',
    ])
    expect(await Bun.file(path.join(dir, 'after.txt')).exists()).toBe(false)
  })

  // `--continue=always` runs past a FAILED upstream; a platform skip is
  // not one. Its dependants ran anyway, built on outputs never made, and
  // the taint kept them from saving, so every such run ran them again.
  it('skips the dependants of a task off its platforms under --continue=always', async () => {
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: {
        other: { exec: { command: 'touch other.txt', platforms: ['${OTHER}'] } },
        broken: { exec: { command: 'exit 1' } },
        after: { dependsOn: ['broken', 'other'], exec: { command: 'touch after.txt' } },
        last: { dependsOn: ['after'], exec: { command: 'touch last.txt' } },
      } }`,
    )
    const r = await run({ cwd: dir, tasks: ['last'], log: logger([]), continueMode: 'always' })
    const by = new Map(r.outcomes.map((o) => [o.node.id, o]))
    expect(
      ['app#after', 'app#last'].map((id) => [by.get(id)?.status, by.get(id)?.blockedBy]),
    ).toEqual([
      ['skipped', 'app#other'],
      ['skipped', 'app#other'],
    ])
    expect(await Bun.file(path.join(dir, 'after.txt')).exists()).toBe(false)
  })

  it('refuses the run on CI before any task starts', async () => {
    const dir = await addProject(root, 'app', CONFIG)
    process.env['CI'] = 'true'
    const said = await run({ cwd: dir, tasks: ['after', 'here'], log: logger([]) }).then(
      () => 'ran',
      (e: Error) => e.message,
    )
    expect(said).toBe(
      `on CI every task runs or the run fails, and this task cannot run on ${HOST}:\n` +
        `  app#other needs ${OTHER}\n` +
        `run a target that holds only ${HOST} tasks, or one DTE run with a worker of each platform`,
    )
    expect(await Bun.file(path.join(dir, 'here.txt')).exists()).toBe(false)
  })

  // `--dry` previews the run: it said "would exec" for a task the run skips
  // and for what depends on it, and on CI it exited 0 where the run refuses.
  it('--dry plans the skip the run makes, and says why', async () => {
    const dir = await addProject(
      root,
      'app',
      CONFIG.replace('tasks: {', "tasks: {\n    all: { dependsOn: ['after', 'here'] },"),
    )
    const plan = await planRun({ cwd: dir, tasks: ['all'], log: logger([]) })
    const json = JSON.parse(formatPlanJson(plan)) as {
      tasks: { id: string; cacheStatus: string; otherPlatform?: unknown; blockedBy?: string }[]
    }
    expect(
      json.tasks
        .map((t) => ({
          id: t.id,
          cacheStatus: t.cacheStatus,
          ...(t.otherPlatform !== undefined ? { otherPlatform: t.otherPlatform } : {}),
          ...(t.blockedBy !== undefined ? { blockedBy: t.blockedBy } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      { id: 'app#after', cacheStatus: 'skipped', blockedBy: 'app#other' },
      { id: 'app#all', cacheStatus: 'skipped', blockedBy: 'app#other' },
      { id: 'app#here', cacheStatus: 'no-cache' },
      { id: 'app#other', cacheStatus: 'skipped', otherPlatform: { needs: [OTHER], host: HOST } },
    ])
    const text = formatPlanText(plan)
    expect(text.split('\n').filter((l) => l.includes('skipped'))).toEqual([
      expect.stringMatching(new RegExp(`^  ·  app#(after|other) +skipped — `)),
      expect.stringMatching(new RegExp(`^  ·  app#(after|other) +skipped — `)),
      '3 task(s) planned, 1 no-cache, 2 skipped.',
    ])
    expect(text).toContain(`skipped — needs ${OTHER}, this is ${HOST}`)
    expect(text).toContain('skipped — blocked by app#other')
  })

  it('--dry refuses on CI as the run does', async () => {
    const dir = await addProject(root, 'app', CONFIG)
    process.env['CI'] = 'true'
    const said = await planRun({ cwd: dir, tasks: ['after', 'here'], log: logger([]) }).then(
      () => 'planned',
      (e: Error) => e.message,
    )
    expect(said).toBe(
      `on CI every task runs or the run fails, and this task cannot run on ${HOST}:\n` +
        `  app#other needs ${OTHER}\n` +
        `run a target that holds only ${HOST} tasks, or one DTE run with a worker of each platform`,
    )
  })

  it('routes a task to an executor that runs one of its platforms, on that platform', async () => {
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([
        pluginSource(
          'org/router',
          `{ executor() { return { name: 'router', remote: true, platforms: ['${OTHER}'],
            accepts: (t) => t.taskId === 'app#other',
            execute(req) {
              require('node:fs').writeFileSync(require('node:path').join(req.cwd, 'routed.txt'), req.platform)
              return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
            } } } }`,
        ),
      ]),
    )
    const dir = await addProject(root, 'app', CONFIG)
    const r = await run({ cwd: dir, tasks: ['after'], log: logger([]), handleSignals: false })
    expect(r.outcomes.map((o) => `${o.node.id} ${o.status}`).sort()).toEqual([
      'app#after success',
      'app#other success',
    ])
    expect(await Bun.file(path.join(dir, 'routed.txt')).text()).toBe(OTHER)
  })

  it('refuses a task no executor runs on a platform it lists', async () => {
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([
        pluginSource(
          'org/router',
          `{ executor() { return { name: 'router', remote: true, platforms: ['${HOST}'],
            execute() { return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] } } } } }`,
        ),
      ]),
    )
    const dir = await addProject(root, 'app', CONFIG)
    const said = await run({ cwd: dir, tasks: ['other'], log: logger([]) }).then(
      () => 'ran',
      (e: Error) => e.message,
    )
    expect(said).toBe(
      `no executor runs this task on a platform it lists (this machine is ${HOST}; executors run ${HOST}):\n` +
        `  app#other needs ${OTHER}\n` +
        `give the executor a worker of each platform listed`,
    )
  })

  it('refuses an executor whose platforms are not platforms', async () => {
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([
        pluginSource(
          'org/router',
          `{ executor() { return { name: 'router', platforms: ['win32-x64'], execute() {} } } }`,
        ),
      ]),
    )
    const dir = await addProject(root, 'app', CONFIG)
    const said = await run({ cwd: dir, tasks: ['here'], log: logger([]) }).then(
      () => 'ran',
      (e: Error) => e.message,
    )
    expect(said).toBe(
      `plugin 'org/router' returned executor 'router' with platforms ["win32-x64"]: it must be a non-empty array of linux-x64, linux-arm64, darwin-x64, darwin-arm64`,
    )
  })

  it('refuses a platform vx does not know at lock time', async () => {
    await addProject(
      root,
      'app',
      `export default { tasks: { t: { exec: { command: 'true', platforms: ['win32-x64'] } } } }`,
    )
    const said = await lock(root).then(
      () => 'locked',
      (e: Error) => e.message,
    )
    expect(said).toContain(
      'tasks.t.exec.platforms must be a non-empty array of distinct platforms, each one of linux-x64, linux-arm64, darwin-x64, darwin-arm64',
    )
  })
})

describe('the platform in the key', () => {
  it('folds the platform a task runs on, and nothing for a task that names none', async () => {
    const cache = new Cache(path.join(root, 'cache'))
    try {
      const base = {
        taskId: 'a#b',
        taskConfigHash: 'c',
        envValues: [],
        inputFiles: [],
        workspaceRoot: root,
        upstreamHashes: [],
      }
      const none = await cache.key(base)
      const host = await cache.key({ ...base, platform: HOST })
      const other = await cache.key({ ...base, platform: OTHER })
      expect(new Set([none, host, other]).size).toBe(3)
      expect(await cache.key(base)).toBe(none)
    } finally {
      cache.close()
    }
  })
})
