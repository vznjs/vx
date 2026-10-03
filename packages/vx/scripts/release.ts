// The release steps npm.yml and release.yml run, each a `release.*` task in
// vx.config.ts: CI runs vx tasks, never its own commands (owner,
// 2026-10-03). The version is VX_RELEASE_VERSION, the release tag or the
// dispatch input exactly as the workflow received it: it arrives through
// the environment, never pasted into a script, and must be a version (L-28).
//
//   bun scripts/release.ts stamp
//   bun scripts/release.ts npm
//   bun scripts/release.ts prove <linux|darwin>
//   bun scripts/release.ts assemble <linux|darwin>
//   bun scripts/release.ts publish <linux|darwin>

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { launchVersion, resign } from './binary-launch.ts'
import { TARGETS, emitMainPackage, emitPlatformPackages, emitPluginPackages } from './build-npm.ts'

const CORE = path.resolve(import.meta.dir, '..')
const DIST = path.join(CORE, 'dist')
const TREE = path.join(DIST, 'npm')
// An npm installed here when the runner's own cannot publish with
// provenance. A prefix of our own, never `npm i -g` over the runner's: that
// in-place self-upgrade (node 22's npm 10.x → latest) corrupted npm's own
// tree and left `libnpmpublish` unable to `require('sigstore')`.
const NPM_PREFIX = path.join(DIST, 'npm-cli')
const NPM_PREFIX_BIN = path.join(NPM_PREFIX, 'bin', 'npm')

type Os = 'linux' | 'darwin'

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/

/** The version a release tag or dispatch input names, without its `v`. */
export function releaseVersion(raw: string | undefined): string {
  if (raw === undefined || raw === '') throw new Error('no version (not a release and no input)')
  const version = raw.replace(/^v/, '')
  if (!VERSION.test(version)) throw new Error(`not a version: ${raw}`)
  return version
}

/** npm >= 11.5.1 exchanges the job's OIDC token (trusted publishing). */
export function supportsTrustedPublishing(npmVersion: string): boolean {
  const [a = 0, b = 0, c = 0] = npmVersion.split('-')[0]!.split('.').map(Number)
  return a > 11 || (a === 11 && (b > 5 || (b === 5 && c >= 1)))
}

/**
 * The package directories `publish <os>` publishes, under the assembled
 * tree, in order. The platform binaries first, so `@vzn/vx`'s
 * optionalDependencies resolve on the registry; the darwin ones come from
 * npm.yml's darwin job, which can sign them, and run before the linux job.
 * `@vzn/vx` after every platform package, and the plugins after it: each
 * peer-depends on it.
 */
export function publishOrder(os: Os, plugins: readonly string[]): string[] {
  const platforms = TARGETS.filter((t) => t.os === os).map((t) => `@vzn/vx-${t.target}`)
  if (os === 'darwin') return platforms
  return [...platforms, 'vx', ...[...plugins].sort().map((p) => `plugins/${p}`)]
}

export interface Registry {
  /** `npm view <spec> version` succeeded. */
  has(spec: string): boolean
  publish(dir: string): void
}

/**
 * Publish each package the registry does not hold at `version`. Idempotent:
 * a sequential publish can fail partway (a transient registry error, an
 * earlier abort), and npm refuses to republish a version, so a re-run skips
 * what landed and completes the set instead of dying on the first one.
 */
export function publishAll(
  packages: Readonly<Array<{ name: string; dir: string }>>,
  version: string,
  registry: Registry,
  log: (line: string) => void,
): void {
  for (const { name, dir } of packages) {
    log(`::group::npm publish ${name}@${version} (${dir})`)
    if (registry.has(`${name}@${version}`)) {
      log(`${name}@${version} already on the registry — skipping`)
    } else {
      registry.publish(dir)
    }
    log('::endgroup::')
  }
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b)

function run(cmd: string[]): string {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed (exit ${r.exitCode})`)
  return text(r.stdout).trim()
}

// Emptied, not removed: under the sandbox the directory is the write
// grant's mount point, and removing a mount point is EROFS.
function empty(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const entry of readdirSync(dir))
    rmSync(path.join(dir, entry), { recursive: true, force: true })
}

/** The npm `npm` runs `publish` with: the repaired one when there is one. */
const npmBin = (): string => (existsSync(NPM_PREFIX_BIN) ? NPM_PREFIX_BIN : 'npm')

async function stamp(version: string): Promise<void> {
  // packages/vx/package.json is the manifest `src/version.ts` inlines under
  // `bun build --compile`, so it is stamped BEFORE compiling; stamping the
  // root one (as the workflows did until 2026-09-03) left every binary at
  // `vx 0.0.0`. Ephemeral: CI only, never committed. `prove` asserts it took.
  const file = path.join(CORE, 'package.json')
  const manifest = (await Bun.file(file).json()) as { version: string }
  manifest.version = version
  await Bun.write(file, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`stamped ${path.relative(CORE, file)} with ${version}`)
}

// Trusted publishing needs npm >= 11.5.1, and provenance (auto-enabled under
// OIDC) needs `libnpmpublish` to `require('sigstore')` — a missing one
// aborted a release mid-publish with a cryptic MODULE_NOT_FOUND. So check
// both before anything publishes: upgrade only an npm too old, repair a
// missing sigstore with a forced clean install, and fail with a clear
// message if it still cannot load.
function ensureNpm(): void {
  empty(NPM_PREFIX)
  const current = run(['npm', '--version'])
  console.log(`bundled npm: ${current}`)
  let npm = 'npm'
  const install = (...flags: string[]): void => {
    run(['npm', 'install', '-g', 'npm@latest', ...flags, '--prefix', NPM_PREFIX])
    npm = NPM_PREFIX_BIN
    console.log(run([npm, '--version']))
  }
  if (supportsTrustedPublishing(current)) {
    console.log(`npm ${current} already supports trusted publishing — using it as-is`)
  } else {
    console.log(`bundled npm ${current} too old; upgrading`)
    install()
  }
  // sigstore lives under the active npm's own node_modules.
  const resolves = (): boolean => {
    const root = path.join(
      run([npm, 'root', '-g', ...(npm === 'npm' ? [] : ['--prefix', NPM_PREFIX])]),
      'npm',
    )
    try {
      createRequire(path.join(root, 'package.json')).resolve('sigstore')
      return true
    } catch {
      return false
    }
  }
  if (resolves()) {
    console.log("provenance dep 'sigstore' resolves OK")
    return
  }
  console.log("'sigstore' missing from npm — repairing with a forced clean reinstall")
  install('--force')
  if (!resolves()) {
    throw new Error(
      "::error::npm cannot load 'sigstore' for provenance generation; publish would crash. Aborting before the publish loop.",
    )
  }
  console.log("repaired — 'sigstore' now resolves")
}

function prove(os: Os, version: string): void {
  const want = `vx ${version}`
  const host = `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  for (const t of TARGETS.filter((t) => t.os === os)) {
    const bin = path.join(DIST, `vx-${t.target}`)
    // release.yml hands the darwin binaries over as an artifact, and a
    // download drops the executable bit.
    if (os === 'darwin') chmodSync(bin, 0o755)
    if (t.target === host) {
      const got = launchVersion(bin)
      if (got.exitCode !== 0 || got.version !== want) {
        throw new Error(
          `binary reports '${got.version}' (exit ${got.exitCode}), expected '${want}' — the version stamp missed the manifest the binary inlines\n${got.stderr}`,
        )
      }
      console.log(`${path.relative(CORE, bin)} reports ${got.version}`)
    } else if (os === 'darwin') {
      // A darwin binary this host cannot launch: its signature must still
      // hold, re-signed ad hoc where it does not.
      const verify = Bun.spawnSync({ cmd: ['codesign', '--verify', '--verbose=2', bin] })
      if (verify.exitCode !== 0) {
        const failed = resign(bin)
        if (failed !== undefined) throw new Error(failed)
      }
      console.log(`${path.relative(CORE, bin)} carries a valid signature`)
    }
  }
}

async function assemble(os: Os, version: string): Promise<void> {
  empty(TREE)
  const targets = TARGETS.filter((t) => t.os === os)
  await emitPlatformPackages({
    mainName: '@vzn/vx',
    base: 'vx',
    distPrefix: 'vx',
    targets,
    version,
    outDir: TREE,
  })
  const names = targets.map((t) => `@vzn/vx-${t.target}`)
  if (os === 'linux') {
    await emitMainPackage({ version, outDir: TREE })
    // Every other public workspace package, at the same version and
    // peer-pinned to this @vzn/vx. Discovered, so a new plugin package is
    // published without an edit here.
    const plugins = await emitPluginPackages({ version, outDir: TREE })
    names.push('@vzn/vx', ...plugins.map((p) => p.name))
  }
  console.log(`assembled ${path.relative(CORE, TREE)} at ${version}:\n  ${names.join('\n  ')}`)
}

function publish(os: Os, version: string): void {
  const pluginsDir = path.join(TREE, 'plugins')
  const plugins = existsSync(pluginsDir) ? readdirSync(pluginsDir) : []
  const packages = publishOrder(os, plugins).map((rel) => {
    const dir = path.join(TREE, rel)
    const { name } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name: string
    }
    return { name, dir }
  })
  const npm = npmBin()
  // No NODE_AUTH_TOKEN: npm exchanges the job's OIDC token for a
  // short-lived publish credential (trusted publishing) and attaches
  // provenance. A set token would take precedence, and npm restricts
  // classic tokens for direct publishing (the E401 that stopped v0.0.17).
  publishAll(
    packages,
    version,
    {
      has: (spec) =>
        Bun.spawnSync({ cmd: [npm, 'view', spec, 'version'], stdout: 'ignore', stderr: 'ignore' })
          .exitCode === 0,
      publish: (dir) => {
        const r = Bun.spawnSync({
          cmd: [npm, 'publish', dir, '--access', 'public', '--provenance'],
          stdout: 'inherit',
          stderr: 'inherit',
        })
        if (r.exitCode !== 0) throw new Error(`npm publish ${dir} failed (exit ${r.exitCode})`)
      },
    },
    (line) => console.log(line),
  )
}

async function main(argv: readonly string[]): Promise<void> {
  const [step, os] = argv
  if (step === 'npm') return ensureNpm()
  const version = releaseVersion(process.env['VX_RELEASE_VERSION'])
  if (step === 'stamp') return stamp(version)
  if (os !== 'linux' && os !== 'darwin') throw new Error(`usage: release.ts ${step} <linux|darwin>`)
  if (step === 'prove') return prove(os, version)
  if (step === 'assemble') return assemble(os, version)
  if (step === 'publish') return publish(os, version)
  throw new Error(`unknown step: ${step}`)
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    process.exitCode = 1
  }
}
