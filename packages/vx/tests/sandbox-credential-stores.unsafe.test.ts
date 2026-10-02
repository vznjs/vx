// A sandboxed task could read the host's credential stores: `~/.ssh`,
// `~/.npmrc`, `~/.aws/credentials`. Reads outside the workspace stay open
// (tools need `~/.cache`, `/etc`), so a dependency the task ran could copy
// a key into a declared output, and the cache would hand it to every
// reader of a shared remote (L-41). They are denied unless the task
// names one in `allow.read`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const available = await sandboxAvailable('sandbox credential stores test')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe.skipIf(!available)('a sandboxed task and the home credential stores', () => {
  it('reads none unless granted, and the rest of home as before', async () => {
    root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-cred-')))
    const home = path.join(root, 'home')
    const ws = path.join(root, 'ws')
    for (const [rel, body] of [
      ['.ssh/id_ed25519', 'SSHKEY'],
      ['.npmrc', 'NPMRC'],
      ['.aws/credentials', 'AWSKEY'],
      ['.cache/tool/state', 'CACHE'],
    ] as const) {
      await mkdir(path.dirname(path.join(home, rel)), { recursive: true })
      await writeFile(path.join(home, rel), `${body}\n`)
    }
    await mkdir(path.join(ws, 'packages', 'a'), { recursive: true })
    await writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    await writeFile(path.join(ws, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
    // A denied file reads as empty (a /dev/null bind), a denied directory as
    // an empty one: either way grep finds no line.
    const read = (f: string): string => `grep -s . "$HOME/${f}" || echo "no ${f}"`
    const cmd = ['.ssh/id_ed25519', '.npmrc', '.aws/credentials', '.cache/tool/state']
      .map(read)
      .join('; ')
    await writeFile(
      path.join(ws, 'packages', 'a', 'vx.config.mjs'),
      `export default { tasks: {
  peek: { exec: { command: ${JSON.stringify(cmd)}, sandbox: { allow: { read: ['.'] } } } },
  granted: { exec: { command: ${JSON.stringify(read('.npmrc'))}, sandbox: { allow: { read: ['.', '~/.npmrc'] } } } },
} }
`,
    )
    expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: ws }).exitCode).toBe(0)
    const out = (task: string): string[] => {
      const r = Bun.spawnSync({
        cmd: [process.execPath, BIN, 'run', `a#${task}`, '--output-logs', 'full'],
        cwd: ws,
        env: { ...process.env, HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const text = r.stdout.toString() + r.stderr.toString()
      expect(r.exitCode, text).toBe(0)
      return text
        .split('\n')
        .map((l) => l.replace(/^.*?│\s?/, '').trim())
        .filter((l) => /^(no \.|SSHKEY|NPMRC|AWSKEY|CACHE)/.test(l))
    }
    expect(out('peek')).toEqual(['no .ssh/id_ed25519', 'no .npmrc', 'no .aws/credentials', 'CACHE'])
    expect(out('granted')).toEqual(['NPMRC'])
  })
})
