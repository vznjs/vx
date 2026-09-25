// Item 825's sweep of executor.ts's ExecuteResponse decoders: each row
// fails with one line of a decoder undone. protobufjs encodes what an
// encoder writes; hand-built bytes cover what one never does (an explicit
// false, a fixed-width field vx does not read, fields out of order).
import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import protobuf from 'protobufjs'
import { decodeExecuteResponseBytes } from '../src/executor.js'
import { concat, encodeDigest } from '../src/merkle.js'

const pb = new protobuf.Root()
pb.resolvePath = (_o, t) =>
  t.startsWith('google/protobuf/')
    ? path.join(
        path.dirname(
          Bun.resolveSync('protobufjs/google/protobuf/descriptor.proto', import.meta.dir),
        ),
        path.basename(t),
      )
    : path.join(import.meta.dir, '..', 'protos', t)
await pb.load('build/bazel/remote/execution/v2/remote_execution.proto')
const T = pb.lookupType('build.bazel.remote.execution.v2.ExecuteResponse')
const encode = (o: Record<string, unknown>) => T.encode(T.fromObject(o)).finish()

const D = (hash: string, sizeBytes: number) => ({ hash, sizeBytes })
const varint = (n: number): number[] => {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return out
}
/** A length-delimited field, by hand. */
const ld = (field: number, body: Uint8Array | number[]) =>
  new Uint8Array([(field << 3) | 2, ...varint(body.length), ...body])
const text = (s: string) => new TextEncoder().encode(s)
/** An ExecuteResponse whose `result` (field 1) is `resultBytes`. */
const withResult = (resultBytes: Uint8Array) => ld(1, resultBytes)

describe('ExecuteResponse, from protobufjs', () => {
  it('a negative exit code, the stderr digest, a size past 16 bits, and the execution timestamps', () => {
    const decoded = decodeExecuteResponseBytes(
      encode({
        result: {
          exitCode: -1,
          stderrDigest: D('e', 3),
          outputFiles: [{ path: 'big', digest: D('b', 70_000) }],
          executionMetadata: {
            worker: 'w1',
            inputFetchStartTimestamp: { seconds: 1, nanos: 1 },
            inputFetchCompletedTimestamp: { seconds: 2, nanos: 2 },
            executionStartTimestamp: { seconds: 1_700_000_000, nanos: 5 },
            executionCompletedTimestamp: { seconds: 1_700_000_009, nanos: 7 },
          },
        },
      }),
    )
    expect(decoded.result).toEqual({
      exit_code: -1,
      stderr_digest: { hash: 'e', size_bytes: 3 },
      output_files: [
        { path: 'big', digest: { hash: 'b', size_bytes: 70_000 }, is_executable: false },
      ],
      execution_metadata: {
        worker: 'w1',
        execution_start_timestamp: { seconds: '1700000000', nanos: 5 },
        execution_completed_timestamp: { seconds: '1700000009', nanos: 7 },
      },
    })
  })
})

describe('ExecuteResponse, by hand', () => {
  it('a server log with no digest is dropped, not listed as undefined', () => {
    const logFile = concat([
      ld(1, encodeDigest({ hash: 'k', size_bytes: 1 })),
      new Uint8Array([0x10, 0x01]),
    ])
    const kept = ld(4, concat([ld(1, text('kept')), ld(2, logFile)]))
    const bare = ld(4, ld(1, text('bare')))
    expect(decodeExecuteResponseBytes(concat([bare, kept])).serverLogs).toEqual([
      { name: 'kept', digest: { hash: 'k', size_bytes: 1 }, humanReadable: true },
    ])
  })

  it('an explicit cached_result = 0 is false', () => {
    expect(decodeExecuteResponseBytes(new Uint8Array([0x10, 0x00])).cachedResult).toBe(false)
  })

  it('fixed-width fields vx does not read are stepped over, at both levels', () => {
    const fixed32 = [(9 << 3) | 5, 1, 2, 3, 4]
    const fixed64 = [(10 << 3) | 1, 1, 2, 3, 4, 5, 6, 7, 8]
    const result = new Uint8Array([...fixed32, ...fixed64, (4 << 3) | 0, 7])
    const buf = concat([
      new Uint8Array([...fixed32, ...fixed64]),
      withResult(result),
      ld(5, text('after')),
    ])
    const decoded = decodeExecuteResponseBytes(buf)
    expect([decoded.result?.exit_code, decoded.message]).toEqual([7, 'after'])
  })

  it('a log file’s explicit human_readable = 0 is false', () => {
    const logFile = concat([
      ld(1, encodeDigest({ hash: 'l', size_bytes: 1 })),
      new Uint8Array([0x10, 0x00]),
    ])
    const entry = concat([ld(1, text('log')), ld(2, logFile)])
    expect(decodeExecuteResponseBytes(ld(4, entry)).serverLogs).toEqual([
      { name: 'log', digest: { hash: 'l', size_bytes: 1 }, humanReadable: false },
    ])
  })

  it('an output file’s explicit is_executable = 0 is false, and empty contents are none', () => {
    const file = concat([
      ld(1, text('f')),
      ld(2, encodeDigest({ hash: 'h', size_bytes: 1 })),
      new Uint8Array([0x20, 0x00]),
      ld(5, []),
    ])
    const decoded = decodeExecuteResponseBytes(withResult(ld(2, file)))
    expect(decoded.result?.output_files).toEqual([
      { path: 'f', digest: { hash: 'h', size_bytes: 1 }, is_executable: false },
    ])
  })

  it('an output directory reads its tree digest past a varint field before it', () => {
    const dir = concat([
      ld(1, text('out')),
      new Uint8Array([(4 << 3) | 0, 1]),
      ld(3, encodeDigest({ hash: 't', size_bytes: 2 })),
    ])
    const decoded = decodeExecuteResponseBytes(withResult(ld(3, dir)))
    expect(decoded.result?.output_directories).toEqual([
      { path: 'out', tree_digest: { hash: 't', size_bytes: 2 } },
    ])
  })
})
