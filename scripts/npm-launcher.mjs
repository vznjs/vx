#!/usr/bin/env node
// npm launcher for the `vx` command — the entry the published `@vzn/vx`
// package's `bin` points at. It execs the prebuilt standalone binary shipped
// as a per-platform optionalDependency (@vzn/vx-<platform>), so end users get
// vx WITHOUT installing Bun. This file is authored for the PUBLISHED layout:
// at install time it sits at the package root, next to `src/`.
//
// Resolution order:
//   1. the matching @vzn/vx-<platform> optionalDependency's binary (the
//      normal path — esbuild/turborepo/biome model, no install-time download);
//   2. a source fallback: `bun src/bin.ts` (works in a source checkout, or on a
//      platform with no prebuilt binary if the user happens to have Bun).
// Anything else is a clear, actionable error.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

const PLATFORM_PACKAGES = {
  'linux-x64': '@vzn/vx-linux-x64',
  'linux-arm64': '@vzn/vx-linux-arm64',
  'darwin-x64': '@vzn/vx-darwin-x64',
  'darwin-arm64': '@vzn/vx-darwin-arm64',
}

const key = `${process.platform}-${process.arch}`
const args = process.argv.slice(2)

function platformBinary() {
  const pkg = PLATFORM_PACKAGES[key]
  if (pkg === undefined) return undefined
  try {
    // No `exports` restriction on the platform packages, so package.json
    // resolves; the binary sits beside it. Works under npm hoisting + pnpm.
    const manifest = require.resolve(`${pkg}/package.json`)
    const bin = join(dirname(manifest), 'vx')
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

function hasBun() {
  const probe = spawnSync('bun', ['--version'], { stdio: 'ignore' })
  return probe.status === 0
}

function run(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit' })
  if (res.error) {
    process.stderr.write(`vx: failed to launch (${res.error.message})\n`)
    process.exit(1)
  }
  // Mirror the child's exit; a signal death maps to the POSIX 128+signo code.
  if (res.signal) process.exit(1)
  process.exit(res.status ?? 0)
}

const bin = platformBinary()
if (bin !== undefined) {
  run(bin, args)
}

// No prebuilt binary for this platform — fall back to the shipped source if Bun
// is available (a source checkout, or an unsupported platform + Bun installed).
const sourceEntry = join(here, 'src', 'bin.ts')
if (existsSync(sourceEntry) && hasBun()) {
  run('bun', [sourceEntry, ...args])
}

const supported = Object.keys(PLATFORM_PACKAGES).join(', ')
process.stderr.write(
  `vx: no prebuilt binary for ${key}.\n` +
    `  Supported platforms: ${supported}.\n` +
    `  If your platform should be supported, reinstall so npm fetches the\n` +
    `  matching @vzn/vx-${key} optionalDependency, or install Bun (>=1.3) to\n` +
    `  run vx from source.\n`,
)
process.exit(1)
