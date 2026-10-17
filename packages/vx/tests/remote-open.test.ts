// A remote layer's `open`: asked once per run, before the first task, only
// when the policy lets the remote read or write, never by a plan; a throw
// is a warning and the remote leaves the run (owner, 2026-10-17: where
// turboCache() asks the OS keychain, or the terminal, for a token).

import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'bun:test'
import {
  addProject,
  makeWorkspace,
  NO_CACHE,
  silentLogger,
  TIMEOUT,
} from './helpers/orchestrator-fixture.js'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { planRun, run } from './helpers/orchestrator.js'

const BUILD_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'echo built > out.txt' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
      },
    },
  }
`

function opening(fail?: string): { layer: RemoteCacheLayer; calls: string[] } {
  const calls: string[] = []
  const store = new Map<string, Uint8Array>()
  return {
    calls,
    layer: {
      endpoint: 'mem://remote',
      async open(ctx) {
        calls.push(`open ci=${ctx.ci}`)
        if (fail !== undefined) throw new Error(fail)
      },
      async has(hash) {
        calls.push('has')
        return store.has(hash)
      },
      async get(hash) {
        calls.push('get')
        const bytes = store.get(hash)
        return bytes === undefined ? null : { body: new Blob([bytes]), durationMs: undefined }
      },
      async put(hash, body) {
        calls.push('put')
        store.set(hash, await body.bytes())
      },
    },
  }
}

const ALL = { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true }

describe('RemoteCacheLayer.open', () => {
  it(
    'is asked once, before any other call, with the run’s CI verdict',
    async () => {
      const fixture = await makeWorkspace('vx-remote-open-')
      const remote = opening()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const res = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: ALL,
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(res.ok).toBe(true)
        expect(remote.calls[0]).toMatch(/^open ci=(true|false)$/)
        expect(remote.calls.filter((c) => c.startsWith('open'))).toHaveLength(1)
        expect(remote.calls).toContain('put')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  for (const [name, cache] of [
    ['--no-cache', NO_CACHE],
    ['--cache-policy=remote:', { ...ALL, remoteRead: false, remoteWrite: false }],
  ] as const) {
    it(
      `is never asked under ${name}`,
      async () => {
        const fixture = await makeWorkspace('vx-remote-open-')
        const remote = opening()
        try {
          await addProject(fixture.root, 'app', {
            files: { 'src/in.txt': 'v1' },
            config: BUILD_CONFIG,
          })
          const res = await run({
            cwd: fixture.root,
            tasks: ['build'],
            cache,
            log: silentLogger(fixture),
            remoteCache: remote.layer,
          })
          expect(res.ok).toBe(true)
          expect(remote.calls).toEqual([])
        } finally {
          await rm(fixture.root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  }

  it(
    'is never asked by a plan (--dry)',
    async () => {
      const fixture = await makeWorkspace('vx-remote-open-')
      const remote = opening()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        await planRun({
          cwd: fixture.root,
          tasks: ['build'],
          cache: ALL,
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(remote.calls.some((c) => c.startsWith('open'))).toBe(false)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a throw is one warning and the remote leaves the run; the run stays green on the local cache',
    async () => {
      const fixture = await makeWorkspace('vx-remote-open-')
      const remote = opening('no token for cache.example')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const first = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: ALL,
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(first.ok).toBe(true)
        expect(first.outcomes[0]!.status).toBe('success')
        expect(remote.calls).toEqual([expect.stringMatching(/^open/)])
        expect(fixture.log.filter((l) => l.includes('no token for cache.example'))).toHaveLength(1)
        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: ALL,
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(second.outcomes[0]!.status).toBe('cache-hit')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
