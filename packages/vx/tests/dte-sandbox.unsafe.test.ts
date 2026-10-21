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
    const r = vx(['run', 'a#gen'], 'sb-1')
    expect([r.exitCode, r.stdout.toString() + r.stderr.toString()]).toEqual([0, expect.any(String)])
    const where = (await readFile(path.join(root, 'a/out/where.txt'), 'utf8')).trim()
    expect(where).not.toBe(path.join(root, 'a'))
    expect(where.endsWith(`${path.sep}a`)).toBe(true)
  }, 60_000)

  it('fails a read outside its grants, naming this checkout', () => {
    const r = vx(['run', 'a#peek'], 'sb-2')
    const out = r.stdout.toString() + r.stderr.toString()
    expect(r.exitCode).not.toBe(0)
    expect(out).not.toContain('secret\n')
    expect(out).toContain(path.join('secret', 's.txt'))
  }, 60_000)
})
