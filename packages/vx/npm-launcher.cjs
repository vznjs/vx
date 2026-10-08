#!/usr/bin/env node
// npm launcher for a vx command — the entry a published package's `bin` points
// at. It execs the prebuilt standalone binary shipped as a per-platform
// optionalDependency, so end users get the command WITHOUT installing Bun.
// Everything is derived from this package's OWN name, read from the
// package.json sitting beside this file, so any package built by
// scripts/build-npm.ts can carry it:
//
//   @vzn/vx → platform pkg @vzn/vx-<key>, binary `vx`
//
// Resolution order:
//   1. the matching <name>-<platform> optionalDependency's binary (the normal
//      path — esbuild/turborepo/biome model, no install-time download);
//   2. a source fallback: `bun <sourceEntry>` (a source checkout, or a platform
//      with no prebuilt binary if the user happens to have Bun).
// Anything else is a clear, actionable error.

// CommonJS, not ESM: Node's ESM loader cost every `vx` call ~8 ms of a
// ~65 ms launch (min of 21, interleaved, Node 22, 2026-10-01).
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const { existsSync, readFileSync, realpathSync } = require('node:fs')
const { constants: osConstants } = require('node:os')
const { dirname, join } = require('node:path')

// The real directory, not `__dirname`: npm's `node_modules/.bin/vx` is a
// symlink to this file, and under `--preserve-symlinks-main` (NODE_OPTIONS)
// `__dirname` is `.bin`, where `./package.json` does not resolve and
// the launcher died MODULE_NOT_FOUND before vx started.
const here = dirname(realpathSync(__filename))
const pkg = require(join(here, 'package.json'))

// Derive the platform-package prefix + binary basename from this package's
// name. `base` is the unscoped name — the command AND the binary filename
// inside the platform package. `vxSourceEntry` (a package.json field) is the
// source-mode entry, `src/bin.ts` by default.
const name = pkg.name
const base = name.replace(/^@[^/]+\//, '')
const sourceEntry = pkg.vxSourceEntry ?? 'src/bin.ts'

const SUPPORTED = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
const key = `${process.platform}-${process.arch}`
const args = process.argv.slice(2)

// The prebuilt Linux binaries link glibc. On musl (Alpine) the loader they
// name is absent, execve fails with ENOENT on a file that exists, and the
// user read "failed to launch (spawn … ENOENT)". Treated as no binary here,
// so Bun runs the source when present and the error names the cause.
const GLIBC_LOADER = { x64: '/lib64/ld-linux-x86-64.so.2', arm64: '/lib/ld-linux-aarch64.so.1' }
const noGlibc = process.platform === 'linux' && !existsSync(GLIBC_LOADER[process.arch] ?? '/')

function platformBinary() {
  if (!SUPPORTED.includes(key) || noGlibc) return undefined
  const platformPkg = `${name}-${key}`
  try {
    // No `exports` restriction on the platform packages, so package.json
    // resolves; the binary sits beside it. Works under npm hoisting + pnpm.
    const manifest = require.resolve(`${platformPkg}/package.json`)
    const bin = join(dirname(manifest), base)
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

function hasBun() {
  const probe = spawnSync('bun', ['--version'], { stdio: 'ignore' })
  return probe.status === 0
}

// Is this launcher in its terminal's foreground process group? Then a
// keyboard Ctrl-C reached the binary too, and a forward would be its second
// signal, which vx reads as "stop now".
function inForeground() {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return f[2] === f[5] // pgrp === tpgid
  } catch {
    try {
      const out = execFileSync('ps', ['-o', 'pgid=,tpgid=', '-p', String(process.pid)], {
        encoding: 'utf8',
      })
      const [pgid, tpgid] = out.trim().split(/\s+/)
      return pgid === tpgid
    } catch {
      return false
    }
  }
}

function run(cmd, cmdArgs) {
  const child = spawn(cmd, cmdArgs, { stdio: 'inherit' })
  // A signal sent to this launcher alone (`kill`, a process manager, a CI
  // cancel) reaches vx only through here; unhandled, it killed the launcher
  // and left vx running under init. Either way the launcher waits for vx.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      if (!inForeground()) child.kill(sig)
    })
  }
  child.on('error', (err) => {
    process.stderr.write(`${base}: failed to launch (${err.message})\n`)
    process.exit(1)
  })
  // Mirror the child's exit; a signal death maps to the POSIX 128+signo code.
  child.on('exit', (code, signal) => {
    process.exit(signal ? 128 + (osConstants.signals[signal] ?? 1) : (code ?? 0))
  })
}

const bin = platformBinary()
// No prebuilt binary for this platform — fall back to the shipped source if Bun
// is available (a source checkout, or an unsupported platform + Bun installed).
const source = join(here, sourceEntry)
if (bin !== undefined) {
  // Node >= 22.15 replaces this process with vx: no child to spawn, wait
  // for and forward signals to, ~9 ms of a ~54 ms launch (min of 21,
  // interleaved, Node 22.22, 2026-10-01). Older Node spawns.
  if (typeof process.execve === 'function') {
    try {
      process.execve(bin, [bin, ...args], process.env)
    } catch {
      // A refusal (a binary execve cannot start) falls back to the spawn,
      // which reports it.
    }
  }
  run(bin, args)
} else if (existsSync(source) && hasBun()) {
  run('bun', ['--no-env-file', '--no-install', source, ...args])
} else {
  const supported = SUPPORTED.join(', ')
  process.stderr.write(
    `${base}: no prebuilt binary for ${key}${noGlibc ? ' without glibc (musl)' : ''}.\n` +
      `  Supported platforms: ${supported}.\n` +
      `  If your platform should be supported, reinstall so npm fetches the\n` +
      `  matching ${name}-${key} optionalDependency, or install Bun (>=1.4) to\n` +
      `  run ${base} from source.\n`,
  )
  process.exit(1)
}
