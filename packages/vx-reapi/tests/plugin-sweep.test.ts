// Item 819's sweep of index.ts: each row fails with one line of the plugin
// undone. The executor path runs against an in-process Capabilities stub
// whose `exec_enabled` a row sets, and which records the instance name each
// request carries. Offline: no docker, no service job.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { reapi } from '../src/index.js'
import { ReapiClient } from '../src/wire.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'

const PROTO_ROOT = path.resolve(import.meta.dir, '..', 'protos')

let server: grpc.Server
let endpoint: string
let execEnabled = false
const instances: string[] = []

beforeAll(async () => {
  const v2 = (
    grpc.loadPackageDefinition(
      protoLoader.loadSync('build/bazel/remote/execution/v2/remote_execution.proto', {
        includeDirs: [PROTO_ROOT],
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      }),
    ) as never as {
      build: {
        bazel: {
          remote: { execution: { v2: Record<string, { service: grpc.ServiceDefinition }> } }
        }
      }
    }
  ).build.bazel.remote.execution.v2
  server = new grpc.Server()
  server.addService(v2['Capabilities']!.service, {
    GetCapabilities: ((
      call: grpc.ServerUnaryCall<{ instance_name: string }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      instances.push(call.request.instance_name)
      cb(null, {
        cache_capabilities: { digest_functions: ['SHA256'] },
        execution_capabilities: { exec_enabled: execEnabled, digest_function: 'SHA256' },
      })
    }) as grpc.UntypedHandleCall,
  })
  await new Promise<void>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err)
      endpoint = `127.0.0.1:${port}`
      resolve()
    })
  })
})
afterAll(() => {
  server.forceShutdown()
})

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const keys = ['VX_REAPI_ENDPOINT', 'VX_REAPI_INSTANCE', 'VX_REAPI_EXECUTE']
  const saved = new Map(keys.map((k) => [k, process.env[k]]))
  for (const k of keys) delete process.env[k]
  Object.assign(process.env, env)
  try {
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Counts `ReapiClient#close` while `fn` runs: the executor's client is made inside the plugin. */
async function countingCloses<T>(fn: () => Promise<T>): Promise<{ value: T; closes: number }> {
  const original = ReapiClient.prototype.close
  let closes = 0
  ReapiClient.prototype.close = function patched(this: ReapiClient) {
    closes++
    original.call(this)
  }
  try {
    return { value: await fn(), closes }
  } finally {
    ReapiClient.prototype.close = original
  }
}

const ctx = (warns: string[]) =>
  ({ warn: (m: string) => warns.push(m), localCache: {} as never, policy: {} as never }) as never

describe('reapi(): the connection it resolves', () => {
  it('an empty endpoint declines, as none does', async () => {
    await withEnv({}, async () => {
      const p = reapi({ endpoint: '' })
      expect(p.cache?.(ctx([]))).toBeUndefined()
      await p.teardown?.()
    })
  })

  it.skipIf(!CHUNKING_SUPPORTED)(
    'the endpoint option wins over VX_REAPI_ENDPOINT; VX_REAPI_INSTANCE names the instance',
    async () => {
      await withEnv(
        { VX_REAPI_ENDPOINT: '127.0.0.1:1', VX_REAPI_INSTANCE: 'from-env' },
        async () => {
          execEnabled = false
          const before = instances.length
          const warns: string[] = []
          const p = reapi({ endpoint, execute: true, callTimeoutMs: 2000 })
          expect(await p.executor?.(ctx(warns))).toBeUndefined()
          await p.teardown?.()
          expect(instances.slice(before)).toEqual(['from-env', 'from-env'])
        },
      )
    },
    30_000,
  )
})

describe.if(CHUNKING_SUPPORTED)(
  'reapi(): the executor it offers, and the clients it closes',
  () => {
    it('a cache-only server is declined out loud, and its client closed', async () => {
      await withEnv({}, async () => {
        execEnabled = false
        const warns: string[] = []
        const p = reapi({ endpoint, execute: true })
        const { value, closes } = await countingCloses(async () => p.executor!(ctx(warns)))
        expect([value, closes]).toEqual([undefined, 1])
        expect(warns).toEqual([
          `vx/reapi: ${endpoint} does not advertise remote execution (cache only) — tasks will run locally`,
        ])
        await p.teardown?.()
      })
    })

    it('an execution server gets the executor, with its capacity; teardown closes its client', async () => {
      await withEnv({}, async () => {
        execEnabled = true
        const p = reapi({ endpoint, execute: true, capacity: 7 })
        const { value, closes } = await countingCloses(async () => {
          const executor = await p.executor!(ctx([]))
          await p.teardown?.()
          return executor
        })
        expect(value?.capacity).toBe(7)
        expect(closes).toBe(1)
      })
    })

    it('an unreachable server’s client is closed before the refusal', async () => {
      await withEnv({}, async () => {
        const p = reapi({ endpoint: '127.0.0.1:59999', execute: true })
        const { closes } = await countingCloses(async () => {
          await Promise.resolve()
            .then(() => p.executor!(ctx([])))
            .catch(() => undefined)
          return undefined
        })
        expect(closes).toBe(1)
        await p.teardown?.()
      })
    }, 30_000)
  },
)
