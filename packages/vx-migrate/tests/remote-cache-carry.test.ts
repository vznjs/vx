// A remote cache the repo shows is declared in the workspace file a
// migration writes, native or keep, whether `vx init` handed over or the
// user ran `bunx @vzn/vx-migrate` (2026-10-14). Nx Cloud is a wire vx
// does not speak: said, not declared.

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_BIN = path.join(path.dirname(Bun.resolveSync('@vzn/vx', import.meta.dir)), 'bin.ts')
const TIMEOUT = 60_000

async function repo(runner: 'turbo' | 'nx', files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-remote-carry-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  await writeFile(path.join(root, 'package.json'), '{"name":"r","private":true}\n')
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'a', 'package.json'),
    JSON.stringify({ name: 'a', scripts: { build: 'tsc' } }),
  )
  if (runner === 'turbo') await writeFile(path.join(root, 'turbo.json'), '{"tasks":{"build":{}}}')
  else {
    await writeFile(path.join(root, 'nx.json'), '{}\n')
    await Bun.write(
      path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
      JSON.stringify({
        nodes: {
          a: { name: 'a', data: { root: 'packages/a', targets: { build: { command: 'tsc' } } } },
        },
        dependencies: {},
      }),
    )
  }
  for (const [f, text] of Object.entries(files)) await Bun.write(path.join(root, f), text)
  // `vx init` hands over to the installed vx-migrate: this package.
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  await symlink(
    path.resolve(import.meta.dir, '..'),
    path.join(root, 'node_modules', '@vzn', 'vx-migrate'),
  )
  const bin = path.join(root, '.fake-bin')
  await mkdir(bin)
  await writeFile(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n')
  await chmod(path.join(bin, 'pnpm'), 0o755)
  const env = { ...process.env, PATH: `${bin}:${process.env['PATH']}` } as Record<string, string>
  return { root, env }
}

async function run(root: string, env: Record<string, string>, argv: string[]) {
  const proc = Bun.spawn([process.execPath, '--no-install', ...argv], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

/**
 * Per entry point and mode: the exit, the cache plugin the written
 * workspace file imports, and the report's line about the remote cache.
 */
async function carried(runner: 'turbo' | 'nx', files: Record<string, string>) {
  const rows: Record<string, unknown> = {}
  for (const [entry, argv] of [
    ['vx init', [CORE_BIN, 'init']],
    ['vx-migrate', [BIN]],
  ] as const) {
    for (const mode of ['--native', '--keep']) {
      const { root, env } = await repo(runner, files)
      try {
        const r = await run(root, env, [...argv, mode, '--dry'])
        rows[`${entry} ${mode}`] = [
          r.code,
          [...r.out.matchAll(/^import \{ (\w*Cache) \} from '@vzn\/vx-migrate'$|, (\w*Cache) \}/gm)]
            .map((m) => m[1] ?? m[2])
            .filter((x) => x !== undefined),
          r.out
            .split('\n')
            .filter((l) => /remote cache|Nx Cloud/.test(l))
            .map((l) => l.slice(12)),
        ]
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
  return rows
}

const every = (row: unknown) => ({
  'vx init --native': row,
  'vx init --keep': row,
  'vx-migrate --native': row,
  'vx-migrate --keep': row,
})

const SHARES = (factory: string, why: string) =>
  `${factory}(): ${why}, so vx shares that remote cache (token: the variable, else the OS keychain).`

describe('a remote cache the repo shows is carried into the workspace file', () => {
  it(
    "turbo.json's remoteCache",
    async () => {
      expect(await carried('turbo', { 'turbo.json': '{"remoteCache":{"teamId":"t"}}' })).toEqual(
        every([0, ['turboCache'], [SHARES('turboCache', 'turbo.json names a remoteCache')]]),
      )
    },
    TIMEOUT,
  )

  it(
    'a team `turbo link` wrote to .turbo/config.json',
    async () => {
      expect(await carried('turbo', { '.turbo/config.json': '{"teamid":"team_1"}' })).toEqual(
        every([
          0,
          ['turboCache'],
          [SHARES('turboCache', '.turbo/config.json links a team (turbo link)')],
        ]),
      )
    },
    TIMEOUT,
  )

  it(
    'TURBO_TOKEN set in CI',
    async () => {
      const ci = { '.github/workflows/ci.yml': 'env:\n  TURBO_TOKEN: ${{ secrets.T }}\n' }
      expect(await carried('turbo', ci)).toEqual(
        every([
          0,
          ['turboCache'],
          [SHARES('turboCache', '.github/workflows/ci.yml sets TURBO_TOKEN')],
        ]),
      )
    },
    TIMEOUT,
  )

  it(
    "Nx's self-hosted cache variable set in CI",
    async () => {
      const ci = {
        '.gitlab-ci.yml': 'variables:\n  NX_SELF_HOSTED_REMOTE_CACHE_SERVER: https://c\n',
      }
      expect(await carried('nx', ci)).toEqual(
        every([
          0,
          ['nxCache'],
          [SHARES('nxCache', '.gitlab-ci.yml sets NX_SELF_HOSTED_REMOTE_CACHE_SERVER')],
        ]),
      )
    },
    TIMEOUT,
  )

  it(
    'Nx Cloud: no cache plugin, and the note says why',
    async () => {
      expect(await carried('nx', { 'nx.json': '{"nxCloudId":"abc"}' })).toEqual(
        every([
          0,
          [],
          [
            'nx.json connects Nx Cloud, whose cache vx cannot share: runs cache on this machine (nxCache() serves a self-hosted Nx cache).',
          ],
        ]),
      )
    },
    TIMEOUT,
  )
})
