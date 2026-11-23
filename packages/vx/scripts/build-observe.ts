#!/usr/bin/env bun
// Builds vx's Linux helpers from their C source:
// src/sandbox/observe/vx-observe-{x64,arm64} from vx-observe.c and
// src/exec/measure/vx-measure-{x64,arm64} from vx-measure.c.
//
//   bun scripts/build-observe.ts
//
// Each helper uses no libc, so one clang 18 with lld builds both
// architectures from any Linux or macOS machine. The binaries are
// committed: a run from source and `bun build --compile` both take them
// as files, and no machine that runs vx needs a compiler. `source.sha256`
// beside each names the source they were built from;
// tests/observe-helper.unsafe.test.ts and tests/measure-helper.test.ts refuse
// a source that moved on without them. The build is reproducible, so
// tests/helper-binaries.test.ts builds them again and refuses committed
// bytes no build of the source gives: a binary diff is one no review reads,
// and every vx ships these and runs one beside every Linux task.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const src = path.join(import.meta.dir, '..', 'src')

export const HELPERS = [
  { dir: path.join(src, 'sandbox', 'observe'), name: 'vx-observe' },
  { dir: path.join(src, 'exec', 'measure'), name: 'vx-measure' },
] as const

export const ARCHES = [
  ['x64', 'x86_64-linux-gnu'],
  ['arm64', 'aarch64-linux-gnu'],
] as const

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
  // No .comment naming the compiler's vendor and patch: any clang 18 gives these bytes.
  '-fno-ident',
  '-fuse-ld=lld',
  '-Wl,--build-id=none',
  '-Wl,-z,noexecstack',
  '-s',
]

/** The clang the committed bytes came from: another major emits other code. */
const CLANG_MAJOR = 18

/** A clang of `CLANG_MAJOR` on PATH with lld beside it, or undefined. */
export function clang(): string | undefined {
  if (Bun.which('ld.lld') === null && Bun.which(`ld.lld-${CLANG_MAJOR}`) === null) return undefined
  for (const name of [`clang-${CLANG_MAJOR}`, 'clang']) {
    const bin = Bun.which(name)
    if (bin === null) continue
    const v = Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'ignore' })
    if (new RegExp(`clang version ${CLANG_MAJOR}\\.`).test(v.stdout.toString())) return bin
  }
  return undefined
}

/** Builds `source` for `target` into `out`; the compiler's exit code. */
export function buildHelper(cc: string, source: string, target: string, out: string): number {
  const p = Bun.spawnSync([cc, `--target=${target}`, ...FLAGS, '-o', out, source], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return p.exitCode ?? 1
}

if (import.meta.main) {
  const cc = clang()
  if (cc === undefined) {
    console.error(`build-observe: needs clang ${CLANG_MAJOR} with lld on PATH`)
    process.exit(1)
  }
  for (const { dir, name } of HELPERS) {
    const source = path.join(dir, `${name}.c`)
    for (const [arch, target] of ARCHES) {
      const out = path.join(dir, `${name}-${arch}`)
      const code = buildHelper(cc, source, target, out)
      if (code !== 0) process.exit(code)
      console.log(`built ${path.relative(process.cwd(), out)}`)
    }
    writeFileSync(
      path.join(dir, 'source.sha256'),
      `${createHash('sha256').update(readFileSync(source)).digest('hex')}\n`,
    )
  }
}
