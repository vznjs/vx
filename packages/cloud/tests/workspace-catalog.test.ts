// The workspace catalog (cloud-data-model-2026-07 §6): lock-first / live
// fallback resolution, staleness flagging, mtime-keyed memoization, and the
// serve's /v1/workspace/* routes (colocated-only, bearer-gated).

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadProjectConfig } from '@vzn/vx'
import { WorkspaceCatalog } from '../src/workspace-catalog.js'
import { startServe } from '../src/cli/serve.js'
import { serveInfoPath } from '../src/serve-info.js'

const CORE_BIN = path.join(import.meta.dir, '..', '..', '..', 'src', 'bin.ts')

// Isolate the per-user serve advertisement (same guard as serve.test.ts).
const prevServeInfo = process.env['VX_CLOUD_SERVE_INFO']
beforeAll(() => {
  process.env['VX_CLOUD_SERVE_INFO'] = path.join(
    tmpdir(),
    `vx-serveinfo-catalog-${process.pid}.json`,
  )
})
afterAll(async () => {
  await rm(serveInfoPath(), { force: true })
  if (prevServeInfo === undefined) delete process.env['VX_CLOUD_SERVE_INFO']
  else process.env['VX_CLOUD_SERVE_INFO'] = prevServeInfo
})

/** Two configured packages; no git needed — the catalog reads configs only. */
async function makeCatalogWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-catalog-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'catalog-root', workspaces: ['packages/*'] }),
  )
  await mkdir(path.join(root, 'packages', 'app'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'app', 'package.json'),
    JSON.stringify({ name: '@demo/app', version: '1.0.0' }),
  )
  await writeFile(
    path.join(root, 'packages', 'app', 'vx.config.mjs'),
    [
      'export default {',
      '  tasks: {',
      '    build: {',
      "      description: 'compile the app',",
      "      exec: { command: 'echo build' },",
      "      dependsOn: ['^build'],",
      "      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },",
      '    },',
      "    dev: { exec: { command: 'sleep 30', persistent: { readyWhen: 'up' } } },",
      "    ci: { dependsOn: ['build'] },",
      '  },',
      '}',
      '',
    ].join('\n'),
  )
  await mkdir(path.join(root, 'packages', 'lib'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'lib', 'package.json'),
    JSON.stringify({ name: '@demo/lib', version: '1.0.0' }),
  )
  await writeFile(
    path.join(root, 'packages', 'lib', 'vx.config.mjs'),
    ["export default { tasks: { build: { exec: { command: 'echo lib' } } } }", ''].join('\n'),
  )
  return root
}

/** Freeze the fixture's configs with the real CLI — the lock `vx lock` writes. */
function lockWorkspace(root: string): void {
  const res = spawnSync('bun', [CORE_BIN, 'lock'], { cwd: root, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`vx lock failed: ${res.stderr}`)
}

async function getJson(origin: string, p: string, token?: string): Promise<Response> {
  return fetch(`${origin}${p}`, {
    ...(token !== undefined ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  })
}

describe('workspace catalog — serve routes', () => {
  it('live fallback without a lock, then lock-backed with an identical payload', async () => {
    const root = await makeCatalogWorkspace()
    const server = await startServe({ root })
    try {
      // No lock yet → the live loader chain.
      const live = (await (await getJson(server.origin, '/v1/workspace/projects')).json()) as {
        source: string
        root: string
        workspaceId: string
        lockedAt?: number
        staleProjects?: string[]
        projects: { name: string; dir: string; configPath: string; tasks: string[] }[]
      }
      expect(live.source).toBe('live')
      expect(live.root).toBe(root)
      expect(live.workspaceId).toMatch(/^[0-9a-f]{16}$/)
      expect(live.lockedAt).toBeUndefined()
      expect(live.staleProjects).toBeUndefined()
      expect(live.projects.map((p) => p.name)).toEqual(['@demo/app', '@demo/lib'])
      const app = live.projects[0]!
      expect(app.dir).toBe('packages/app')
      expect(app.configPath).toBe('packages/app/vx.config.mjs')
      expect(app.tasks).toEqual(['build', 'dev', 'ci'])

      // Freeze the same fixture — the payload flips to lock mode, projects
      // byte-equal (the lock stores exactly what the live eval resolved).
      lockWorkspace(root)
      const locked = (await (await getJson(server.origin, '/v1/workspace/projects')).json()) as {
        source: string
        lockedAt?: number
        staleProjects?: string[]
        projects: unknown[]
      }
      expect(locked.source).toBe('lock')
      expect(typeof locked.lockedAt).toBe('number')
      expect(locked.staleProjects).toEqual([])
      expect(locked.projects).toEqual(live.projects)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serves one project detail with its resolved config; unknown → 404 naming it', async () => {
    const root = await makeCatalogWorkspace()
    lockWorkspace(root)
    const server = await startServe({ root })
    try {
      const res = await getJson(
        server.origin,
        `/v1/workspace/projects/${encodeURIComponent('@demo/app')}`,
      )
      expect(res.status).toBe(200)
      const detail = (await res.json()) as {
        source: string
        name: string
        dir: string
        stale?: boolean
        config: { tasks: Record<string, { exec?: { command: string } }> }
      }
      expect(detail.source).toBe('lock')
      expect(detail.name).toBe('@demo/app')
      expect(detail.dir).toBe('packages/app')
      expect(detail.stale).toBeUndefined()
      expect(detail.config.tasks['build']!.exec!.command).toBe('echo build')

      const bogus = await getJson(server.origin, '/v1/workspace/projects/nope')
      expect(bogus.status).toBe(404)
      expect(((await bogus.json()) as { error: string }).error).toBe('unknown project: nope')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serves the flat task index with serve-derived booleans', async () => {
    const root = await makeCatalogWorkspace()
    const server = await startServe({ root })
    try {
      const body = (await (await getJson(server.origin, '/v1/workspace/tasks')).json()) as {
        source: string
        tasks: {
          id: string
          project: string
          task: string
          description?: string
          group: boolean
          cacheable: boolean
          persistent: boolean
          dependsOn: string[]
        }[]
      }
      expect(body.source).toBe('live')
      const byId = new Map(body.tasks.map((t) => [t.id, t]))
      expect([...byId.keys()].sort()).toEqual([
        '@demo/app#build',
        '@demo/app#ci',
        '@demo/app#dev',
        '@demo/lib#build',
      ])
      const build = byId.get('@demo/app#build')!
      expect(build).toMatchObject({
        project: '@demo/app',
        task: 'build',
        description: 'compile the app',
        group: false,
        cacheable: true,
        persistent: false,
        dependsOn: ['^build'],
      })
      const ci = byId.get('@demo/app#ci')!
      expect(ci.group).toBe(true)
      expect(ci.cacheable).toBe(false)
      expect(ci.dependsOn).toEqual(['build'])
      const dev = byId.get('@demo/app#dev')!
      expect(dev.persistent).toBe(true)
      expect(dev.group).toBe(false)
      expect(dev.dependsOn).toEqual([])
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('flags projects whose config drifted since the lock', async () => {
    const root = await makeCatalogWorkspace()
    lockWorkspace(root)
    // Drift ONE config after locking.
    await writeFile(
      path.join(root, 'packages', 'app', 'vx.config.mjs'),
      ["export default { tasks: { build: { exec: { command: 'echo CHANGED' } } } }", ''].join('\n'),
    )
    const server = await startServe({ root })
    try {
      const list = (await (await getJson(server.origin, '/v1/workspace/projects')).json()) as {
        source: string
        staleProjects?: string[]
      }
      expect(list.source).toBe('lock')
      expect(list.staleProjects).toEqual(['@demo/app'])

      const app = (await (
        await getJson(server.origin, `/v1/workspace/projects/${encodeURIComponent('@demo/app')}`)
      ).json()) as { stale?: boolean; config: { tasks: Record<string, unknown> } }
      expect(app.stale).toBe(true)
      // The response never silently mixes lock + live: the config stays the
      // FROZEN one; staleness is a label.
      expect(Object.keys(app.config.tasks)).toEqual(['build', 'dev', 'ci'])

      const lib = (await (
        await getJson(server.origin, `/v1/workspace/projects/${encodeURIComponent('@demo/lib')}`)
      ).json()) as { stale?: boolean }
      expect(lib.stale).toBeUndefined()
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('404s all three routes on a serve with no colocated workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-nows-'))
    const server = await startServe({ root })
    try {
      for (const p of [
        '/v1/workspace/projects',
        '/v1/workspace/projects/x',
        '/v1/workspace/tasks',
      ]) {
        const res = await getJson(server.origin, p)
        expect(res.status).toBe(404)
        expect(((await res.json()) as { error: string }).error).toBe('no colocated workspace')
      }
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is bearer-gated on a token-carrying serve', async () => {
    const root = await makeCatalogWorkspace()
    const server = await startServe({ root, token: 'sekret' })
    try {
      const noToken = await getJson(server.origin, '/v1/workspace/projects')
      expect(noToken.status).toBe(401)
      const withToken = await getJson(server.origin, '/v1/workspace/projects', 'sekret')
      expect(withToken.status).toBe(200)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('advertises catalog availability on /v1/meta', async () => {
    const withWs = await makeCatalogWorkspace()
    const without = await mkdtemp(path.join(tmpdir(), 'vx-nows-meta-'))
    const a = await startServe({ root: withWs })
    const b = await startServe({ root: without })
    try {
      const metaA = (await (await fetch(`${a.origin}/v1/meta`)).json()) as { catalog: boolean }
      expect(metaA.catalog).toBe(true)
      const metaB = (await (await fetch(`${b.origin}/v1/meta`)).json()) as { catalog: boolean }
      expect(metaB.catalog).toBe(false)
    } finally {
      await a.stop()
      await b.stop()
      await rm(withWs, { recursive: true, force: true })
      await rm(without, { recursive: true, force: true })
    }
  })
})

describe('WorkspaceCatalog — memoization', () => {
  it('a second resolve re-evaluates nothing; a touched config re-evaluates only itself', async () => {
    const root = await makeCatalogWorkspace()
    const evals: string[] = []
    const catalog = new WorkspaceCatalog(root, {
      evalConfig: (p) => {
        evals.push(path.relative(root, p))
        return loadProjectConfig(p)
      },
    })
    try {
      const first = await catalog.resolve()
      expect(first?.source).toBe('live')
      expect(evals.sort()).toEqual(['packages/app/vx.config.mjs', 'packages/lib/vx.config.mjs'])

      // Warm request: stat-only, zero evals.
      evals.length = 0
      const second = await catalog.resolve()
      expect(second?.projects.map((p) => p.name)).toEqual(['@demo/app', '@demo/lib'])
      expect(evals).toEqual([])

      // A changed file invalidates its OWN entry only.
      await writeFile(
        path.join(root, 'packages', 'lib', 'vx.config.mjs'),
        ["export default { tasks: { build: { exec: { command: 'echo lib2' } } } }", ''].join('\n'),
      )
      evals.length = 0
      const third = await catalog.resolve()
      expect(evals).toEqual(['packages/lib/vx.config.mjs'])
      const lib = third?.projects.find((p) => p.name === '@demo/lib')
      expect(lib?.config.tasks?.['build']?.exec?.command).toBe('echo lib2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
