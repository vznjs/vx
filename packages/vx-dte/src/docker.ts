// `docker()`: each agent a container on this machine, held to its size's
// cores and memory, in a fresh clone of `HEAD` made inside it. The relay
// is the run's own on loopback; a container reaches it through the host's
// network on Linux and through `host.docker.internal` elsewhere.

import { realpathSync } from 'node:fs'
import path from 'node:path'
import { refuseUnknownOptions, type PluginOptionKinds } from '@vzn/vx'
import { loopbackRelay } from './local.js'
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

  return {
    async relay() {
      relay = await loopbackRelay()
      return relay.url
    },

    spawn(a) {
      const git = (...args: string[]): string => {
        const r = Bun.spawnSync(['git', ...args], { cwd: a.workspaceRoot, stderr: 'pipe' })
        if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString().trim()}`)
        return r.stdout.toString().trim()
      }
      const top = git('rev-parse', '--show-toplevel')
      const sha = git('rev-parse', 'HEAD')
      // git names the real path: through a link (macOS's /tmp) the relative one climbed out.
      const rel = path.relative(top, realpathSync(a.workspaceRoot)) || '.'
      const script = [
        'set -e',
        'git clone -q /src /work',
        'cd /work',
        `git checkout -q --detach ${sha}`,
        `cd ${quote(rel)}`,
        ...(options.prepare === undefined ? [] : [options.prepare]),
        'exec ./node_modules/.bin/vx dte agent',
      ].join('\n')
      const env = {
        ...a.env,
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
          ...Object.keys(env).flatMap((k) => ['--env', k]),
          options.image,
          'sh',
          '-c',
          script,
        ],
        { env: { ...process.env, ...env }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      )
      agents.set(name, proc)
      void proc.exited.then(() => agents.delete(name))
    },

    async close() {
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
