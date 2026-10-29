// `vx setup github` / `vx setup gitlab`: what a CI machine needs before
// `vx run` can run a sandboxed task. On Linux: bubblewrap, socat, strace
// and ripgrep, bwrap allowed its user namespaces, and a proof it runs. On
// macOS the sandbox is built in. A step of the job, before vx runs; the
// verb is the plugin's, so a repo on neither CI has none.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ui, UserError } from '@vzn/vx'

const PACKAGES = ['bubblewrap', 'socat', 'strace', 'ripgrep']
const BINARIES = ['bwrap', 'socat', 'strace', 'rg']

/** A command's exit code; it writes to this process's stdout and stderr. */
export type Shell = (argv: readonly string[]) => Promise<number>

const shell: Shell = (argv) =>
  Bun.spawn([...argv], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }).exited

export interface SetupOptions {
  readonly ci: 'github' | 'gitlab'
  /** Where fetched packages are kept, for the job's cache to save and restore. */
  readonly debs: string
  readonly platform?: NodeJS.Platform
  readonly root?: boolean
  readonly sh?: Shell
  readonly has?: (bin: string) => boolean
  /** GitHub's step output file: `fetched=true` when packages were fetched. */
  readonly output?: string | undefined
  readonly print?: (line: string) => void
  /** Whether the kernel lets a program make user namespaces only under an AppArmor profile. */
  readonly restricted?: () => boolean
}

const userns = (): boolean => {
  try {
    return (
      readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'
    )
  } catch {
    return false
  }
}

export async function setup(o: SetupOptions): Promise<number> {
  const print = o.print ?? ((l: string) => ui.say('info', l, 'out'))
  const platform = o.platform ?? process.platform
  if (platform === 'darwin') {
    print('vx setup: macOS has its sandbox built in; nothing to set up')
    return 0
  }
  if (platform !== 'linux') throw new UserError(`vx setup: ${platform} has no vx sandbox`)
  const sh = o.sh ?? shell
  const has = o.has ?? ((bin: string) => Bun.which(bin) !== null)
  const sudo = (o.root ?? process.getuid?.() === 0) ? [] : ['sudo']
  const run = async (argv: readonly string[]): Promise<void> => {
    const code = await sh([...sudo, ...argv])
    if (code !== 0) throw new UserError(`vx setup: \`${argv.join(' ')}\` exited ${code}`)
  }
  let fetched = false
  const missing = BINARIES.filter((b) => !has(b))
  const debs = readdir(o.debs).filter((f) => f.endsWith('.deb'))
  // What the job's cache restored, else fetched: kept from an older
  // image, they may not install, and a set fetched where the image had a
  // package already holds no deb of it.
  const kept =
    missing.length > 0 &&
    debs.length > 0 &&
    (await sh([...sudo, 'dpkg', '-i', ...debs.map((f) => path.join(o.debs, f))])) === 0 &&
    BINARIES.every((b) => has(b))
  if (missing.length > 0 && !kept) {
    if (has('apt-get')) {
      await run(['rm', '-rf', o.debs])
      // man-db re-indexes every page on each install: seconds for nothing.
      await run(['rm', '-f', '/var/lib/man-db/auto-update'])
      // Only the distribution's own index is needed: a third-party source
      // (Chrome, Microsoft on GitHub's images) serving a stale index fails
      // `apt-get update` before vx runs at all (2026-09-09).
      if (existsSync('/etc/apt/sources.list.d/ubuntu.sources'))
        await run([
          'find',
          '/etc/apt/sources.list.d',
          '-type',
          'f',
          '!',
          '-name',
          'ubuntu.sources',
          '-delete',
        ])
      await run(['apt-get', 'update'])
      await mkdir(path.join(o.debs, 'partial'), { recursive: true })
      await run([
        'apt-get',
        'install',
        '-y',
        '-o',
        `Dir::Cache::Archives=${o.debs}`,
        '-o',
        'APT::Keep-Downloaded-Packages=true',
        ...PACKAGES,
      ])
      await run(['rm', '-rf', path.join(o.debs, 'partial'), path.join(o.debs, 'lock')])
      await run(['chown', '-R', os.userInfo().username, o.debs])
      fetched = true
    } else if (has('apk')) {
      await run(['apk', 'add', '--no-cache', ...PACKAGES])
    } else {
      throw new UserError(
        `vx setup: ${missing.join(', ')} missing and no apt-get or apk to install ${PACKAGES.join(' ')}`,
      )
    }
  }
  // Ubuntu 24+ lets a program make user namespaces only under an AppArmor
  // profile granting `userns` (discourse.ubuntu.com/t/58007). Ubuntu 26
  // ships bwrap-userns-restrict instead, which strips the capabilities of
  // the namespace nested in bwrap's, where the sandbox applies seccomp:
  // every sandboxed task failed "nested userns is capability-restricted"
  // (2026-10-23). bwrap gets the plain profile in its place.
  if ((o.restricted ?? userns)()) {
    if (existsSync('/etc/apparmor.d/bwrap-userns-restrict')) {
      await run(['apparmor_parser', '-R', '/etc/apparmor.d/bwrap-userns-restrict'])
      await run(['rm', '/etc/apparmor.d/bwrap-userns-restrict'])
    }
    const profile = path.join(os.tmpdir(), `vx-bwrap-${process.pid}.apparmor`)
    await writeFile(
      profile,
      'abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n',
    )
    await run(['cp', profile, '/etc/apparmor.d/bwrap'])
    await run(['apparmor_parser', '-r', '/etc/apparmor.d/bwrap'])
  }
  // GitLab keeps it in the checkout, where a root task's `**` keyed the
  // debs: a job that had them missed every hit saved without them.
  if (existsSync(o.debs)) await writeFile(path.join(o.debs, '.gitignore'), '*\n')
  if (o.output !== undefined && o.output !== '')
    await writeFile(o.output, `fetched=${fetched}\n`, { flag: 'a' })
  // The proof: a sandbox that cannot start fails here, named, not as every
  // sandboxed task's failure later.
  const code = await sh([
    'bwrap',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '/bin/true',
  ])
  if (code !== 0)
    throw new UserError(
      `vx setup: bwrap cannot start a sandbox here (exit ${code}): the machine must allow user namespaces`,
    )
  print(`vx setup: the sandbox runs on this ${o.ci === 'github' ? 'runner' : 'job'}`)
  return 0
}

function readdir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * The key to save fetched packages under: this runner image's, after the
 * `vx-setup-debs-<runner.os>-<runner.arch>-` a job restores by. Led by the
 * image alone, no restore ever matched it and every worker fetched again
 * (main, 2026-10-23: 6-55 s of each worker's start).
 */
export function debsKey(env: Record<string, string | undefined>): string {
  return `vx-setup-debs-${env['RUNNER_OS'] ?? ''}-${env['RUNNER_ARCH'] ?? ''}-${env['ImageOS'] ?? ''}-${env['ImageVersion'] ?? ''}`
}

/** The `setup` verb of `github()` or `gitlab()`: `vx setup <ci> [--debs <dir>]`. */
export async function runSetup(
  ci: 'github' | 'gitlab',
  argv: readonly string[],
  defaultDebs: string,
): Promise<number> {
  const usage = `Usage: vx setup ${ci} [--debs <dir>]`
  // Asked for, the usage is an answer: `vx setup --help` exited 1 (2026-10-26).
  if (argv.includes('--help') || argv.includes('-h')) {
    ui.say('info', usage, 'out')
    return 0
  }
  // The bare usage said nothing of what was wrong with the line typed.
  const wrong = (what: string): never => {
    throw new UserError(`${what}\n${usage}`)
  }
  if (argv[0] === undefined) wrong(`missing the CI: vx setup ${ci}`)
  if (argv[0] !== ci) wrong(`unknown CI: ${argv[0]} (this workspace sets up ${ci})`)
  let debs = defaultDebs
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] !== '--debs') wrong(`unknown argument: ${argv[i]}`)
    if (argv[i + 1] === undefined) wrong('--debs needs a directory')
    debs = path.resolve(argv[++i]!)
  }
  await mkdir(debs, { recursive: true })
  const output = ci === 'github' ? process.env['GITHUB_OUTPUT'] : undefined
  if (output !== undefined && output !== '')
    await writeFile(output, `key=${debsKey(process.env)}\n`, { flag: 'a' })
  return setup({ ci, debs, output })
}
