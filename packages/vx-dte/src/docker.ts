// `docker()`: each agent a container on this machine, held to its size's
// cores and memory, in a fresh clone made inside it of the tracked files
// as the run sees them, sharing this machine's store. The relay
// is the run's own on loopback; a container reaches it through the host's
// network on Linux and through `host.docker.internal` elsewhere.

import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { refuseUnknownOptions, type PluginOptionKinds } from '@vzn/vx'
import { loopbackRelay, reasons } from './local.js'
import type { DteAdapter } from './plugin.js'

export interface DockerOptions {
  /** An image with Bun and git, such as one built `FROM oven/bun` with git added. */
  readonly image: string
  /** A shell line the clone runs before its agent starts, such as `bun install`. */
  readonly prepare?: string
}

const KEYS: PluginOptionKinds<DockerOptions> = { image: 'string', prepare: 'string' }

export function docker(options: DockerOptions): DteAdapter {
  refuseUnknownOptions('docker()', options, KEYS)
  if (typeof options.image !== 'string' || options.image === '') {
    throw new Error("docker() needs image: one with Bun and git, such as 'oven/bun:1.4' plus git")
  }
  let relay: { url: string; stop(): void } | undefined
  const agents = new Map<string, ReturnType<typeof Bun.spawn>>()
  const linux = process.platform === 'linux'
  let tree: Promise<{ commit: string }> | undefined
  let closed = false
  const why = reasons()

  return {
    async relay() {
      relay = await loopbackRelay()
      return relay.url
    },

    async spawn(a) {
      const git = (...args: string[]): string => {
        const r = Bun.spawnSync(['git', ...args], { cwd: a.workspaceRoot, stderr: 'pipe' })
        if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString().trim()}`)
        return r.stdout.toString().trim()
      }
      const top = git('rev-parse', '--show-toplevel')
      // The tracked files as the run sees them, uncommitted changes too: a
      // clone holds only refs, so the commit is fetched by its id.
      tree ??= import('./tree.js').then((m) => m.snapshot(a.workspaceRoot))
      const sha = git('rev-parse', (await tree).commit)
      // git names the real path: through a link (macOS's /tmp) the relative one climbed out.
      const rel = path.relative(top, realpathSync(a.workspaceRoot)) || '.'
      // The store is keyed by the repository's identity, its origin: the
      // clone's would be /src, a store of its own the run never reads.
      const origin = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], {
        cwd: a.workspaceRoot,
        stderr: 'ignore',
      })
        .stdout.toString()
        .trim()
      const script = [
        'set -e',
        'git clone -q /src /work',
        'cd /work',
        origin === '' ? 'git remote remove origin' : `git remote set-url origin ${quote(origin)}`,
        `git fetch -q --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' /src ${sha}`,
        `git checkout -q --detach ${sha}`,
        `cd ${quote(rel)}`,
        ...(options.prepare === undefined ? [] : [options.prepare]),
        'exec ./node_modules/.bin/vx dte agent',
      ].join('\n')
      // This machine's store and cache dir at their own paths, as local()'s
      // agents share them: what an agent saves, the run reads.
      const home = process.env['HOME'] || homedir()
      const store = path.join(home, '.vx')
      mkdirSync(store, { recursive: true })
      const mounts = [store]
      const cacheDir = process.env['VX_CACHE_DIR']
      const cacheEnv: Record<string, string> = {}
      if (cacheDir !== undefined && cacheDir.trim() !== '') {
        const abs =
          cacheDir === '~' || cacheDir.startsWith('~/')
            ? path.join(home, cacheDir.slice(1))
            : path.resolve(a.workspaceRoot, cacheDir)
        mkdirSync(abs, { recursive: true })
        mounts.push(abs)
        cacheEnv['VX_CACHE_DIR'] = abs
      }
      const env = {
        ...a.env,
        HOME: home,
        ...cacheEnv,
        ...(linux ? {} : { VX_DTE_RELAY: a.relay.replace('127.0.0.1', 'host.docker.internal') }),
        // The checkout is the host's, owned by another user than the container's.
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '*',
      }
      const name = `vx-dte-${process.pid}-${a.index}`
      const proc = Bun.spawn(
        [
          'docker',
          'run',
          '--rm',
          '--name',
          name,
          '--cpus',
          String(a.cpu),
          '--memory',
          `${a.memory}b`,
          ...(linux ? ['--network', 'host'] : []),
          '--volume',
          `${top}:/src:ro`,
          ...mounts.flatMap((m) => ['--volume', `${m}:${m}`]),
          ...Object.keys(env).flatMap((k) => ['--env', k]),
          options.image,
          'sh',
          '-c',
          script,
        ],
        { env: { ...process.env, ...env }, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
      )
      agents.set(name, proc)
      void (async () => {
        const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
        agents.delete(name)
        if (code !== 0 && !closed) a.exited(await why(`exited ${code}`, a.id, err))
      })()
    },

    async close() {
      closed = true
      // The relay closing the run tells each agent to leave; a container
      // still up after the grace is removed.
      relay?.stop()
      relay = undefined
      const left = [...agents]
      await Promise.race([Promise.all(left.map(([, p]) => p.exited)), Bun.sleep(2_000)])
      const up = left.filter(([name]) => agents.has(name)).map(([name]) => name)
      if (up.length > 0)
        Bun.spawnSync(['docker', 'rm', '-f', ...up], { stdout: 'ignore', stderr: 'ignore' })
    },
  }
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`
