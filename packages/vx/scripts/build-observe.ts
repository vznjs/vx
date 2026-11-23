#!/usr/bin/env bun
// Builds vx's Linux helpers from their C source:
// src/sandbox/observe/vx-observe-{x64,arm64} from vx-observe.c and
// src/exec/measure/vx-measure-{x64,arm64} from vx-measure.c.
//
//   bun scripts/build-observe.ts
//
// Each helper uses no libc, so one clang 20.1.8 with lld builds both
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  // No .comment naming the compiler's vendor and patch: any build of clang 20.1.8 gives these bytes.
  '-fno-ident',
  '-fuse-ld=lld',
  '-Wl,--build-id=none',
  '-Wl,-z,noexecstack',
  '-s',
]

/**
 * The clang the committed bytes came from, to the patch: 20.1.2 and 20.1.8
 * emit other code. 20.1.8 is LLVM 20's last release, and GitHub's Ubuntu
 * runners carry it (Ubuntu 26.04's clang-20). Anywhere else, build in that
 * image:
 *
 *   docker run --rm -v "$PWD":/w -v "$(command -v bun)":/usr/local/bin/bun -w /w/packages/vx \
 *     ubuntu:26.04 sh -c 'apt-get update && apt-get install -y clang-20 lld-20 && bun scripts/build-observe.ts'
 */
const CLANG_VERSION = '20.1.8'
const CLANG_MAJOR = CLANG_VERSION.split('.')[0]

/** A clang of `CLANG_VERSION` on PATH whose own lld it finds, or undefined. */
export function clang(): string | undefined {
  for (const name of [`clang-${CLANG_MAJOR}`, 'clang']) {
    const bin = Bun.which(name)
    if (bin === null) continue
    const v = Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'ignore' })
    if (!v.stdout.toString().includes(`clang version ${CLANG_VERSION} `)) continue
    // lld beside it, as `-fuse-ld=lld` looks: an answer that is no path is none found.
    const lld = Bun.spawnSync([bin, '-print-prog-name=ld.lld'], { stdout: 'pipe' })
    if (existsSync(lld.stdout.toString().trim())) return bin
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
    console.error(
      `build-observe: needs clang ${CLANG_VERSION} with its lld on PATH (see the docker line above)`,
    )
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
