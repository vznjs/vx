// An in-process REAPI server for the suites that must not need docker: the
// five services the client speaks (Capabilities, ActionCache, CAS,
// ByteStream, Execution), backed by maps, recording every call with its
// metadata, and able to fail a method on demand. Execution runs no command:
// a row scripts what each Execute answers (stages, then a response or a
// status). The real servers are the live suites' (reapi-e2e, exec-e2e).
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import protobuf from 'protobufjs'

const PROTOS = path.resolve(import.meta.dir, '..', '..', 'protos')
const LOAD_OPTIONS: protoLoader.Options = {
  includeDirs: [PROTOS],
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
}

type Services = Record<string, { service: grpc.ServiceDefinition }>
interface WireDigest {
  hash: string
  size_bytes: string
}

/** protobufjs over the same protos, for the `Any` payloads an Operation carries. */
const pbRoot = new protobuf.Root()
pbRoot.resolvePath = (_origin, target) =>
  target.startsWith('google/protobuf/')
    ? path.join(
        path.dirname(
          Bun.resolveSync('protobufjs/google/protobuf/descriptor.proto', import.meta.dir),
        ),
        path.basename(target),
      )
    : path.join(PROTOS, target)
await pbRoot.load('build/bazel/remote/execution/v2/remote_execution.proto')
const V2 = 'build.bazel.remote.execution.v2'

const camel = (o: unknown): unknown => {
  if (Array.isArray(o)) return o.map(camel)
  if (o instanceof Uint8Array) return o
  if (o === null || typeof o !== 'object') return o
  return Object.fromEntries(
    Object.entries(o as Record<string, unknown>).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()),
      camel(v),
    ]),
  )
}
/** `fromObject` first: it is what turns an enum's NAME into its number. */
const encode = (type: string, obj: unknown): Uint8Array => {
  const t = pbRoot.lookupType(`${V2}.${type}`)
  return t.encode(t.fromObject(camel(obj) as object)).finish()
}

/** What one Execute (or WaitExecution) answers. */
export interface ExecutePlan {
  /** `ExecuteOperationMetadata.stage` names streamed before the last message. */
  stages?: string[]
  /** The final `ExecuteResponse` (snake_case, as the protos spell it). */
  response?: Record<string, unknown>
  /** Raw `ExecuteOperationMetadata` bytes per stage message, in place of `stages`. */
  metadataBytes?: Uint8Array[]
  /** A gRPC status to end the stream with instead of a final operation. */
  error?: { code: grpc.status; details: string }
  /** A final operation that carries `Operation.error` instead of a response. */
  opError?: { code: number; message: string }
  /** End the stream without sending the final operation (a server that goes away). */
  endEarly?: boolean
  /** Hold the stream open until this settles (a queued action). */
  hold?: Promise<void>
  /** Send every operation with an empty name (one that cannot be re-attached). */
  unnamed?: boolean
}

export interface FakeCall {
  method: string
  request: Record<string, unknown>
  metadata: grpc.Metadata
}

export interface FakeReapi {
  readonly endpoint: string
  readonly blobs: Map<string, Uint8Array>
  readonly actions: Map<string, Record<string, unknown>>
  readonly calls: FakeCall[]
  /** Each ByteStream Write: its resource, each message's `data` length and offset, and whether it finished. */
  readonly writes: { resource: string; sizes: number[]; offsets: number[]; finished: boolean }[]
  caps: {
    execEnabled: boolean
    acUpdateEnabled: boolean
    digestFunctions: string[]
    compressors: string[]
    batchCompressors: string[]
    maxBatchBytes: number
  }
  /** Answers every Execute and WaitExecution; the default completes with exit 0. */
  onExecute: (request: Record<string, unknown>, method: string) => ExecutePlan
  /** The next `times` calls of `method` fail with `code`. */
  fail(method: string, code: grpc.status, times?: number): void
  /** The next Write keeps its first `bytes` as committed, then fails UNAVAILABLE. */
  cutWrite: number | undefined
  /** QueryWriteStatus answers `complete` for every resource. */
  reportComplete: boolean
  /** Digests BatchUpdateBlobs rejects with INVALID_ARGUMENT. */
  readonly rejectBatch: Set<string>
  /** A Read sends one message and then waits to be cancelled. */
  holdReads: boolean
  readsCancelled: number
  executesCancelled: number
  /** Directories GetTree serves, one per page. */
  tree: Record<string, unknown>[]
  /** Stores `data`; its digest as the client spells one (`size_bytes` a number). */
  put(data: Uint8Array): { hash: string; size_bytes: number }
  stop(): void
}

/** A compressed resource, with or without an instance name before it. */
const ZSTD_RESOURCE = /(^|\/)compressed-blobs\/zstd\//

function hashOf(resource: string): string {
  const m = /blobs\/(?:zstd\/)?([0-9a-f]{64})\/\d+$/.exec(resource)
  if (!m) throw new Error(`unexpected resource ${resource}`)
  return m[1]!
}

export async function startFakeReapi(): Promise<FakeReapi> {
  const v2 = (
    grpc.loadPackageDefinition(
      protoLoader.loadSync('build/bazel/remote/execution/v2/remote_execution.proto', LOAD_OPTIONS),
    ) as never as { build: { bazel: { remote: { execution: { v2: Services } } } } }
  ).build.bazel.remote.execution.v2
  const bs = (
    grpc.loadPackageDefinition(
      protoLoader.loadSync('google/bytestream/bytestream.proto', LOAD_OPTIONS),
    ) as never as { google: { bytestream: Services } }
  ).google.bytestream

  const failures = new Map<string, { code: grpc.status; left: number }>()
  /** What a cut Write committed, by resource, for QueryWriteStatus and the resume. */
  const partial = new Map<string, Uint8Array>()
  const fake: Omit<FakeReapi, 'endpoint'> & { endpoint: string } = {
    endpoint: '',
    blobs: new Map(),
    actions: new Map(),
    calls: [],
    writes: [],
    caps: {
      execEnabled: true,
      acUpdateEnabled: true,
      digestFunctions: ['SHA256'],
      compressors: [],
      batchCompressors: [],
      maxBatchBytes: 4 * 1024 * 1024,
    },
    onExecute: () => ({ response: { result: { exit_code: 0 } } }),
    fail(method, code, times = 1) {
      failures.set(method, { code, left: times })
    },
    cutWrite: undefined,
    reportComplete: false,
    rejectBatch: new Set(),
    holdReads: false,
    readsCancelled: 0,
    executesCancelled: 0,
    tree: [],
    put(data) {
      const hash = new Bun.CryptoHasher('sha256').update(data).digest('hex')
      fake.blobs.set(hash, data)
      return { hash, size_bytes: data.length }
    },
    stop() {
      server.forceShutdown()
    },
  }

  /** Records the call; true when an injected failure answered it. */
  const enter = (
    method: string,
    call: { request?: unknown; metadata: grpc.Metadata },
    fail: (e: grpc.StatusObject) => void,
  ): boolean => {
    fake.calls.push({
      method,
      request: (call.request ?? {}) as Record<string, unknown>,
      metadata: call.metadata,
    })
    const f = failures.get(method)
    if (f === undefined || f.left === 0) return false
    f.left--
    fail({
      code: f.code,
      details: `injected ${grpc.status[f.code]}`,
      metadata: new grpc.Metadata(),
    })
    return true
  }
  const unaryErr = (cb: grpc.sendUnaryData<unknown>) => (e: grpc.StatusObject) => cb(e)

  const server = new grpc.Server()
  server.addService(v2['Capabilities']!.service, {
    GetCapabilities: ((
      call: grpc.ServerUnaryCall<unknown, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      if (enter('GetCapabilities', call, unaryErr(cb))) return
      cb(null, {
        cache_capabilities: {
          digest_functions: fake.caps.digestFunctions,
          max_batch_total_size_bytes: String(fake.caps.maxBatchBytes),
          action_cache_update_capabilities: { update_enabled: fake.caps.acUpdateEnabled },
          supported_compressors: fake.caps.compressors,
          supported_batch_update_compressors: fake.caps.batchCompressors,
        },
        execution_capabilities: { exec_enabled: fake.caps.execEnabled, digest_function: 'SHA256' },
      })
    }) as grpc.UntypedHandleCall,
  })
  server.addService(v2['ActionCache']!.service, {
    GetActionResult: ((
      call: grpc.ServerUnaryCall<{ action_digest: WireDigest }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      if (enter('GetActionResult', call, unaryErr(cb))) return
      const found = fake.actions.get(call.request.action_digest.hash)
      if (found === undefined) cb({ code: grpc.status.NOT_FOUND, details: 'no action' })
      else cb(null, found)
    }) as grpc.UntypedHandleCall,
    UpdateActionResult: ((
      call: grpc.ServerUnaryCall<
        { action_digest: WireDigest; action_result: Record<string, unknown> },
        unknown
      >,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      if (enter('UpdateActionResult', call, unaryErr(cb))) return
      fake.actions.set(call.request.action_digest.hash, call.request.action_result)
      cb(null, call.request.action_result)
    }) as grpc.UntypedHandleCall,
  })
  server.addService(v2['ContentAddressableStorage']!.service, {
    FindMissingBlobs: ((
      call: grpc.ServerUnaryCall<{ blob_digests: WireDigest[] }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      if (enter('FindMissingBlobs', call, unaryErr(cb))) return
      cb(null, {
        // The spec's rule: the empty blob is always present, stored or not.
        missing_blob_digests: call.request.blob_digests.filter(
          (d) => Number(d.size_bytes) > 0 && !fake.blobs.has(d.hash),
        ),
      })
    }) as grpc.UntypedHandleCall,
    BatchUpdateBlobs: ((
      call: grpc.ServerUnaryCall<
        { requests: { digest: WireDigest; data: Uint8Array; compressor: string }[] },
        unknown
      >,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      if (enter('BatchUpdateBlobs', call, unaryErr(cb))) return
      cb(null, {
        responses: call.request.requests.map((r) => {
          if (fake.rejectBatch.has(r.digest.hash)) {
            return {
              digest: r.digest,
              status: { code: grpc.status.INVALID_ARGUMENT, message: 'rejected' },
            }
          }
          const data = r.compressor === 'ZSTD' ? Bun.zstdDecompressSync(r.data) : r.data
          fake.blobs.set(r.digest.hash, new Uint8Array(data))
          return { digest: r.digest, status: { code: 0 } }
        }),
      })
    }) as grpc.UntypedHandleCall,
    BatchReadBlobs: ((
      call: grpc.ServerUnaryCall<
        { digests: WireDigest[]; acceptable_compressors: string[] },
        unknown
      >,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      if (enter('BatchReadBlobs', call, unaryErr(cb))) return
      const zstd = call.request.acceptable_compressors.includes('ZSTD')
      cb(null, {
        responses: call.request.digests.map((d) => {
          const blob = fake.blobs.get(d.hash)
          if (blob === undefined) return { digest: d, status: { code: grpc.status.NOT_FOUND } }
          return zstd
            ? {
                digest: d,
                data: Bun.zstdCompressSync(blob),
                compressor: 'ZSTD',
                status: { code: 0 },
              }
            : { digest: d, data: blob, status: { code: 0 } }
        }),
      })
    }) as grpc.UntypedHandleCall,
    // Split in two halves; splice concatenates; GetTree pages `fake.tree`.
    SplitBlob: ((
      call: grpc.ServerUnaryCall<{ blob_digest: WireDigest }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      if (enter('SplitBlob', call, unaryErr(cb))) return
      const blob = fake.blobs.get(call.request.blob_digest.hash)
      if (blob === undefined) return cb({ code: grpc.status.NOT_FOUND, details: 'no blob' })
      const half = Math.ceil(blob.length / 2)
      cb(null, {
        chunk_digests: [fake.put(blob.subarray(0, half)), fake.put(blob.subarray(half))],
        chunking_function: 'FAST_CDC_2020',
      })
    }) as grpc.UntypedHandleCall,
    SpliceBlob: ((
      call: grpc.ServerUnaryCall<{ chunk_digests: WireDigest[] }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      if (enter('SpliceBlob', call, unaryErr(cb))) return
      const parts = call.request.chunk_digests.map((d) => fake.blobs.get(d.hash))
      if (parts.some((p) => p === undefined))
        return cb({ code: grpc.status.NOT_FOUND, details: 'no chunk' })
      cb(null, { blob_digest: fake.put(Buffer.concat(parts as Uint8Array[])) })
    }) as grpc.UntypedHandleCall,
    // Server-streaming, as the proto declares it: every page on one call,
    // one directory per page, `next_page_token` naming the one after.
    GetTree: ((call: grpc.ServerWritableStream<{ page_token: string }, unknown>) => {
      if (enter('GetTree', call, (e) => call.emit('error', e))) return
      for (let at = Number(call.request.page_token || 0); at < fake.tree.length; at++) {
        const next = at + 1 < fake.tree.length ? String(at + 1) : ''
        call.write({ directories: [fake.tree[at]], next_page_token: next })
      }
      call.end()
    }) as grpc.UntypedHandleCall,
  })
  server.addService(bs['ByteStream']!.service, {
    Write: ((
      call: grpc.ServerReadableStream<
        { resource_name: string; write_offset: string; data: Uint8Array; finish_write: boolean },
        unknown
      >,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      const record = {
        resource: '',
        sizes: [] as number[],
        offsets: [] as number[],
        finished: false,
      }
      const parts: Uint8Array[] = []
      // An injected failure answers once the client has sent everything:
      // answered mid-stream, grpc-js leaves the client writing into a call
      // that has ended until its own deadline.
      let failed: grpc.StatusObject | undefined
      const cut = fake.cutWrite
      fake.cutWrite = undefined
      call.on('data', (m) => {
        if (record.resource === '') {
          record.resource = m.resource_name
          fake.writes.push(record)
          enter(
            'Write',
            { request: { resource_name: m.resource_name }, metadata: call.metadata },
            (e) => (failed = e),
          )
          // A resumed write carries on from what an earlier one committed.
          const earlier = partial.get(m.resource_name)
          if (Number(m.write_offset) > 0 && earlier !== undefined) parts.push(earlier)
        }
        record.sizes.push(m.data.length)
        record.offsets.push(Number(m.write_offset))
        record.finished ||= m.finish_write
        parts.push(m.data)
      })
      call.on('end', () => {
        if (failed !== undefined) return cb(failed)
        const resource = record.resource
        if (resource === '') return cb({ code: grpc.status.CANCELLED, details: 'empty write' })
        const joined = Buffer.concat(parts)
        if (cut !== undefined) {
          partial.set(resource, joined.subarray(0, cut))
          return cb({ code: grpc.status.UNAVAILABLE, details: `cut after ${cut} bytes` })
        }
        const data = ZSTD_RESOURCE.test(resource) ? Bun.zstdDecompressSync(joined) : joined
        fake.blobs.set(hashOf(resource), new Uint8Array(data))
        cb(null, { committed_size: String(joined.length) })
      })
    }) as grpc.UntypedHandleCall,
    QueryWriteStatus: ((
      call: grpc.ServerUnaryCall<{ resource_name: string }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      if (enter('QueryWriteStatus', call, unaryErr(cb))) return
      const held = partial.get(call.request.resource_name)
      if (fake.reportComplete) return cb(null, { committed_size: '0', complete: true })
      if (held === undefined) return cb({ code: grpc.status.NOT_FOUND, details: 'no upload' })
      cb(null, { committed_size: String(held.length), complete: false })
    }) as grpc.UntypedHandleCall,
    Read: ((
      call: grpc.ServerWritableStream<{ resource_name: string; read_offset: string }, unknown>,
    ) => {
      if (enter('Read', call, (e) => call.emit('error', e))) return
      call.on('cancelled', () => {
        fake.readsCancelled++
      })
      const blob = fake.blobs.get(hashOf(call.request.resource_name))
      if (blob === undefined) {
        call.emit('error', { code: grpc.status.NOT_FOUND, details: 'no blob' })
        return
      }
      const body = ZSTD_RESOURCE.test(call.request.resource_name)
        ? Bun.zstdCompressSync(blob)
        : blob
      const from = Number(call.request.read_offset ?? 0)
      if (fake.holdReads) {
        call.write({ data: body.subarray(from, from + 64 * 1024) })
        return
      }
      for (let at = from; at < body.length; at += 64 * 1024) {
        call.write({ data: body.subarray(at, at + 64 * 1024) })
      }
      call.end()
    }) as grpc.UntypedHandleCall,
  })

  const operation = (
    name: string,
    stage: string | undefined,
    response?: Record<string, unknown>,
  ) => ({
    name,
    done: response !== undefined,
    ...(stage === undefined
      ? {}
      : {
          metadata: {
            type_url: `type.googleapis.com/${V2}.ExecuteOperationMetadata`,
            value: encode('ExecuteOperationMetadata', { stage }),
          },
        }),
    ...(response === undefined
      ? {}
      : {
          response: {
            type_url: `type.googleapis.com/${V2}.ExecuteResponse`,
            value: encode('ExecuteResponse', response),
          },
        }),
  })
  let operations = 0
  const streamExecute =
    (method: string) =>
    async (call: grpc.ServerWritableStream<Record<string, unknown>, unknown>) => {
      if (enter(method, call, (e) => call.emit('error', e))) return
      call.on('cancelled', () => {
        fake.executesCancelled++
      })
      const plan = fake.onExecute(call.request, method)
      const name = plan.unnamed
        ? ''
        : method === 'WaitExecution'
          ? String(call.request['name'])
          : `operations/${++operations}`
      for (const stage of plan.stages ?? []) call.write(operation(name, stage))
      for (const value of plan.metadataBytes ?? []) {
        call.write({
          name,
          done: false,
          metadata: { type_url: `type.googleapis.com/${V2}.ExecuteOperationMetadata`, value },
        })
      }
      if (plan.hold !== undefined) await plan.hold
      if (plan.error !== undefined) {
        call.emit('error', { ...plan.error, metadata: new grpc.Metadata() })
        return
      }
      if (plan.opError !== undefined) call.write({ name, done: true, error: plan.opError })
      else if (!plan.endEarly) call.write(operation(name, 'COMPLETED', plan.response ?? {}))
      call.end()
    }
  server.addService(v2['Execution']!.service, {
    Execute: streamExecute('Execute') as grpc.UntypedHandleCall,
    WaitExecution: streamExecute('WaitExecution') as grpc.UntypedHandleCall,
  })

  await new Promise<void>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err)
      fake.endpoint = `127.0.0.1:${port}`
      resolve()
    })
  })
  return fake
}
