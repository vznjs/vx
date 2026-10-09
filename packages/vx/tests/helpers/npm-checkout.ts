// `npm install -D @vzn/…` as this checkout answers it: each named package
// and its bins linked from here, listed in the manifest, and a lockfile
// written. A suite that runs vx-migrate's own install and uninstall (`vx
// init` in a Turbo or Nx repo) gets an `npm` that does this for `@vzn` names
// and hands every other call to the real one. From the registry, either
// reconciled the tree and brought the RELEASED core, whose schema this
// checkout may have bumped, and a release whose peer ranges this
// checkout's versions miss failed it on ERESOLVE.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PACKAGES = path.resolve(import.meta.dir, '..', '..', '..')
const NAME = /^@vzn\/[\w-]+$/

/** Links `@vzn/<dir>` and its bins in `root` to this checkout's, over whatever is there. */
function link(root: string, dir: string): void {
  mkdirSync(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  const at = path.join(root, 'node_modules', '@vzn', dir)
  rmSync(at, { recursive: true, force: true })
  symlinkSync(path.join(PACKAGES, dir), at)
  const bins = (
    JSON.parse(readFileSync(path.join(PACKAGES, dir, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>
    }
  ).bin
  for (const [bin, rel] of Object.entries(bins ?? {})) {
    const to = path.join(root, 'node_modules', '.bin', bin)
    rmSync(to, { force: true })
    symlinkSync(path.join(PACKAGES, dir, rel), to)
  }
}

/** What `npm install -D <names>` leaves in `root`, from this checkout. */
export function installFromCheckout(root: string, names: readonly string[]): void {
  for (const name of names) link(root, name.slice('@vzn/'.length))
  // npm -D lists what it installs; vx-migrate installs a package the
  // manifest does not list.
  const manifest = path.join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
  const dev = { ...(pkg.devDependencies as Record<string, string> | undefined) }
  for (const name of names) dev[name] = '*'
  writeFileSync(manifest, JSON.stringify({ ...pkg, devDependencies: dev }, null, 2))
  // npm writes its lockfile on an install, and the migrator's report
  // names the lockfile plugin for it: a stand-in without one printed a
  // report no user sees.
  const lock = path.join(root, 'package-lock.json')
  if (!existsSync(lock)) writeFileSync(lock, '{"lockfileVersion":3,"packages":{}}\n')
}

/** What `npm uninstall <names>` leaves in `root`: the links and listings gone. */
function uninstall(root: string, names: readonly string[]): void {
  for (const name of names) {
    const dir = name.slice('@vzn/'.length)
    const bins = (
      JSON.parse(readFileSync(path.join(PACKAGES, dir, 'package.json'), 'utf8')) as {
        bin?: Record<string, string>
      }
    ).bin
    for (const bin of Object.keys(bins ?? {})) {
      rmSync(path.join(root, 'node_modules', '.bin', bin), { force: true })
    }
    rmSync(path.join(root, 'node_modules', '@vzn', dir), { recursive: true, force: true })
  }
  const manifest = path.join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field] as Record<string, string> | undefined
    if (deps !== undefined) for (const name of names) delete deps[name]
  }
  writeFileSync(manifest, JSON.stringify(pkg, null, 2))
}

let shim: string | undefined

/** `env` with an `npm` first on PATH that installs `@vzn` packages from this checkout. */
export function withCheckoutNpm(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (shim === undefined) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-npm-checkout-'))
    const npm = path.join(dir, 'npm')
    writeFileSync(npm, `#!/bin/sh\nexec '${process.execPath}' '${import.meta.path}' "$@"\n`)
    chmodSync(npm, 0o755)
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
    shim = dir
  }
  return {
    ...env,
    VX_CHECKOUT_NPM: shim,
    PATH: `${shim}${path.delimiter}${env['PATH'] ?? ''}`,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const ours = (names: readonly string[]): boolean =>
    names.length > 0 &&
    names.every((n) => NAME.test(n) && existsSync(path.join(PACKAGES, n.slice('@vzn/'.length))))
  if (args[0] === 'install' && args[1] === '-D' && ours(args.slice(2))) {
    installFromCheckout(process.cwd(), args.slice(2))
  } else if (args[0] === 'uninstall' && ours(args.slice(1))) {
    uninstall(process.cwd(), args.slice(1))
  } else {
    const own = process.env['VX_CHECKOUT_NPM']
    const PATH = (process.env['PATH'] ?? '')
      .split(path.delimiter)
      .filter((d) => d !== own)
      .join(path.delimiter)
    const r = Bun.spawnSync({
      cmd: ['npm', ...args],
      env: { ...process.env, PATH },
      stdio: ['inherit', 'inherit', 'inherit'],
    })
    process.exitCode = r.exitCode ?? 1
  }
}
