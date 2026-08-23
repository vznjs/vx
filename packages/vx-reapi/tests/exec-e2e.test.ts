// The remote-execution round trip against a REAL scheduler + worker.
//
// Needs an execution-capable server; bazel-remote is cache-only, so this is a
// SECOND endpoint. Locally (NativeLink's image is distroless, so a worker in
// it has no /bin/sh — rehost the same static binary on busybox first):
//
//   see packages/vx-reapi/tests/helpers/nativelink.md for the three commands
//
// Gated exactly like the cache suite: skips without the endpoint,
// VX_REQUIRE_REAPI_EXEC=1 turns an absent endpoint into a FAILURE so CI can
// never silently drop the only proof that remote execution works.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExecuteRequest } from '@vzn/vx'
import { ReapiClient } from '../src/wire.js'
import { reapiExecutor } from '../src/executor.js'

const ENDPOINT = Bun.env['VX_REAPI_EXEC_ENDPOINT']
if (Bun.env['VX_REQUIRE_REAPI_EXEC'] === '1' && (ENDPOINT === undefined || ENDPOINT === '')) {
  throw new Error(
    'VX_REQUIRE_REAPI_EXEC=1 but VX_REAPI_EXEC_ENDPOINT is unset — the execution suite would have silently skipped.',
  )
}
const run = ENDPOINT !== undefined && ENDPOINT !== ''

describe.if(run)('remote execution against a live scheduler + worker', () => {
  const endpoint = ENDPOINT as string

  async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-exec-e2e-'))
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'hello from the submitter\n')
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  const request = (root: string, over: Partial<ExecuteRequest> = {}): ExecuteRequest =>
    ({
      taskId: 'pkg#gen',
      workspaceRoot: root,
      cwd: path.join(root, 'pkg'),
      command: 'tr a-z A-Z < src/in.txt > out.txt && echo transformed',
      forwardArgs: [],
      env: {},
      capture: { stdout: true, stderr: true },
      onStdout: () => undefined,
      onStderr: () => undefined,
      outputs: { files: ['out.txt'], workspaceFiles: [] },
      inputs: {
        files: [{ path: 'pkg/src/in.txt', digest: 'git-oid-unused' }],
        env: [],
        runtime: [],
        workspaceRuntime: [],
        upstream: [],
        packageJsonDigest: 'x',
        configDigest: 'y',
        workspaceFingerprint: 'z',
      },
      ...over,
    }) as unknown as ExecuteRequest

  it('executes on the worker and materialises the declared output, byte-correct', async () => {
    const { root, cleanup } = await fixture()
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      const caps = await client.capabilities()
      expect(caps.execEnabled).toBe(true) // precondition, not an assumption
      let stdout = ''
      const executor = reapiExecutor(client, { warn: () => undefined })
      const res = await executor.execute(
        request(root, { onStdout: (c: string) => (stdout += c) } as Partial<ExecuteRequest>),
      )
      expect(res.exitCode).toBe(0)
      expect(stdout).toContain('transformed')
      const produced = await readFile(path.join(root, 'pkg', 'out.txt'), 'utf8')
      expect(produced.trim()).toBe('HELLO FROM THE SUBMITTER')
    } finally {
      client.close()
      await cleanup()
    }
  }, 120_000)

  it('a failing command returns its exit code instead of throwing', async () => {
    // A non-zero exit is the TASK failing, which core handles; only an
    // execution-machinery failure may throw. Conflating them would turn every
    // red test remotely into an internal error.
    const { root, cleanup } = await fixture()
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      const executor = reapiExecutor(client, { warn: () => undefined })
      const res = await executor.execute(
        request(root, {
          command: 'echo boom >&2 && exit 7',
          outputs: { files: [], workspaceFiles: [] },
        }),
      )
      expect(res.exitCode).toBe(7)
      expect(res.stderr).toContain('boom')
    } finally {
      client.close()
      await cleanup()
    }
  }, 120_000)

  it('the same action twice: the second run needs no re-upload of unchanged inputs', async () => {
    // Upload minimality across executions — the FindMissingBlobs property,
    // observed at the CAS rather than asserted from code.
    const { root, cleanup } = await fixture()
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      const executor = reapiExecutor(client, { warn: () => undefined })
      await executor.execute(request(root))
      const { buildInputTree } = await import('../src/merkle.js')
      const tree = await buildInputTree({ workspaceRoot: root, paths: ['pkg/src/in.txt'] })
      const missing = await client.findMissingBlobs(tree.blobs.map((b) => b.digest))
      expect(missing.length).toBe(0)
    } finally {
      client.close()
      await cleanup()
    }
  }, 120_000)
})

describe.if(run)("the node_modules chain: remote:'only' install feeds remote builds", () => {
  const endpoint = ENDPOINT as string
  const nonce2 = `${process.pid}-${Bun.nanoseconds()}`

  const request = (root: string, over: Partial<ExecuteRequest>): ExecuteRequest =>
    ({
      taskId: 'pkg#task',
      workspaceRoot: root,
      cwd: path.join(root, 'pkg'),
      command: 'true',
      forwardArgs: [],
      env: {},
      capture: { stdout: true, stderr: true },
      onStdout: () => undefined,
      onStderr: () => undefined,
      outputs: { files: [], workspaceFiles: [] },
      ...over,
    }) as unknown as ExecuteRequest

  it('outputs flow worker→CAS→worker without ever landing on this disk', async () => {
    const { execDigestFor } = await import('../src/cache.js')
    const root = await mkdtemp(path.join(tmpdir(), 'vx-nm-'))
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
      await writeFile(path.join(root, 'pkg', 'src', 'app.js'), 'require("liba")\n')
      const executor = reapiExecutor(client, { warn: () => undefined })
      const keyA = `install-${nonce2}`

      // A: the install stand-in — remote-only, produces node_modules REMOTELY.
      const resA = await executor.execute(
        request(root, {
          taskId: 'pkg#install',
          command: 'mkdir -p node_modules/liba && echo lib-content > node_modules/liba/index.js',
          outputs: { files: ['node_modules/**'], workspaceFiles: [] },
          cacheKey: keyA,
          remoteOnly: true,
          inputs: {
            files: [],
            env: [],
            runtime: [],
            workspaceRuntime: [],
            upstream: [],
            packageJsonDigest: 'p',
            configDigest: 'c',
            workspaceFingerprint: 'w',
          },
        } as Partial<ExecuteRequest>),
      )
      expect(resA.exitCode).toBe(0)
      // THE point of remote:'only' — the submitter's disk never sees them:
      const { exists } = await import('node:fs/promises').then((m) => ({
        exists: (p: string) =>
          m.access(p).then(
            () => true,
            () => false,
          ),
      }))
      expect(await exists(path.join(root, 'pkg', 'node_modules'))).toBe(false)
      // …but the execution record is addressable by the vx key:
      const record = await client.getActionResult(execDigestFor(keyA))
      expect(record).not.toBeNull()

      // B: a dependent build — its input tree grafts A's outputs BY REFERENCE.
      let stdout = ''
      const resB = await executor.execute(
        request(root, {
          taskId: 'pkg#build',
          command: 'cat node_modules/liba/index.js > used.txt && cat used.txt',
          outputs: { files: ['used.txt'], workspaceFiles: [] },
          cacheKey: `build-${nonce2}`,
          onStdout: (c: string) => (stdout += c),
          inputs: {
            files: [{ path: 'pkg/src/app.js', digest: 'oid' }],
            env: [],
            runtime: [],
            workspaceRuntime: [],
            upstream: [{ taskId: 'pkg#install', hash: keyA, outputs: [] }],
            packageJsonDigest: 'p',
            configDigest: 'c',
            workspaceFingerprint: 'w',
          },
        } as Partial<ExecuteRequest>),
      )
      expect(resB.exitCode).toBe(0)
      expect(stdout.trim()).toBe('lib-content')
      // B is a NORMAL task: its declared output materialises locally.
      expect(await readFile(path.join(root, 'pkg', 'used.txt'), 'utf8')).toContain('lib-content')

      // A again, same key: satisfied from the execution record — Execute is
      // never called. Spied on the client method, not inferred from timing.
      let executeCalls = 0
      const origExecute = client.execute.bind(client)
      client.execute = ((...a: Parameters<typeof origExecute>) => {
        executeCalls++
        return origExecute(...a)
      }) as typeof client.execute
      const resA2 = await executor.execute(
        request(root, {
          taskId: 'pkg#install',
          command: 'echo must-not-run',
          outputs: { files: ['node_modules/**'], workspaceFiles: [] },
          cacheKey: keyA,
          remoteOnly: true,
          inputs: {
            files: [],
            env: [],
            runtime: [],
            workspaceRuntime: [],
            upstream: [],
            packageJsonDigest: 'p',
            configDigest: 'c',
            workspaceFingerprint: 'w',
          },
        } as Partial<ExecuteRequest>),
      )
      expect(resA2.exitCode).toBe(0)
      expect(executeCalls).toBe(0)
    } finally {
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})

describe.if(run)('chaining robustness (audit fixes)', () => {
  const endpoint = ENDPOINT as string
  const n3 = `${process.pid}-${Bun.nanoseconds()}`

  const req3 = (root: string, over: Partial<ExecuteRequest>): ExecuteRequest =>
    ({
      taskId: 'pkg#t',
      workspaceRoot: root,
      cwd: path.join(root, 'pkg'),
      command: 'true',
      forwardArgs: [],
      env: {},
      capture: { stdout: true, stderr: true },
      onStdout: () => undefined,
      onStderr: () => undefined,
      outputs: { files: [], workspaceFiles: [] },
      inputs: {
        files: [],
        env: [],
        runtime: [],
        workspaceRuntime: [],
        upstream: [],
        packageJsonDigest: 'p',
        configDigest: 'c',
        workspaceFingerprint: 'w',
      },
      ...over,
    }) as unknown as ExecuteRequest

  it('refresh (--force) bypasses the execution record and re-executes', async () => {
    const { execDigestFor } = await import('../src/cache.js')
    const root = await mkdtemp(path.join(tmpdir(), 'vx-refresh-'))
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      await mkdir(path.join(root, 'pkg'), { recursive: true })
      const executor = reapiExecutor(client, { warn: () => undefined })
      const key = `refresh-${n3}`
      await executor.execute(req3(root, { command: 'echo one', cacheKey: key, remoteOnly: true }))
      expect(await client.getActionResult(execDigestFor(key))).not.toBeNull()
      // Without refresh: served from the record, zero Execute calls (control).
      let calls = 0
      const orig = client.execute.bind(client)
      client.execute = ((...a: Parameters<typeof orig>) => {
        calls++
        return orig(...a)
      }) as typeof client.execute
      await executor.execute(req3(root, { command: 'echo two', cacheKey: key, remoteOnly: true }))
      expect(calls).toBe(0)
      // With refresh: the record must NOT satisfy it — a private cache that
      // ignores --force is still a cache.
      await executor.execute(
        req3(root, { command: 'echo three', cacheKey: key, remoteOnly: true, refresh: true }),
      )
      expect(calls).toBe(1)
    } finally {
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('an execution record with evicted blobs demotes to local outputs instead of a worker error', async () => {
    const { execDigestFor, digestOf } = await import('../src/cache.js')
    const root = await mkdtemp(path.join(tmpdir(), 'vx-evict-'))
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      await mkdir(path.join(root, 'pkg', 'gen'), { recursive: true })
      // The upstream's outputs ARE on local disk (it ran locally)…
      await writeFile(path.join(root, 'pkg', 'gen', 'data.txt'), 'local-truth\n')
      // …but a stale record exists whose blob was never uploaded (an
      // eviction, compressed into one step: a digest of content the CAS has
      // never seen).
      const key = `evicted-${n3}`
      const phantom = digestOf(new TextEncoder().encode(`never-uploaded-${n3}`))
      await client.updateActionResult(execDigestFor(key), {
        exit_code: 0,
        output_files: [{ path: 'pkg/gen/data.txt', digest: phantom, is_executable: false }],
      })
      const warns: string[] = []
      const executor = reapiExecutor(client, { warn: (m) => warns.push(m) })
      let stdout = ''
      const res = await executor.execute(
        req3(root, {
          command: 'cat gen/data.txt',
          cacheKey: `dep-${n3}`,
          onStdout: (c: string) => (stdout += c),
          inputs: {
            files: [],
            env: [],
            runtime: [],
            workspaceRuntime: [],
            upstream: [{ taskId: 'pkg#up', hash: key, outputs: ['pkg/gen/data.txt'] }],
            packageJsonDigest: 'p',
            configDigest: 'c',
            workspaceFingerprint: 'w',
          },
        }),
      )
      expect(res.exitCode).toBe(0)
      expect(stdout.trim()).toBe('local-truth') // the fallback carried the day
      expect(warns.some((w) => w.includes('evicted blob'))).toBe(true)
    } finally {
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
