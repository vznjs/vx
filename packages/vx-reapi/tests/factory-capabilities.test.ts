// The executor factory asks Capabilities twice: in `negotiate()`, then for
// `exec_enabled`. A failure of the second escaped raw ("4 DEADLINE_EXCEEDED:
// …"), and core aborts a run on a throwing executor factory, so the line a
// user read named neither the server, the plugin nor what to do.
import { afterAll, beforeAll, expect, it } from 'bun:test'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { reapi } from '../src/index.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'

const PROTO_ROOT = path.resolve(import.meta.dir, '..', 'protos')

let server: grpc.Server
let endpoint: string
let asked = 0

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
    // The first ask answers; every later one is past its deadline.
    GetCapabilities: ((_call: unknown, cb: grpc.sendUnaryData<unknown>) => {
      if (asked++ > 0) return cb({ code: grpc.status.DEADLINE_EXCEEDED, details: 'too slow' })
      cb(null, {
        cache_capabilities: { digest_functions: ['SHA256'] },
        execution_capabilities: { exec_enabled: true, digest_function: 'SHA256' },
      })
    }) as grpc.UntypedHandleCall,
  })
  await new Promise<void>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err)
      endpoint = `grpc://127.0.0.1:${port}`
      resolve()
    })
  })
})
afterAll(() => {
  server.forceShutdown()
})

it.skipIf(!CHUNKING_SUPPORTED)(
  'a failed second Capabilities ask names the server and the fix',
  async () => {
    const p = reapi({ endpoint, execute: true })
    const ctx = { warn: () => undefined, workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache' } as never
    try {
      const message = await Promise.resolve(p.executor?.(ctx)).then(
        () => 'resolved',
        (e: Error) => e.message,
      )
      expect(message).toBe(
        `cannot reach the REAPI server at ${endpoint} for remote execution: 4 DEADLINE_EXCEEDED: too slow — check the endpoint, that the server is running, and that this host can reach it, or drop \`execute\` to use it as a cache only`,
      )
    } finally {
      await p.teardown?.()
    }
  },
)
