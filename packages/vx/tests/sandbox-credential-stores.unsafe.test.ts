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
const lock = (ws: string): void => {
  const r = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws, stderr: 'pipe' })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
}
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
    // A task sees $XDG_CONFIG_HOME, so gh reads its login there.
    const xdg = path.join(root, 'xdg')
    await mkdir(path.join(xdg, 'gh'), { recursive: true })
    await writeFile(path.join(xdg, 'gh', 'hosts.yml'), 'GHXDG\n')
    for (const [rel, body] of [
      ['.ssh/id_ed25519', 'SSHKEY'],
      ['.npmrc', 'NPMRC'],
      ['.aws/credentials', 'AWSKEY'],
      ['.bunfig.toml', 'BUNFIG'],
      ['.cargo/credentials.toml', 'CARGO'],
      ['.config/configstore/firebase-tools.json', 'FIREBASE'],
      ['.claude/.credentials.json', 'AGENT'],
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
    await Bun.write(path.join(ws, '.vx/workspace.mjs'), 'export default {}\n')
    await writeFile(path.join(ws, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
    // A denied file reads as empty (a /dev/null bind), a denied directory as
    // an empty one: either way grep finds no line.
    const read = (f: string): string => `grep -s . "$HOME/${f}" || echo "no ${f}"`
    const cmd = [
      '.ssh/id_ed25519',
      '.npmrc',
      '.aws/credentials',
      '.bunfig.toml',
      '.cargo/credentials.toml',
      '.config/configstore/firebase-tools.json',
      '.claude/.credentials.json',
      '.cache/tool/state',
    ]
      .map(read)
      .concat(`grep -s . "${xdg}/gh/hosts.yml" || echo "no .xdg/gh"`)
      .join('; ')
    // A write grant names a store too: on Linux a file grant binds its
    // directory, and the store's deny landed on top of the bind, so the
    // write went to /dev/null with exit 0.
    const written = [
      'echo WROTE >> "$HOME/.npmrc"',
      'echo CLI > "$HOME/.aws/config"',
      read('.npmrc'),
      read('.aws/config'),
      read('.aws/credentials'),
    ].join('; ')
    await writeFile(
      path.join(ws, 'packages', 'a', 'vx.config.mjs'),
      `export default { name: 'a', tasks: {
  peek: { exec: { command: ${JSON.stringify(cmd)}, sandbox: { allow: { read: ['.'] } } } },
  granted: { exec: { command: ${JSON.stringify(read('.npmrc'))}, sandbox: { allow: { read: ['.', '~/.npmrc'] } } } },
  written: { exec: { command: ${JSON.stringify(written)}, sandbox: { allow: { read: ['.'], write: ['~/.npmrc', '~/.aws/config'] } } } },
} }
`,
    )
    expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: ws }).exitCode).toBe(0)
    lock(ws)
    const out = (task: string): string[] => {
      const r = Bun.spawnSync({
        cmd: [process.execPath, BIN, 'run', `a#${task}`, '--output-logs', 'full'],
        cwd: ws,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const text = r.stdout.toString() + r.stderr.toString()
      expect(r.exitCode, text).toBe(0)
      return text
        .split('\n')
        .map((l) => l.replace(/^.*?│\s?/, '').trim())
        .filter((l) =>
          /^(no \.|SSHKEY|NPMRC|AWSKEY|BUNFIG|CARGO|FIREBASE|AGENT|CACHE|GHXDG|WROTE|CLI)/.test(l),
        )
    }
    expect(out('peek')).toEqual([
      'no .ssh/id_ed25519',
      'no .npmrc',
      'no .aws/credentials',
      'no .bunfig.toml',
      'no .cargo/credentials.toml',
      'no .config/configstore/firebase-tools.json',
      'no .claude/.credentials.json',
      'CACHE',
      'no .xdg/gh',
    ])
    expect(out('granted')).toEqual(['NPMRC'])
    expect(out('written')).toEqual(['NPMRC', 'WROTE', 'CLI', 'no .aws/credentials'])
    expect(await Bun.file(path.join(home, '.npmrc')).text()).toBe('NPMRC\nWROTE\n')
    expect(await Bun.file(path.join(home, '.aws/config')).text()).toBe('CLI\n')
  }, 30_000)

  it('cannot hard-link one into a granted output', async () => {
    // A hard link needs no read of its source: had the link landed in
    // `dist/`, vx (outside the sandbox) would pack the key into the cache.
    const ws = path.join(root!, 'ws')
    await writeFile(
      path.join(ws, 'packages', 'a', 'vx.config.mjs'),
      `export default { name: 'a', tasks: {
  link: {
    exec: { command: 'mkdir -p dist && ln "$HOME/.ssh/id_ed25519" dist/k || true', sandbox: { allow: { read: ['.'], write: ['dist/'] } } },
    inputs: { files: ['vx.config.mjs'] }, cache: { outputs: { files: ['dist/**'] } },
  },
  open: { exec: { command: 'mkdir -p dist && ln "$HOME/.ssh/id_ed25519" dist/k' } },
} }
`,
    )
    lock(ws)
    const linked = async (task: string): Promise<string> => {
      Bun.spawnSync({
        cmd: [process.execPath, BIN, 'run', `a#${task}`],
        cwd: ws,
        env: { ...process.env, HOME: path.join(root!, 'home') },
      })
      const k = Bun.file(path.join(ws, 'packages', 'a', 'dist', 'k'))
      return (await k.exists()) ? await k.text() : 'no link'
    }
    expect(await linked('link')).toBe('no link')
    // CONTROL: unsandboxed, the same link lands (one file system).
    expect(await linked('open')).toBe('SSHKEY\n')
  }, 30_000)
})
