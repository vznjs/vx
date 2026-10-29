// `vx setup github` / `vx setup gitlab` (2026-10-23): a CI step
// before vx runs, the plugin's verb, not core's. What it runs, by machine.
import { expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { debsKey, runSetup, setup, type SetupOptions } from '../src/setup.js'

function machine(
  o: Partial<SetupOptions> & { bins?: string[]; probe?: number; dpkg?: number } = {},
) {
  const ran: string[] = []
  const bins = new Set(o.bins ?? ['bwrap', 'socat', 'strace', 'rg'])
  const debs = o.debs ?? mkdtempSync(path.join(os.tmpdir(), 'vx-setup-'))
  const go = () =>
    setup({
      ci: 'github',
      debs,
      platform: 'linux',
      root: false,
      restricted: () => false,
      print: () => {},
      ...o,
      has: (b) => bins.has(b),
      sh: async (argv) => {
        ran.push(argv.join(' '))
        if (argv.includes('/bin/true')) return o.probe ?? 0
        if (!argv.includes('dpkg')) return 0
        // An installed deb brings its binary.
        if ((o.dpkg ?? 0) === 0)
          for (const a of argv) {
            const pkg = /([a-z]+)\.deb$/.exec(a)?.[1]
            if (pkg !== undefined) bins.add(BIN_OF[pkg] ?? pkg)
          }
        return o.dpkg ?? 0
      },
    })
  return { ran, go, debs }
}

const BIN_OF: Record<string, string> = { bubblewrap: 'bwrap', ripgrep: 'rg' }
const KEPT = ['bubblewrap', 'socat', 'strace', 'ripgrep']

const PROBE = 'bwrap --ro-bind / / --proc /proc --dev /dev /bin/true'

it('a runner with the runtime installed only proves it', async () => {
  const m = machine()
  expect(await m.go()).toBe(0)
  expect(m.ran).toEqual([PROBE])
})

it('macOS has its sandbox built in: nothing runs', async () => {
  const m = machine({ platform: 'darwin', bins: [] })
  expect(await m.go()).toBe(0)
  expect(m.ran).toEqual([])
})

it('installs from apt by sudo, keeps the packages and says it fetched them', async () => {
  const output = path.join(mkdtempSync(path.join(os.tmpdir(), 'vx-setup-out-')), 'out')
  const m = machine({ bins: ['apt-get'], output })
  expect(await m.go()).toBe(0)
  expect(m.ran.filter((c) => c.includes('apt-get'))).toEqual([
    'sudo apt-get update',
    `sudo apt-get install -y -o Dir::Cache::Archives=${m.debs} -o APT::Keep-Downloaded-Packages=true bubblewrap socat strace ripgrep`,
  ])
  expect(m.ran.at(-1)).toBe(PROBE)
  expect(readFileSync(output, 'utf8')).toBe('fetched=true\n')
})

it('installs the kept packages with no index fetch, as root without sudo', async () => {
  const m = machine({ bins: ['apt-get', 'dpkg'], root: true })
  for (const p of KEPT) writeFileSync(path.join(m.debs, `${p}.deb`), '')
  expect(await m.go()).toBe(0)
  const [dpkg, ...rest] = m.ran
  expect(dpkg!.split(' ').toSorted()).toEqual(
    ['dpkg', '-i', ...KEPT.map((p) => path.join(m.debs, `${p}.deb`))].toSorted(),
  )
  expect(rest).toEqual([PROBE])
})

// A kept set holds only what its fetch installed: socat already on that
// image left no socat.deb, and on an image without it setup said the
// sandbox runs while socat stayed missing.
it('fetches anew when the kept packages leave a binary missing', async () => {
  const m = machine({ bins: ['apt-get', 'dpkg'], root: true })
  writeFileSync(path.join(m.debs, 'bubblewrap.deb'), '')
  expect(await m.go()).toBe(0)
  expect(m.ran.slice(0, 2)).toEqual([
    `dpkg -i ${path.join(m.debs, 'bubblewrap.deb')}`,
    `rm -rf ${m.debs}`,
  ])
  expect(m.ran).toContain('apt-get update')
})

it('fetches anew when the kept packages do not install', async () => {
  const m = machine({ bins: ['apt-get', 'dpkg'], dpkg: 1 })
  writeFileSync(path.join(m.debs, 'bubblewrap.deb'), '')
  await m.go()
  expect(m.ran.slice(0, 2)).toEqual([
    `sudo dpkg -i ${path.join(m.debs, 'bubblewrap.deb')}`,
    `sudo rm -rf ${m.debs}`,
  ])
  expect(m.ran).toContain('sudo apt-get update')
})

// GitLab's debs sit in the checkout (its cache keeps only paths there),
// and a root task's `**` keyed them as inputs.
it('git ignores the kept packages, so no task keys them', async () => {
  const m = machine({ bins: ['apt-get'] })
  await m.go()
  expect(readFileSync(path.join(m.debs, '.gitignore'), 'utf8')).toBe('*\n')
})

it('an Alpine job installs by apk', async () => {
  const m = machine({ bins: ['apk'], root: true })
  await m.go()
  expect(m.ran[0]).toBe('apk add --no-cache bubblewrap socat strace ripgrep')
})

// A cache a Debian job saved restores its debs on an Alpine job, which
// has no dpkg: spawning it threw, and setup crashed before apk ran.
it('an Alpine job skips kept debs it has no dpkg to install', async () => {
  const m = machine({ bins: ['apk'], root: true })
  writeFileSync(path.join(m.debs, 'bubblewrap.deb'), '')
  expect(await m.go()).toBe(0)
  expect(m.ran[0]).toBe('apk add --no-cache bubblewrap socat strace ripgrep')
})

it('names what is missing when nothing can install it', async () => {
  const m = machine({ bins: ['bwrap'] })
  expect(m.go()).rejects.toThrow('socat, strace, rg missing and no apt-get or apk')
})

it('lets bwrap make user namespaces where AppArmor restricts them', async () => {
  const m = machine({ restricted: () => true })
  await m.go()
  expect(m.ran.slice(-3)).toEqual([
    expect.stringMatching(/^sudo cp .*vx-bwrap-\d+\.apparmor \/etc\/apparmor\.d\/bwrap$/),
    'sudo apparmor_parser -r /etc/apparmor.d/bwrap',
    PROBE,
  ])
})

it('fails, named, where bwrap cannot start a sandbox', async () => {
  const m = machine({ probe: 1 })
  expect(m.go()).rejects.toThrow('bwrap cannot start a sandbox here (exit 1)')
})

it('takes only its own CI and --debs, and says what is wrong', async () => {
  const cases: [string[], string][] = [
    [[], 'missing the CI: vx setup github'],
    [['gitlab'], 'unknown CI: gitlab (this workspace sets up github)'],
    [['github', '--debs'], '--debs needs a directory'],
    [['github', '--x'], 'unknown argument: --x'],
  ]
  for (const [argv, said] of cases) {
    const err = await runSetup('github', argv, os.tmpdir()).catch((e: unknown) => e)
    // A usage refusal, as core's are, for a reader of the JSON.
    expect([(err as Error).message, (err as { code?: string }).code]).toEqual([
      `${said}\nUsage: vx setup github [--debs <dir>]`,
      'VX_E_USAGE',
    ])
  }
})

it('prints its usage for --help and exits 0', async () => {
  const printed: string[] = []
  const write = process.stdout.write
  process.stdout.write = ((chunk: string) => printed.push(chunk) > 0) as typeof write
  try {
    for (const argv of [['--help'], ['-h'], ['github', '--help']])
      expect(await runSetup('github', argv, os.tmpdir())).toBe(0)
  } finally {
    process.stdout.write = write
  }
  expect(printed.map(Bun.stripANSI)).toEqual(
    Array(3).fill('Usage: vx setup github [--debs <dir>]\n'),
  )
})

// vx-worker.yml restores by `vx-setup-debs-<runner.os>-<runner.arch>-`
// (ci-workflow.unsafe.test.ts): a key led by the image matched none.
it('saves packages under the runner OS and arch, then the image', () => {
  expect(
    debsKey({ RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu26', ImageVersion: '1.2' }),
  ).toBe('vx-setup-debs-Linux-X64-ubuntu26-1.2')
})
