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
      envDefine: {},
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
      // Worker attribution: the executor reports where the command ran.
      expect(typeof res.where).toBe('string')
      expect((res.where as string).length).toBeGreaterThan(0)
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
      envDefine: {},
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
      envDefine: {},
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

  it('COHERENCE: local outputs win over a DIVERGENT execution record', async () => {
    // Two machines racing a nondeterministic miss can leave the artifact
    // store and the execution record holding results of DIFFERENT executions
    // under one pure-input key. When the upstream's outputs are materialised
    // on THIS machine, the worker must see THOSE bytes — not the record's —
    // or vx disagrees with itself on a single machine.
    const { execDigestFor, digestOf } = await import('../src/cache.js')
    const root = await mkdtemp(path.join(tmpdir(), 'vx-coherence-'))
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      await mkdir(path.join(root, 'pkg', 'gen'), { recursive: true })
      await writeFile(path.join(root, 'pkg', 'gen', 'data.txt'), 'local-truth\n')
      // A divergent record whose content IS present in CAS — so if the graft
      // were consulted, the action would SUCCEED with the wrong bytes. That
      // is what makes this a coherence probe rather than an eviction probe.
      const key = `diverged-${n3}`
      const remoteBytes = new TextEncoder().encode('remote-divergent\n')
      const remoteDigest = digestOf(remoteBytes)
      await client.batchUpdateBlobs([{ digest: remoteDigest, data: remoteBytes }])
      await client.updateActionResult(execDigestFor(key), {
        exit_code: 0,
        output_files: [{ path: 'pkg/gen/data.txt', digest: remoteDigest, is_executable: false }],
      })
      const executor = reapiExecutor(client, { warn: () => undefined })
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
      expect(stdout.trim()).toBe('local-truth')
    } finally {
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('an upstream whose blobs are evicted REFUSES instead of shipping a different build', async () => {
    // The graft branch runs only when nothing is local, so an evicted blob
    // has no local path to fall back to: the declared upstream's outputs
    // exist nowhere. Shipping the action anyway is the WRONG-RESULT class,
    // not a degraded one — this consumer tolerates the absence, exits 0, and
    // vx would cache "absent" under a key asserting the upstream's bytes
    // were present. Both arms run the SAME command and differ only in
    // whether the blob is in the CAS; the control is what keeps the refusal
    // from degenerating into "refuse everything".
    const { execDigestFor, digestOf } = await import('../src/cache.js')
    const root = await mkdtemp(path.join(tmpdir(), 'vx-evict2-'))
    const client = new ReapiClient({ endpoint })
    const upstreamOf = (hash: string) => ({
      files: [],
      env: [],
      runtime: [],
      workspaceRuntime: [],
      upstream: [{ taskId: 'pkg#up', hash, outputs: [] }],
      packageJsonDigest: 'p',
      configDigest: 'c',
      workspaceFingerprint: 'w',
    })
    try {
      await client.negotiate()
      await mkdir(path.join(root, 'pkg'), { recursive: true })
      const executor = reapiExecutor(client, { warn: () => undefined })
      const command = 'cat gen/data.txt 2>/dev/null || echo absent'

      // CONTROL: the blob IS in the CAS — the graft feeds the real bytes.
      const bytes = new TextEncoder().encode('REAL\n')
      const digest = digestOf(bytes)
      await client.batchUpdateBlobs([{ digest, data: bytes }])
      const liveKey = `live-${n3}`
      await client.updateActionResult(execDigestFor(liveKey), {
        exit_code: 0,
        output_files: [{ path: 'pkg/gen/data.txt', digest, is_executable: false }],
      })
      let live = ''
      const ok = await executor.execute(
        req3(root, {
          command,
          cacheKey: `c-live-${n3}`,
          onStdout: (c: string) => (live += c),
          inputs: upstreamOf(liveKey),
        }),
      )
      expect(ok.exitCode).toBe(0)
      expect(live.trim()).toBe('REAL')

      // The defect: same command, blob evicted. Before the refusal this
      // returned exit 0 with 'absent' — a successful, silently wrong build.
      const goneKey = `gone-${n3}`
      await client.updateActionResult(execDigestFor(goneKey), {
        exit_code: 0,
        output_files: [
          {
            path: 'pkg/gen/data.txt',
            digest: digestOf(new TextEncoder().encode(`never-uploaded-${n3}`)),
            is_executable: false,
          },
        ],
      })
      // try/catch, NOT `await expect(...).rejects.toThrow()`. MEASURED here:
      // the `rejects` form leaves this call unresolved for exactly 30 s and
      // pins a DEADLINE_EXCEEDED that reads like a transport bug (5/5), while
      // awaiting it directly settles in ~2 ms (3/3). That is the signature of
      // the node:http2 inbound-frame stall the CI workflow documents
      // (oven-sh/bun#39796) — same 30 s gRPC deadline, and the reason that job
      // runs one process per test file. Why this await shape reproduces it
      // deterministically is NOT established; binding the promise first does
      // not help, and integrity.test.ts uses `rejects` on the same client
      // without stalling. Do not "simplify" this back.
      let refusal = 'NONE'
      try {
        await executor.execute(
          req3(root, {
            command,
            cacheKey: `c-gone-${n3}`,
            inputs: upstreamOf(goneKey),
          }),
        )
      } catch (e) {
        refusal = e instanceof Error ? e.message : String(e)
      }
      expect(refusal).toMatch(/never materialised locally/)
    } finally {
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('a first-segment wildcard maps to the whole-working-directory capture', async () => {
    // REAPI has no glob wire: `*.js` cannot be sent as-is, and sending
    // NOTHING would silently lose the outputs. globToOutputPath maps it to
    // '' — the spec sanctions that spelling only for the deprecated
    // output_directories field ("the entire working directory tree,
    // including inputs"), so this pins that a real worker honors it on the
    // v2.1 output_paths field too. Whole-tree capture is also the closest
    // parity with a LOCAL run, where everything the command writes stays
    // on disk: the undeclared sibling comes back alongside the declared
    // match, and the cache stays narrow because save re-globs the declared
    // patterns from disk afterwards.
    const root = await mkdtemp(path.join(tmpdir(), 'vx-exec-e2e-'))
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'seed\n')
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      const executor = reapiExecutor(client, { warn: () => undefined })
      const res = await executor.execute(
        req3(root, {
          command: 'echo AA > a.js && echo BB > b.txt',
          outputs: { files: ['*.js'], workspaceFiles: [] },
          inputs: {
            files: [{ path: 'pkg/src/in.txt', digest: 'x' }],
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
      expect(res.exitCode).toBe(0)
      expect((await readFile(path.join(root, 'pkg', 'a.js'), 'utf8')).trim()).toBe('AA')
      expect((await readFile(path.join(root, 'pkg', 'b.txt'), 'utf8')).trim()).toBe('BB')
      expect((await readFile(path.join(root, 'pkg', 'src', 'in.txt'), 'utf8')).trim()).toBe('seed')
    } finally {
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  // The action digest is what a server matches to serve a cached result, so
  // it has to be a function of the task's CONTENT and nothing else. If a host
  // path or a declaration order leaked into it, every run would still succeed
  // — it would just miss on the server, forever, silently. That is the whole
  // value of a remote cache degrading with no symptom, so it gets a tripwire.
  const actionIdFor = async (
    root: string,
    over: Partial<ExecuteRequest>,
  ): Promise<string | undefined> => {
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      await reapiExecutor(client, { warn: () => undefined }).execute(req3(root, over))
      return client.actionId
    } finally {
      client.close()
    }
  }

  const seeded = async (body: string): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-exec-e2e-'))
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), body)
    return root
  }

  it('a record read that FAILS degrades to a miss — the task executes, it does not fail', async () => {
    // The execution record is a shortcut past the worker, so a transport
    // failure reading it means "no usable record", never "this task failed".
    // Core's standing rule is that a remote cache error degrades to a MISS;
    // an executor that propagates one turns a degraded server into a red
    // build. Observed for real against a NativeLink that had stopped
    // answering AC hits: every task died on the deadline instead of re-running.
    const root = await mkdtemp(path.join(tmpdir(), 'vx-exec-e2e-'))
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'seed\n')
    const client = new ReapiClient({ endpoint })
    const warns: string[] = []
    try {
      await client.negotiate()
      // Only the record read fails; everything else is the real client.
      let reads = 0
      client.getActionResult = async () => {
        reads++
        throw Object.assign(new Error('14 UNAVAILABLE: simulated'), { code: 14 })
      }
      const executor = reapiExecutor(client, { warn: (m) => warns.push(m) })
      const res = await executor.execute(
        req3(root, {
          command: 'tr a-z A-Z < src/in.txt > out.txt',
          outputs: { files: ['out.txt'], workspaceFiles: [] },
          cacheKey: 'deadbeefdeadbeef',
          inputs: {
            files: [{ path: 'pkg/src/in.txt', digest: 'unused' }],
            env: [],
            runtime: [],
            workspaceRuntime: [],
            upstream: [],
            packageJsonDigest: 'x',
            configDigest: 'y',
            workspaceFingerprint: 'z',
          },
        } as Partial<ExecuteRequest>),
      )
      expect(reads).toBeGreaterThan(0)
      expect(res.exitCode).toBe(0)
      expect((await readFile(path.join(root, 'pkg', 'out.txt'), 'utf8')).trim()).toBe('SEED')
      // Degraded, not silent: the run says why it did the work.
      expect(warns.some((w) => /execution record/.test(w))).toBe(true)
    } finally {
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  // NOT PINNED HERE, deliberately. The client-side execute bound IS verified —
  // with it, an unfinishable action rejects in 4 051 ms naming the bound;
  // without it, the same case runs until bun kills the test at 120 s. But the
  // pin cannot live in this fixture: aborting the client does not kill the
  // worker's process, so the abandoned command keeps this single-worker
  // server's only slot, and by the time the test runs alongside its siblings
  // even a 60 s metadata deadline expires. A stub-client unit test is the
  // right home for it; until then the behaviour is exercised by hand.

  it('the action digest is content-addressed: same task, two different checkout paths', async () => {
    const a = await seeded('same bytes\n')
    const b = await seeded('same bytes\n')
    try {
      const spec: Partial<ExecuteRequest> = {
        command: 'tr a-z A-Z < src/in.txt > out.txt',
        outputs: { files: ['out.txt'], workspaceFiles: [] },
        inputs: {
          files: [{ path: 'pkg/src/in.txt', digest: 'unused' }],
          env: [],
          runtime: [],
          workspaceRuntime: [],
          upstream: [],
          packageJsonDigest: 'x',
          configDigest: 'y',
          workspaceFingerprint: 'z',
        },
      } as Partial<ExecuteRequest>
      const idA = await actionIdFor(a, spec)
      const idB = await actionIdFor(b, spec)
      expect(idA).toBeDefined()
      // Two checkouts at different absolute paths must address the same
      // action, or no two machines ever share a remote result.
      expect(idB).toBe(idA)

      // CONTROL: the pin must not be vacuous. Different input bytes, same
      // everything else, must land on a DIFFERENT action.
      const c = await seeded('other bytes\n')
      try {
        expect(await actionIdFor(c, spec)).not.toBe(idA)
      } finally {
        await rm(c, { recursive: true, force: true })
      }
    } finally {
      await rm(a, { recursive: true, force: true })
      await rm(b, { recursive: true, force: true })
    }
  }, 180_000)

  it('env declaration ORDER does not move the action digest', async () => {
    // The proto requires environment_variables sorted by name so equivalent
    // Commands hash alike; `encodeCommand` owns that and encoding.test.ts
    // pins it byte-for-byte. This is the SYSTEM-level version: two configs
    // identical in meaning but declared in different order must address the
    // SAME action, however the bytes get there. `Object.entries` follows
    // insertion order, so without canonicalisation somewhere on the path
    // these two would miss each other's results on every server.
    const root = await seeded('x\n')
    try {
      const spec = (define: Record<string, string>): Partial<ExecuteRequest> =>
        ({
          command: 'true',
          envDefine: define,
          inputs: {
            files: [{ path: 'pkg/src/in.txt', digest: 'unused' }],
            env: [{ name: 'MID', value: '1' }],
            runtime: [],
            workspaceRuntime: [],
            upstream: [],
            packageJsonDigest: 'x',
            configDigest: 'y',
            workspaceFingerprint: 'z',
          },
        }) as Partial<ExecuteRequest>
      const forward = await actionIdFor(root, spec({ ZED: 'z', ALPHA: 'a' }))
      const reverse = await actionIdFor(root, spec({ ALPHA: 'a', ZED: 'z' }))
      expect(forward).toBeDefined()
      expect(reverse).toBe(forward)

      // CONTROL: a different VALUE still moves it.
      expect(await actionIdFor(root, spec({ ZED: 'z', ALPHA: 'different' }))).not.toBe(forward)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('a workspace-file output outside the project dir round-trips via a ../ path', async () => {
    // A root-anchored output has no '..'-free spelling relative to the
    // project dir, and servers refuse '..' in output_paths — so an action
    // declaring outputs.workspaceFiles runs at the INPUT ROOT and `cd`s into
    // the project instead. Two things are pinned here, and this fixture
    // declares NO input files, which is what makes the second one live: the
    // worker captures the root-relative output and materialisation resolves
    // it back to the workspace root, AND the project dir the command `cd`s
    // into exists in the input tree at all. Nothing else would create it
    // here — the action's working directory is the root, and a task whose
    // declared inputs all sit outside its own directory would otherwise
    // `cd` into nothing and exit non-zero.
    const root = await mkdtemp(path.join(tmpdir(), 'vx-exec-e2e-'))
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'seed\n')
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      const executor = reapiExecutor(client, { warn: () => undefined })
      const res = await executor.execute(
        req3(root, {
          command: 'mkdir -p ../shared && echo WS > ../shared/gen.txt',
          outputs: { files: [], workspaceFiles: ['shared/gen.txt'] },
        }),
      )
      expect(res.exitCode).toBe(0)
      expect((await readFile(path.join(root, 'shared', 'gen.txt'), 'utf8')).trim()).toBe('WS')
    } finally {
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('download: deferred leaves the outputs remote until materialize() is called', async () => {
    // `--download=none`'s wire half: the action still runs on the worker and
    // the result is authoritative, but no output byte crosses to the
    // submitter until core asks. Asserted on the ARTIFACT (the file's
    // presence), not on a count of calls.
    const root = await mkdtemp(path.join(tmpdir(), 'vx-exec-e2e-'))
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'deferred bytes\n')
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      const executor = reapiExecutor(client, { warn: () => undefined })
      const res = await executor.execute(
        req3(root, {
          command: 'tr a-z A-Z < src/in.txt > out.txt',
          download: 'deferred',
          outputs: { files: ['out.txt'], workspaceFiles: [] },
          inputs: {
            files: [{ path: 'pkg/src/in.txt', digest: 'x' }],
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
      expect(res.exitCode).toBe(0)
      expect(res.outputs?.kind).toBe('deferred')
      const out = path.join(root, 'pkg', 'out.txt')
      await expect(readFile(out, 'utf8')).rejects.toThrow()
      await (res.outputs as { materialize: () => Promise<void> }).materialize()
      expect((await readFile(out, 'utf8')).trim()).toBe('DEFERRED BYTES')
    } finally {
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('a second run short-circuits on the exec record and replays stdout', async () => {
    // Phase 3: the deferred producer's steady state. Run once to write the
    // record, then run the SAME key again — the second execution must not
    // reach the worker at all, and must still replay the first run's
    // stdout from the record's stdout_digest.
    const root = await mkdtemp(path.join(tmpdir(), 'vx-exec-e2e-'))
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), `sc-${n3}\n`)
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      const executor = reapiExecutor(client, { warn: () => {} })
      const make = (over: Partial<ExecuteRequest>): ExecuteRequest =>
        req3(root, {
          // The uuid is what makes the replay PROVABLE: a second execution
          // could not reproduce it, so byte-identical stdout can only have come
          // from the record.
          command:
            'cat src/in.txt > out.txt && echo SHORTCIRCUIT-STDOUT $(cat /proc/sys/kernel/random/uuid)',
          cacheKey: `sc-key-${n3}`,
          outputs: { files: ['out.txt'], workspaceFiles: [] },
          inputs: {
            files: [{ path: 'pkg/src/in.txt', digest: 'x' }],
            env: [],
            runtime: [],
            workspaceRuntime: [],
            upstream: [],
            packageJsonDigest: 'p',
            configDigest: 'c',
            workspaceFingerprint: 'w',
          },
          ...over,
        } as Partial<ExecuteRequest>)

      let firstOut = ''
      const first = await executor.execute(
        make({ onStdout: (c: string) => (firstOut += c) } as Partial<ExecuteRequest>),
      )
      expect(first.exitCode).toBe(0)
      expect(firstOut).toContain('SHORTCIRCUIT-STDOUT')
      // Guard against a vacuous pin below: if the uuid never made it into
      // stdout, two empty markers would compare equal and prove nothing.
      expect(firstOut).toMatch(/SHORTCIRCUIT-STDOUT [0-9a-f-]{36}/)

      let secondOut = ''
      const second = await executor.execute(
        make({ onStdout: (c: string) => (secondOut += c) } as Partial<ExecuteRequest>),
      )
      expect(second.exitCode).toBe(0)
      // THE pin: byte-identical stdout, uuid included. A re-execution would
      // print a different one, so this can only be the record's blob replayed.
      // Asserted on the bytes rather than on the warnings this used to read —
      // those fired several times per action and were removed, and a pin on
      // incidental output breaks when the output is tidied rather than when
      // the behaviour moves.
      expect(secondOut).toBe(firstOut)
      // The short-circuit return carries no worker id, because no worker ran.
      expect(second.where).toBeUndefined()
    } finally {
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})

// The CACHE layer's existence probe, pinned HERE rather than in the cache
// suite on purpose: bazel-remote validates an ActionResult's referenced blobs
// and hides a dangling entry, so this assertion passes there whether or not
// the client checks anything — a vacuous pin. NativeLink serves the dangling
// entry, so this endpoint is the only place the check is observable.
describe.if(run)('the remote cache probe does not promise an evicted artifact', () => {
  const endpoint = ENDPOINT as string

  it('has() is FALSE when the artifact blob is gone, TRUE when it is there', async () => {
    const { ReapiRemoteCache, actionDigestFor, digestOf } = await import('../src/cache.js')
    const n = `${process.pid}-${Bun.nanoseconds()}`
    const client = new ReapiClient({ endpoint })
    const cache = new ReapiRemoteCache({ endpoint })
    try {
      await client.negotiate()

      // CONTROL: a real artifact, uploaded — has() must still say yes, or the
      // refusal has degenerated into "never hit".
      const live = `vx-live-${n}`
      const body = new TextEncoder().encode(`artifact-${n}`)
      await cache.put(live, body, { durationMs: 7 })
      expect(await cache.has(live)).toBe(true)
      expect((await cache.get(live)) !== null).toBe(true)

      // The defect: an entry naming a blob that was never uploaded. `get`
      // already answered null here; `has` used to answer true, so `--dry`
      // predicted a remote hit for a task that would really execute.
      const dangling = `vx-dangling-${n}`
      await client.updateActionResult(actionDigestFor(dangling), {
        exit_code: 0,
        output_files: [
          {
            path: 'vx-artifact.tar.zst',
            digest: digestOf(new TextEncoder().encode(`never-uploaded-${n}`)),
            is_executable: false,
          },
        ],
      })
      expect(await cache.has(dangling)).toBe(false)
      expect(await cache.get(dangling)).toBeNull()
    } finally {
      cache.close()
      client.close()
    }
  }, 120_000)
})
