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
//   bun scripts/release.ts served

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { launchVersion } from './binary-launch.ts'
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
 * A platform package or `@vzn/vx` that fails stops the run: what follows
 * depends on it. A plugin that fails does not stop the other plugins, which
 * depend only on `@vzn/vx` (v0.0.648: a new plugin npm held no trusted
 * publisher for kept every plugin after it at 0.0.646); the run fails after
 * them, naming the first.
 */
export function publishAll(
  packages: Readonly<Array<{ name: string; dir: string; plugin?: boolean }>>,
  version: string,
  registry: Registry,
  log: (line: string) => void,
): void {
  let failed: unknown
  for (const { name, dir, plugin } of packages) {
    log(`::group::npm publish ${name}@${version} (${dir})`)
    if (registry.has(`${name}@${version}`)) {
      log(`${name}@${version} already on the registry — skipping`)
    } else if (plugin === true) {
      try {
        registry.publish(dir)
      } catch (e) {
        failed ??= e
      }
    } else {
      registry.publish(dir)
    }
    log('::endgroup::')
  }
  if (failed !== undefined) throw failed
}

/**
 * `publishAll`, with `settle` between the platform packages and `@vzn/vx`.
 * npm shows a published version when it has processed it, not when the
 * publish returns, and not in order: `@vzn/vx@0.0.656` was installable 5
 * minutes before `@vzn/vx-linux-x64@0.0.656` (0.0.654: 2 minutes), and an
 * install in that window took no binary. So `@vzn/vx` is published only
 * once the registry shows every platform package it names.
 */
export async function publishSettled(
  packages: Readonly<Array<{ name: string; dir: string; plugin?: boolean }>>,
  version: string,
  registry: Registry,
  settle: (platforms: string[]) => Promise<void>,
  log: (line: string) => void,
): Promise<void> {
  const at = packages.findIndex((p) => p.name === '@vzn/vx')
  if (at === -1) return publishAll(packages, version, registry, log)
  publishAll(packages.slice(0, at), version, registry, log)
  await settle(packages.slice(0, at).map((p) => p.name))
  publishAll(packages.slice(at), version, registry, log)
}

/** Where the registry shows a version once it has processed its publish. */
const versionUrl = (name: string, version: string): string =>
  `https://registry.npmjs.org/${name}/${version}`

/**
 * The dist-tag a publish of `version` takes when `latest` is above it: npm
 * refuses to move `latest` down, so a rebuilt older tag (v0.0.647 after
 * v0.0.648) publishes as `backfill` and `latest` stays where it is.
 */
export function publishTag(version: string, latest: string | undefined): string | undefined {
  return latest !== undefined && Bun.semver.order(version, latest) < 0 ? 'backfill' : undefined
}

/**
 * The `npm publish` command line. Verbose: npm logs every trusted
 * publishing refusal (no id-token, a failed token exchange) only at that
 * level, and without it v0.0.651's darwin publish failed as a bare
 * ENEEDAUTH.
 */
export function publishCommand(npm: string, dir: string, tag: string | undefined): string[] {
  const args = [npm, 'publish', dir, '--access', 'public', '--provenance', '--loglevel', 'verbose']
  return tag === undefined ? args : [...args, '--tag', tag]
}

/**
 * The claims npm's trusted publishing matches, from a GitHub OIDC token
 * (never the token itself): a refused exchange says only "package not
 * found", so the log shows what npm was sent (v0.0.651, npm/cli#9969).
 */
export function oidcClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1] ?? ''
  const all = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
  const keep = [
    'sub',
    'repository',
    'repository_owner',
    'environment',
    'job_workflow_ref',
    'ref',
    'aud',
  ]
  return Object.fromEntries(keep.filter((k) => k in all).map((k) => [k, all[k]]))
}

async function printOidcClaims(): Promise<void> {
  const url = process.env['ACTIONS_ID_TOKEN_REQUEST_URL']
  const token = process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']
  if (url === undefined || token === undefined) {
    console.log('oidc: no id-token request in this job')
    return
  }
  try {
    const res = await fetch(`${url}&audience=npm:registry.npmjs.org`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const { value } = (await res.json()) as { value: string }
    console.log(`oidc claims: ${JSON.stringify(oidcClaims(value))}`)
  } catch (e) {
    console.log(`oidc: could not read the id-token: ${(e as Error).message}`)
  }
}

/** Where npm serves `name@version`'s tarball. */
export const tarballUrl = (name: string, version: string): string =>
  `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`

/**
 * Wait until every url answers 200. npm's CDN can 404 a just-published
 * tarball for minutes (v0.0.646's linux-x64: ~4 min), and an install in that
 * window fails, so a release is done only when each one downloads.
 */
export async function awaitServed(
  urls: readonly string[],
  status: (url: string) => Promise<number>,
  wait: { tries: number; sleep: () => Promise<void> },
  log: (line: string) => void,
): Promise<void> {
  let left = [...urls]
  for (let i = 0; ; i++) {
    const codes = await Promise.all(left.map(status))
    left = left.filter((_, j) => codes[j] !== 200)
    if (left.length === 0) return
    if (i + 1 >= wait.tries) throw new Error(`npm does not serve:\n  ${left.join('\n  ')}`)
    log(`waiting for npm to serve ${left.length}: ${left.join(' ')}`)
    await wait.sleep()
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
    // Every darwin binary launches here: an arm64 runner runs the x64 one
    // under Rosetta. `codesign --verify` under seatbelt is refused
    // (system-fsctl, no grant lifts it), so a launch is the proof.
    if (t.target !== host && os !== 'darwin') continue
    const got = launchVersion(bin)
    if (got.exitCode !== 0 || got.version !== want) {
      throw new Error(
        `${path.relative(CORE, bin)} reports '${got.version}' (exit ${got.exitCode}), expected '${want}' — the version stamp missed the manifest the binary inlines\n${got.stderr}`,
      )
    }
    console.log(`${path.relative(CORE, bin)} reports ${got.version}`)
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

async function publish(os: Os, version: string): Promise<void> {
  await printOidcClaims()
  const pluginsDir = path.join(TREE, 'plugins')
  const plugins = existsSync(pluginsDir) ? readdirSync(pluginsDir) : []
  const packages = publishOrder(os, plugins).map((rel) => {
    const dir = path.join(TREE, rel)
    const { name } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name: string
    }
    return { name, dir, plugin: rel.startsWith('plugins/') }
  })
  const npm = npmBin()
  const latest = Bun.spawnSync({
    cmd: [npm, 'view', '@vzn/vx', 'dist-tags.latest'],
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const tag = publishTag(
    version,
    latest.exitCode === 0 ? latest.stdout.toString().trim() || undefined : undefined,
  )
  // No NODE_AUTH_TOKEN: npm exchanges the job's OIDC token for a
  // short-lived publish credential (trusted publishing) and attaches
  // provenance. A set token would take precedence, and npm restricts
  // classic tokens for direct publishing (the E401 that stopped v0.0.17).
  await publishSettled(
    packages,
    version,
    {
      has: (spec) =>
        Bun.spawnSync({ cmd: [npm, 'view', spec, 'version'], stdout: 'ignore', stderr: 'ignore' })
          .exitCode === 0,
      publish: (dir) => {
        const r = Bun.spawnSync({
          cmd: publishCommand(npm, dir, tag),
          stdout: 'inherit',
          stderr: 'inherit',
        })
        if (r.exitCode !== 0) throw new Error(`npm publish ${dir} failed (exit ${r.exitCode})`)
      },
    },
    // The darwin ones too: their job published them before this one ran.
    (platforms) =>
      awaitServed(
        [...publishOrder('darwin', []), ...platforms].flatMap((n) => [
          versionUrl(n, version),
          tarballUrl(n, version),
        ]),
        headStatus,
        { tries: 90, sleep: () => Bun.sleep(10_000) },
        (line) => console.log(line),
      ),
    (line) => console.log(line),
  )
}

const headStatus = async (url: string): Promise<number> => {
  const res = await fetch(url, { method: 'HEAD' }).catch(() => undefined)
  return res?.status ?? 0
}

// Every package both publish jobs sent: the linux job runs last, so
// the darwin packages are already published.
async function served(version: string): Promise<void> {
  const pluginsDir = path.join(TREE, 'plugins')
  const plugins = existsSync(pluginsDir) ? readdirSync(pluginsDir) : []
  const names = [
    ...publishOrder('darwin', []),
    ...publishOrder('linux', plugins).map(
      (rel) =>
        (JSON.parse(readFileSync(path.join(TREE, rel, 'package.json'), 'utf8')) as { name: string })
          .name,
    ),
  ]
  await awaitServed(
    names.map((n) => tarballUrl(n, version)),
    headStatus,
    { tries: 90, sleep: () => Bun.sleep(10_000) },
    (line) => console.log(line),
  )
  console.log(`npm serves all ${names.length} tarballs at ${version}`)
}

async function main(argv: readonly string[]): Promise<void> {
  const [step, os] = argv
  if (step === 'npm') return ensureNpm()
  const version = releaseVersion(process.env['VX_RELEASE_VERSION'])
  if (step === 'stamp') return stamp(version)
  if (step === 'served') return served(version)
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
