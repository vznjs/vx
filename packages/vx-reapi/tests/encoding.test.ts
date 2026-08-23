// The action digest is computed from SERIALISED bytes, so this package's
// hand-rolled encoders must agree with a real protobuf implementation to the
// byte. If they drift, every action digest is wrong: the server computes a
// different address than the client, remote execution never matches a cache
// entry, and nothing errors — it just silently never hits.
//
// So: encode with our encoder, encode with protobufjs from the SAME vendored
// .proto files, and compare bytes.

import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import protobuf from 'protobufjs'
import {
  encodeAction,
  encodeCommand,
  encodeDigest,
  encodeDirectory,
  sha256,
} from '../src/merkle.js'
import type { Directory } from '../src/wire.js'

const PROTOS = path.join(import.meta.dir, '..', 'protos')
const WELL_KNOWN = path.dirname(
  Bun.resolveSync('protobufjs/google/protobuf/descriptor.proto', import.meta.dir),
)

const root = new protobuf.Root()
root.resolvePath = (_origin, target) =>
  target.startsWith('google/protobuf/')
    ? path.join(WELL_KNOWN, path.basename(target))
    : path.join(PROTOS, target)
await root.load('build/bazel/remote/execution/v2/remote_execution.proto')

// protobufjs addresses fields by their CAMELCASE JS names; this package uses
// proto-loader with `keepCase: true`, so the reference side needs the other
// spelling. Getting this wrong silently DROPS fields from the reference — the
// first version of this test did exactly that and looked like an encoder bug.
// Also STRIPS proto3 default values, because protobufjs writes any field
// explicitly present on the object while canonical proto3 (and Bazel) omit
// defaults. Without this the reference disagrees with every conformant
// encoder, not just ours.
const camel = (o: unknown): unknown => {
  if (Array.isArray(o)) return o.map(camel)
  if (o === null || typeof o !== 'object') return o
  return Object.fromEntries(
    Object.entries(o as Record<string, unknown>)
      .filter(([, v]) => v !== false && v !== 0 && v !== '')
      .map(([k, v]) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), camel(v)]),
  )
}
const ref = (name: string, obj: unknown): Uint8Array =>
  root
    .lookupType(`build.bazel.remote.execution.v2.${name}`)
    .encode(camel(obj) as object)
    .finish()

/** Guard the harness itself: a reference that silently drops fields proves nothing. */
const refNonEmpty = (name: string, obj: unknown): Uint8Array => {
  const bytes = ref(name, obj)
  if (bytes.length === 0) throw new Error(`reference encoding of ${name} was EMPTY — harness bug`)
  return bytes
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

describe('encodeDigest matches protobufjs', () => {
  it.each([
    ['empty', { hash: '', size_bytes: 0 }],
    ['typical', { hash: 'a'.repeat(64), size_bytes: 1234 }],
    ['large size crossing varint boundaries', { hash: 'f'.repeat(64), size_bytes: 1 << 28 }],
  ])('%s', (_label, d) => {
    expect(hex(encodeDigest(d))).toBe(hex(ref('Digest', d)))
  })
})

describe('encodeDirectory matches protobufjs', () => {
  it('empty directory', () => {
    const dir: Directory = { files: [], directories: [], symlinks: [] }
    expect(hex(encodeDirectory(dir))).toBe(hex(ref('Directory', dir)))
    expect(hex(encodeDirectory(dir))).toBe('')
  })

  it('files with and without the executable bit', () => {
    // `is_executable` is a bool: protobuf omits it when false. An encoder that
    // wrote a zero byte instead would produce a different digest for the same
    // tree.
    const dir: Directory = {
      files: [
        { name: 'a.txt', digest: sha256(new TextEncoder().encode('a')), is_executable: false },
        {
          name: 'run.sh',
          digest: sha256(new TextEncoder().encode('#!/bin/sh')),
          is_executable: true,
        },
      ],
      directories: [],
      symlinks: [],
    }
    expect(hex(encodeDirectory(dir))).toBe(hex(refNonEmpty('Directory', dir)))
  })

  it('nested directories and symlinks', () => {
    const dir: Directory = {
      files: [{ name: 'f', digest: sha256(new Uint8Array([1, 2, 3])), is_executable: false }],
      directories: [{ name: 'src', digest: sha256(new Uint8Array([4])) }],
      symlinks: [{ name: 'link', target: '../elsewhere' }],
    }
    expect(hex(encodeDirectory(dir))).toBe(hex(refNonEmpty('Directory', dir)))
  })
})

describe('encodeCommand matches protobufjs', () => {
  const cmd = {
    arguments: ['/bin/sh', '-c', 'echo hi && exit 0'],
    environmentVariables: [
      { name: 'PATH', value: '/usr/bin' },
      { name: 'CI', value: '1' },
    ],
    outputPaths: ['dist/out.js', 'a.txt'],
    workingDirectory: 'packages/app',
    platform: [{ name: 'container-image', value: 'docker://alpine' }],
  }

  it('full command', () => {
    // Ours sorts env and output paths (the spec requires it); build the
    // reference from the SAME sorted shape so this compares encodings, not
    // orderings — the ordering itself is asserted separately below.
    const expected = refNonEmpty('Command', {
      arguments: cmd.arguments,
      environment_variables: [...cmd.environmentVariables].sort((a, b) =>
        a.name < b.name ? -1 : 1,
      ),
      output_paths: [...cmd.outputPaths].sort(),
      working_directory: cmd.workingDirectory,
      platform: { properties: cmd.platform },
    })
    expect(hex(encodeCommand(cmd))).toBe(hex(expected))
  })

  it('omits working_directory and platform when empty', () => {
    const bare = {
      arguments: ['true'],
      environmentVariables: [],
      outputPaths: [],
      workingDirectory: '',
      platform: [],
    }
    expect(hex(encodeCommand(bare))).toBe(hex(refNonEmpty('Command', { arguments: ['true'] })))
  })

  it('SORTS env and output paths, so input order cannot move the digest', () => {
    // Two callers describing the same command must land on the same action
    // digest, or they never share a remote cache entry.
    const a = encodeCommand(cmd)
    const b = encodeCommand({
      ...cmd,
      environmentVariables: [...cmd.environmentVariables].reverse(),
      outputPaths: [...cmd.outputPaths].reverse(),
    })
    expect(hex(a)).toBe(hex(b))
  })
})

describe('encodeAction matches protobufjs', () => {
  const commandDigest = sha256(new TextEncoder().encode('cmd'))
  const inputRootDigest = sha256(new TextEncoder().encode('root'))

  it('without a timeout', () => {
    expect(hex(encodeAction({ commandDigest, inputRootDigest }))).toBe(
      hex(
        refNonEmpty('Action', {
          command_digest: commandDigest,
          input_root_digest: inputRootDigest,
        }),
      ),
    )
  })

  it('with a timeout and do_not_cache', () => {
    expect(
      hex(encodeAction({ commandDigest, inputRootDigest, timeoutSeconds: 90, doNotCache: true })),
    ).toBe(
      hex(
        ref('Action', {
          command_digest: commandDigest,
          input_root_digest: inputRootDigest,
          timeout: { seconds: 90 },
          do_not_cache: true,
        }),
      ),
    )
  })
})

describe('proto3 default omission — the empty blob', () => {
  it('omits size_bytes for the empty blob, as every conformant encoder does', () => {
    // REAPI's well-known empty digest has size_bytes 0. An encoder that wrote
    // an explicit zero would give any tree containing an EMPTY FILE a
    // different digest than the server computes for the same tree — a silent
    // interop break with no error anywhere.
    const empty = sha256(new Uint8Array())
    expect(empty.hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(empty.size_bytes).toBe(0)
    expect(hex(encodeDigest(empty))).toBe(hex(ref('Digest', empty)))
    // and concretely: no field-2 tag at all
    expect(hex(encodeDigest(empty)).includes('1000')).toBe(false)
  })

  it('a tree containing an empty file matches the reference tree', () => {
    const dir: Directory = {
      files: [{ name: 'empty', digest: sha256(new Uint8Array()), is_executable: false }],
      directories: [],
      symlinks: [],
    }
    expect(hex(encodeDirectory(dir))).toBe(hex(refNonEmpty('Directory', dir)))
  })
})
