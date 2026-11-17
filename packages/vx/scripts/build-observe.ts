#!/usr/bin/env bun
// Builds src/sandbox/observe/vx-observe-{x64,arm64} from vx-observe.c.
//
//   bun scripts/build-observe.ts
//
// The helper uses no libc, so one clang with lld builds both
// architectures from any Linux or macOS machine. The binaries are
// committed: a run from source and `bun build --compile` both take them
// as files, and no machine that runs vx needs a compiler. `source.sha256`
// names the source they were built from; tests/observe-helper.test.ts
// refuses a source that moved on without them.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dir = path.join(import.meta.dir, '..', 'src', 'sandbox', 'observe')
const source = path.join(dir, 'vx-observe.c')

const FLAGS = [
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-ffreestanding',
  '-nostdlib',
  '-static',
  '-fno-stack-protector',
  '-fno-asynchronous-unwind-tables',
  '-fno-unwind-tables',
  '-fno-pic',
  '-fuse-ld=lld',
  '-Wl,--build-id=none',
  '-Wl,-z,noexecstack',
  '-s',
]

for (const [arch, target] of [
  ['x64', 'x86_64-linux-gnu'],
  ['arm64', 'aarch64-linux-gnu'],
] as const) {
  const out = path.join(dir, `vx-observe-${arch}`)
  const p = Bun.spawnSync(['clang', `--target=${target}`, ...FLAGS, '-o', out, source], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1)
  console.log(`built ${path.relative(process.cwd(), out)}`)
}
writeFileSync(
  path.join(dir, 'source.sha256'),
  `${createHash('sha256').update(readFileSync(source)).digest('hex')}\n`,
)
