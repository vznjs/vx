// A sandboxed task runs on a `@vzn/vx-dte` agent inside the agent's own
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
const RELAY = path.resolve(import.meta.dir, '../../vx-dte-relay/src/index.ts')
const BIN = path.resolve(import.meta.dir, '../src/bin.ts')

describe.skipIf(!available)('a sandboxed task on an agent', () => {
  let root = ''
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-sb-'))
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'ws', private: true }),
      '.gitignore': 'out\n.vx/cache\n',
      '.vx/workspace.mjs': `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ agents: { small: { max: 1, cpu: 2, memory: '1GB' } }, adapter: local(), local: 0 })] }
`,
      'secret/s.txt': 'secret\n',
      'secret/vx.config.mjs': `export default { name: 'secret', tasks: {} }\n`,
      // Reads the home's ssh key, which every sandbox denies.
      'k/vx.config.mjs': `export default { name: 'k', tasks: {
  key: { exec: { command: 'cat "$HOME/.ssh/id"', sandbox: {} } },
} }
`,
      'a/vx.config.mjs': `export default { name: 'a', tasks: {
  gen: {
    exec: { command: 'mkdir -p out && pwd > out/where.txt', sandbox: { allow: { read: ['.'], write: ['out/'] } } },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['out/**'] } },
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

  it('writes in its grants on the agent, and the files come back', async () => {
    const r = vx(['run', 'a#gen'], crypto.randomUUID())
    expect([r.exitCode, r.stdout.toString() + r.stderr.toString()]).toEqual([0, expect.any(String)])
    const where = (await readFile(path.join(root, 'a/out/where.txt'), 'utf8')).trim()
    expect(where).not.toBe(path.join(root, 'a'))
    expect(where.endsWith(`${path.sep}a`)).toBe(true)
  }, 60_000)

  it('fails a read outside its grants, naming this checkout', () => {
    const r = vx(['run', 'a#peek'], crypto.randomUUID())
    const out = r.stdout.toString() + r.stderr.toString()
    expect(r.exitCode).not.toBe(0)
    expect(out).not.toContain('secret\n')
    expect(out).toContain(path.join('secret', 's.txt'))
  }, 60_000)

  // The agent builds a task's sandbox on its own machine: its home's
  // credential stores are walled, not the orchestrator's (which may be
  // another OS, owner 2026-10-22).
  it('walls the agent’s own credential stores, not the orchestrator’s', async () => {
    const { createRelay } = (await import(
      RELAY
    )) as typeof import('../../vx-dte-relay/src/index.ts')
    const relay = createRelay()
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
    const homes = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-homes-'))
    const config = path.join(root, '.vx/workspace.mjs')
    const before = await readFile(config, 'utf8')
    const commit = () =>
      git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'r')
    try {
      await mkdir(path.join(homes, 'agent/.ssh'), { recursive: true })
      await mkdir(path.join(homes, 'orc'), { recursive: true })
      await writeFile(path.join(homes, 'agent/.ssh/id'), 'AGENT-KEY\n')
      await writeFile(
        config,
        `import { dte } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ relay: ${JSON.stringify(`http://127.0.0.1:${server.port}`)}, local: 0 })] }
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
      const agent = spawn(['dte', 'agent'], 'agent')
      const run = spawn(['run', 'k#key'], 'orc')
      const out = (await new Response(run.stdout).text()) + (await new Response(run.stderr).text())
      expect([await run.exited, out.includes('AGENT-KEY')]).toEqual([1, false])
      await agent.exited
    } finally {
      relay.close()
      await server.stop(true)
      await rm(homes, { recursive: true, force: true })
      await writeFile(config, before)
      commit()
    }
  }, 60_000)
})
