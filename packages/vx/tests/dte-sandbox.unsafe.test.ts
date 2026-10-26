// A sandboxed task runs on a `@vzn/vx-dte` worker inside the worker's own
// sandbox (`TaskExecutor.sandbox`, `localFloor`): its writes land there and
// come back, and a read outside its grants fails it with the violation in
// this checkout's paths. Unsafe: it runs a sandbox, which cannot nest inside
// a sandboxed shard (A-24).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('dte sandbox test')
const DTE = path.resolve(import.meta.dir, '../../vx-dte/src/index.ts')
const RELAY = path.resolve(import.meta.dir, '../../vx-dte-server/src/index.ts')
const BIN = path.resolve(import.meta.dir, '../src/bin.ts')

describe.skipIf(!available)('a sandboxed task on a worker', () => {
  let root = ''
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-sb-'))
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'ws', private: true }),
      '.gitignore': 'out\nstamp\n.vx/cache\n',
      '.vx/workspace.mjs': `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { max: 1, cpu: 2, memory: '1GB' } }, adapter: local() })] }
`,
      'secret/s.txt': 'secret\n',
      'secret/vx.config.mjs': `export default { name: 'secret', tasks: {} }\n`,
      // Reads the home's ssh key, which every sandbox denies.
      'k/vx.config.mjs': `export default { name: 'k', tasks: {
  key: { exec: { command: 'cat "$HOME/.ssh/id"', sandbox: {} } },
} }
`,
      // A server it needs starts on the worker, inside its own sandbox: no
      // write grant, so its write to the orchestrator's checkout is refused.
      's/vx.config.mjs': `export default { name: 's', tasks: {
  srv: { exec: { command: 'echo x > ${path.join(root, 'escaped.txt')}; echo ready; exec sleep 30', persistent: { readyWhen: 'ready' }, sandbox: {} } },
  use: { exec: { command: 'sleep 1' }, dependsOn: ['srv'] },
} }
`,
      'a/vx.config.mjs': `export default { name: 'a', tasks: {
  gen: {
    exec: { command: 'mkdir -p out && pwd > out/where.txt', sandbox: { allow: { read: ['.'], write: ['out/'] } } },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['out/**'] } },
  },
  stamp: {
    exec: { command: 'sleep 0.1; : > stamp', sandbox: { allow: { read: ['.'], write: ['stamp'] } } },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['stamp'] } },
  },
  peek: {
    exec: { command: 'cat ../secret/s.txt', sandbox: { allow: { read: ['.'] } } },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: [] } },
  },
} }
`,
    }
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
      await writeFile(path.join(root, rel), text)
    }
    const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
    git('init', '-q')
    expect(vx(['lock']).exitCode).toBe(0)
    git('add', '-A')
    git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'i')
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
  const vx = (args: string[], run?: string) => {
    const { VX_DTE_RUN: _, ...env } = process.env
    return Bun.spawnSync([process.execPath, BIN, ...args], {
      cwd: root,
      env: { ...env, ...(run === undefined ? {} : { VX_DTE_RUN: run }), NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }

  it('writes in its grants on the worker, and the files come back', async () => {
    const r = vx(['run', 'a#gen'], crypto.randomUUID())
    expect([r.exitCode, r.stdout.toString() + r.stderr.toString()]).toEqual([0, expect.any(String)])
    const where = (await readFile(path.join(root, 'a/out/where.txt'), 'utf8')).trim()
    expect(where).not.toBe(path.join(root, 'a'))
    expect(where.endsWith(`${path.sep}a`)).toBe(true)
  }, 60_000)

  // The worker took back every empty bind after the task, an empty stamp
  // the task wrote too: saved as no file, every hit restored none (2026-10-24).
  it('keeps an empty file the task wrote over its write grant', async () => {
    const r = vx(['run', 'a#stamp'], crypto.randomUUID())
    expect([r.exitCode, r.stdout.toString() + r.stderr.toString()]).toEqual([0, expect.any(String)])
    expect(await Bun.file(path.join(root, 'a/stamp')).exists()).toBe(true)
  }, 60_000)

  it('starts a sandboxed server it needs inside that sandbox', async () => {
    const r = vx(['run', 's#use'], crypto.randomUUID())
    expect([r.exitCode, r.stdout.toString() + r.stderr.toString()]).toEqual([0, expect.any(String)])
    expect(await Bun.file(path.join(root, 'escaped.txt')).exists()).toBe(false)
  }, 60_000)

  it('fails a read outside its grants, naming this checkout', () => {
    const r = vx(['run', 'a#peek'], crypto.randomUUID())
    const out = r.stdout.toString() + r.stderr.toString()
    expect(r.exitCode).not.toBe(0)
    expect(out).not.toContain('secret\n')
    expect(out).toContain(path.join('secret', 's.txt'))
  }, 60_000)

  // The worker builds a task's sandbox on its own machine: its home's
  // credential stores are walled, not the orchestrator's (which may be
  // another OS, owner 2026-10-22).
  it('walls the worker’s own credential stores, not the orchestrator’s', async () => {
    // Typed here: the checker of this project may not read the relay's source.
    const { serveRelay } = (await import(RELAY)) as {
      serveRelay(o: { hostname: string; port: number }): { url: string; stop(): Promise<void> }
    }
    const server = serveRelay({ hostname: '127.0.0.1', port: 0 })
    const homes = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-homes-'))
    const config = path.join(root, '.vx/workspace.mjs')
    const before = await readFile(config, 'utf8')
    const commit = () =>
      git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'r')
    try {
      await mkdir(path.join(homes, 'worker/.ssh'), { recursive: true })
      await mkdir(path.join(homes, 'orc'), { recursive: true })
      await writeFile(path.join(homes, 'worker/.ssh/id'), 'WORKER-KEY\n')
      await writeFile(
        config,
        `import { dte } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ relay: ${JSON.stringify(server.url)} })] }
`,
      )
      commit()
      const { VX_DTE_RUN: _, ...env } = process.env
      const shared = {
        VX_DTE_RUN: crypto.randomUUID(),
        VX_DTE_SECRET: 'hand-secret',
        NO_COLOR: '1',
      }
      const spawn = (args: string[], home: string) =>
        Bun.spawn([process.execPath, BIN, ...args], {
          cwd: root,
          env: { ...env, ...shared, HOME: path.join(homes, home) },
          stdout: 'pipe',
          stderr: 'pipe',
        })
      const run = spawn(['run', 'k#key'], 'orc')
      // A worker before the run is live leaves at once ("has no live run"),
      // and the run waits for one: started again until it joins.
      for (let i = 0; ; i++) {
        const worker = spawn(['dte', 'worker'], 'worker')
        const [said] = await Promise.all([new Response(worker.stderr).text(), worker.exited])
        if (!said.includes('has no live run') || i === 50) break
        await Bun.sleep(100)
      }
      const out = (await new Response(run.stdout).text()) + (await new Response(run.stderr).text())
      expect([await run.exited, out.includes('WORKER-KEY')]).toEqual([1, false])
      // On the worker, and walled there: with an option dte() does not take
      // (`local: 0`), the config was refused and this passed with no task run.
      expect(out).toContain('k#key · worker#1')
      expect(out).toContain(path.join(homes, 'worker/.ssh/id'))
    } finally {
      await server.stop()
      await rm(homes, { recursive: true, force: true })
      await writeFile(config, before)
      commit()
    }
  }, 60_000)
})
