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
  if (o instanceof Uint8Array) return o // bytes fields pass through untouched
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

describe('encodeCommand v2.0/v2.1 compat fields', () => {
  it('legacy output_files/output_directories + node properties + format match protobufjs', () => {
    const cmd = {
      arguments: ['/bin/sh', '-c', 'make'],
      environmentVariables: [],
      outputPaths: ['dist', 'out.txt'],
      workingDirectory: 'pkg',
      platform: [],
      legacyOutputFiles: ['out.txt'],
      legacyOutputDirectories: ['dist'],
      outputNodeProperties: ['mtime'],
      outputDirectoryFormat: 2, // TREE_AND_DIRECTORY
    }
    const expected = refNonEmpty('Command', {
      arguments: cmd.arguments,
      output_files: cmd.legacyOutputFiles,
      output_directories: cmd.legacyOutputDirectories,
      working_directory: cmd.workingDirectory,
      output_paths: cmd.outputPaths,
      output_node_properties: cmd.outputNodeProperties,
      output_directory_format: cmd.outputDirectoryFormat,
    })
    expect(hex(encodeCommand(cmd))).toBe(hex(expected))
  })

  it('a repeated EMPTY string survives — output_paths [""] means the whole workdir', () => {
    // Singular proto3 fields omit the empty string; repeated elements do NOT.
    // REAPI assigns [""] a meaning, so dropping it would silently discard the
    // action's outputs with no error anywhere.
    const cmd = {
      arguments: ['true'],
      environmentVariables: [],
      outputPaths: [''],
      workingDirectory: '',
      platform: [],
    }
    const expected = refNonEmpty('Command', { arguments: ['true'], output_paths: [''] })
    expect(hex(encodeCommand(cmd))).toBe(hex(expected))
    expect(hex(encodeCommand(cmd))).toContain('3a00') // field 7, length 0
  })

  it('a Directory with an input SYMLINK matches protobufjs', () => {
    const dir: Directory = {
      files: [],
      directories: [],
      symlinks: [{ name: 'node_modules', target: '../.store/node_modules' }],
    }
    expect(hex(encodeDirectory(dir))).toBe(hex(refNonEmpty('Directory', dir)))
  })
})

describe('DECODER round-trip — protobufjs encodes, we decode', () => {
  // The mirror image of the encoder tests, and the one that catches the
  // deadliest class: a hand decoder with a wrong field number parses garbage
  // WITHOUT ERRORING. The first decodeActionResult read output_files (2) as
  // output_directories and stdout_raw (5) as a digest — found only against a
  // live NativeLink. This pins every field against the schema.
  it('a full ExecuteResponse survives', async () => {
    const { decodeExecuteResponseBytes } = await import('../src/executor.js')
    const outDigest = sha256(new TextEncoder().encode('artifact'))
    const stdoutDigest = sha256(new TextEncoder().encode('transformed\n'))
    const treeDigest = sha256(new TextEncoder().encode('tree'))
    const encoded = refNonEmpty('ExecuteResponse', {
      result: {
        output_files: [
          {
            path: 'out.txt',
            digest: outDigest,
            is_executable: true,
            contents: new TextEncoder().encode('artifact'),
          },
        ],
        output_directories: [{ path: 'dist', tree_digest: treeDigest }],
        output_symlinks: [{ path: 'link', target: '../t' }],
        exit_code: 3,
        stdout_digest: stdoutDigest,
        stderr_raw: new TextEncoder().encode('boom'),
        execution_metadata: { worker: 'worker-7' },
      },
      cached_result: true,
      status: { code: 0, message: '' },
      message: 'note',
    })
    const d = decodeExecuteResponseBytes(new Uint8Array(encoded))
    expect(d.message).toBe('note')
    expect(d.cachedResult).toBe(true)
    expect(d.result?.exit_code).toBe(3)
    expect(d.result?.output_files?.[0]?.path).toBe('out.txt')
    expect(d.result?.output_files?.[0]?.digest.hash).toBe(outDigest.hash)
    expect(d.result?.output_files?.[0]?.is_executable).toBe(true)
    expect(
      new TextDecoder().decode(d.result?.output_files?.[0]?.contents ?? new Uint8Array()),
    ).toBe('artifact')
    expect(d.result?.output_directories?.[0]?.path).toBe('dist')
    expect(d.result?.output_directories?.[0]?.tree_digest.hash).toBe(treeDigest.hash)
    expect(d.result?.output_symlinks?.[0]?.target).toBe('../t')
    expect(d.result?.stdout_digest?.hash).toBe(stdoutDigest.hash)
    expect(new TextDecoder().decode(d.result?.stderr_raw ?? new Uint8Array())).toBe('boom')
    expect(d.result?.execution_metadata?.worker).toBe('worker-7')
  })

  it('a failed execution with server logs survives', async () => {
    const { decodeExecuteResponseBytes } = await import('../src/executor.js')
    const logDigest = sha256(new TextEncoder().encode('worker log text'))
    const encoded = refNonEmpty('ExecuteResponse', {
      status: { code: 8, message: 'worker exploded' },
      server_logs: { 'worker.log': { digest: logDigest, human_readable: true } },
    })
    const d = decodeExecuteResponseBytes(new Uint8Array(encoded))
    expect(d.status).toEqual({ code: 8, message: 'worker exploded' })
    expect(d.serverLogs).toEqual([{ name: 'worker.log', digest: logDigest, humanReadable: true }])
  })

  it('a Tree blob decodes back to its directories', () => {
    const inner: Directory = {
      files: [{ name: 'x', digest: sha256(new Uint8Array([9])), is_executable: false }],
      directories: [],
      symlinks: [],
    }
    const rootDir: Directory = {
      files: [],
      directories: [{ name: 'sub', digest: sha256(encodeDirectory(inner)) }],
      symlinks: [{ name: 'ln', target: 'sub/x' }],
    }
    const treeBytes = refNonEmpty('Tree', { root: rootDir, children: [inner] })
    const { decodeTree } = require('../src/merkle.js') as typeof import('../src/merkle.js')
    const tree = decodeTree(new Uint8Array(treeBytes))
    expect(tree.root?.directories[0]?.name).toBe('sub')
    expect(tree.root?.symlinks[0]?.target).toBe('sub/x')
    expect(tree.children.length).toBe(1)
    expect(tree.children[0]?.files[0]?.name).toBe('x')
  })
})
