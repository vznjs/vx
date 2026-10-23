// `vx setup github` / `vx setup gitlab` (owner, 2026-10-23): a CI step
// before vx runs, the plugin's verb, not core's. What it runs, by machine.
import { expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSetup, setup, type SetupOptions } from '../src/setup.js'

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
        return argv.includes('dpkg') ? (o.dpkg ?? 0) : 0
      },
    })
  return { ran, go, debs }
}

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
  const m = machine({ bins: ['apt-get'], root: true })
  writeFileSync(path.join(m.debs, 'bubblewrap.deb'), '')
  expect(await m.go()).toBe(0)
  expect(m.ran).toEqual([`dpkg -i ${path.join(m.debs, 'bubblewrap.deb')}`, PROBE])
})

it('fetches anew when the kept packages do not install', async () => {
  const m = machine({ bins: ['apt-get'], dpkg: 1 })
  writeFileSync(path.join(m.debs, 'bubblewrap.deb'), '')
  await m.go()
  expect(m.ran.slice(0, 2)).toEqual([
    `sudo dpkg -i ${path.join(m.debs, 'bubblewrap.deb')}`,
    `sudo rm -rf ${m.debs}`,
  ])
  expect(m.ran).toContain('sudo apt-get update')
})

it('an Alpine job installs by apk', async () => {
  const m = machine({ bins: ['apk'], root: true })
  await m.go()
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

it('takes only its own CI and --debs', async () => {
  for (const argv of [[], ['gitlab'], ['github', '--debs'], ['github', '--x']])
    expect(runSetup('github', argv, os.tmpdir())).rejects.toThrow(
      'Usage: vx setup github [--debs <dir>]',
    )
})
