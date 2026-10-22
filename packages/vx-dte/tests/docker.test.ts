// `docker()`: a container's clone checks out the tracked files as the run
// sees them, as `local()`'s worktrees do. A `docker` on PATH runs the
// container's script here, with its mounts as directories.

import { afterAll, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentSpawn } from '../src/index.js'
import { docker } from '../src/index.js'

const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-docker-'))
afterAll(() => rm(dir, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]): void => {
  const r = Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...args], {
    cwd,
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}

it('an agent runs the tracked files as they are, uncommitted changes too', async () => {
  const root = path.join(dir, 'ws')
  const bin = path.join(dir, 'bin')
  Bun.spawnSync(['mkdir', '-p', root, bin])
  git(root, 'init', '-q')
  await writeFile(path.join(root, 'f'), 'committed\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'i')
  await writeFile(path.join(root, 'f'), 'uncommitted\n')

  const out = path.join(dir, 'out')
  await writeFile(
    path.join(bin, 'docker'),
    `#!/bin/sh
for a; do last=$a; done
src=$(printf '%s\\n' "$@" | sed -n 's#^\\(.*\\):/src:ro$#\\1#p')
printf '%s' "$last" | sed "s#/src#$src#g; s#\\(/tmp\\)\\{0,1\\}/work#${dir}/work#g; s#exec ./node_modules/.bin/vx dte agent#cat f > ${out}#" | sh
`,
  )
  await chmod(path.join(bin, 'docker'), 0o755)
  const saved = process.env['PATH']
  process.env['PATH'] = `${bin}:${saved}`
  try {
    const exited: string[] = []
    const adapter = docker({ image: 'x' })
    await adapter.spawn({
      id: 'small#1',
      size: 'small',
      cpu: 1,
      memory: 1 << 30,
      index: 1,
      run: 'r1',
      relay: 'http://127.0.0.1:1',
      workspaceRoot: root,
      env: {},
      exited: (why) => exited.push(why),
    } as AgentSpawn)
    let got = ''
    for (let i = 0; i < 100 && got === ''; i++) {
      await Bun.sleep(50)
      got = await readFile(out, 'utf8').catch(() => '')
    }
    expect([got, exited]).toEqual(['uncommitted\n', []])
  } finally {
    process.env['PATH'] = saved
  }
}, 20_000)

it('says why an agent’s container ended before it joined', async () => {
  const root = path.join(dir, 'ws2')
  const bin = path.join(dir, 'bin2')
  Bun.spawnSync(['mkdir', '-p', root, bin])
  git(root, 'init', '-q')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'i')
  await writeFile(
    path.join(bin, 'docker'),
    `#!/bin/sh\necho 'error: no bun in image' >&2\nexit 3\n`,
  )
  await chmod(path.join(bin, 'docker'), 0o755)
  const saved = process.env['PATH']
  process.env['PATH'] = `${bin}:${saved}`
  try {
    const exited = Promise.withResolvers<string>()
    await docker({ image: 'x' }).spawn({
      id: 'small#1',
      size: 'small',
      cpu: 1,
      memory: 1 << 30,
      index: 2,
      run: 'r1',
      relay: 'http://127.0.0.1:1',
      workspaceRoot: root,
      env: {},
      exited: exited.resolve,
    } as AgentSpawn)
    const why = await Promise.race([exited.promise, Bun.sleep(5_000).then(() => 'never said')])
    expect(why).toMatch(/^exited 3: error: no bun in image \(log: .+\)$/)
    const log = why.match(/\(log: ([^)]+)\)/)![1]!
    expect(await readFile(log, 'utf8')).toBe('error: no bun in image\n')
  } finally {
    process.env['PATH'] = saved
  }
}, 20_000)

it('an agent shares this machine’s store: the same home, the same repository identity', async () => {
  const root = path.join(dir, 'ws3')
  const bin = path.join(dir, 'bin3')
  const home = path.join(dir, 'home')
  Bun.spawnSync(['mkdir', '-p', root, bin, home])
  git(root, 'init', '-q')
  git(root, 'remote', 'add', 'origin', 'https://example.test/ws.git')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'i')
  const argv = path.join(dir, 'argv3')
  const out = path.join(dir, 'origin3')
  await writeFile(
    path.join(bin, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$@" > ${argv}
for a; do last=$a; done
src=$(printf '%s\\n' "$@" | sed -n 's#^\\(.*\\):/src:ro$#\\1#p')
printf '%s' "$last" | sed "s#/src#$src#g; s#\\(/tmp\\)\\{0,1\\}/work#${dir}/work3#g; s#exec ./node_modules/.bin/vx dte agent#git remote get-url origin > ${out}#" | sh
`,
  )
  await chmod(path.join(bin, 'docker'), 0o755)
  const saved = { PATH: process.env['PATH'], HOME: process.env['HOME'] }
  process.env['PATH'] = `${bin}:${saved.PATH}`
  process.env['HOME'] = home
  // As root, so the store is at its own path on every platform.
  const uid = process.getuid!
  process.getuid = () => 0
  try {
    await docker({ image: 'x' }).spawn({
      id: 'small#1',
      size: 'small',
      cpu: 1,
      memory: 1 << 30,
      index: 3,
      run: 'r1',
      relay: 'http://127.0.0.1:1',
      workspaceRoot: root,
      env: {},
      exited: () => {},
    } as AgentSpawn)
    let got = ''
    for (let i = 0; i < 100 && got === ''; i++) {
      await Bun.sleep(50)
      got = await readFile(out, 'utf8').catch(() => '')
    }
    const args = (await readFile(argv, 'utf8')).split('\n')
    expect({
      origin: got,
      store: args.includes(`${home}/.vx:${home}/.vx`),
      home: args.includes('HOME'),
    }).toEqual({ origin: 'https://example.test/ws.git\n', store: true, home: true })
  } finally {
    Object.assign(process.env, saved)
    process.getuid = uid
  }
}, 20_000)

it('on Linux, a container runs as this user, so what it writes in the store is this user’s', async () => {
  const root = path.join(dir, 'ws4')
  const bin = path.join(dir, 'bin4')
  const home = path.join(dir, 'home4')
  Bun.spawnSync(['mkdir', '-p', root, bin, home])
  git(root, 'init', '-q')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'i')
  const argv = path.join(dir, 'argv4')
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${argv}\n`)
  await chmod(path.join(bin, 'docker'), 0o755)
  const saved = { PATH: process.env['PATH'], HOME: process.env['HOME'] }
  const ids = { uid: process.getuid!, gid: process.getgid! }
  process.env['PATH'] = `${bin}:${saved.PATH}`
  process.env['HOME'] = home
  process.getuid = () => 1234
  process.getgid = () => 567
  try {
    await docker({ image: 'x' }).spawn({
      id: 'small#1',
      size: 'small',
      cpu: 1,
      memory: 1 << 30,
      index: 4,
      run: 'r1',
      relay: 'http://127.0.0.1:1',
      workspaceRoot: root,
      env: {},
      exited: () => {},
    } as AgentSpawn)
    for (let i = 0; i < 100 && !(await Bun.file(argv).exists()); i++) await Bun.sleep(20)
    const args = (await readFile(argv, 'utf8')).split('\n')
    const linux = process.platform === 'linux'
    expect({
      user: args.includes('1234:567'),
      store: args.includes(linux ? `${home}/.vx:/tmp/.vx` : `${home}/.vx:${home}/.vx`),
      clone: args.some((a) =>
        a.includes(linux ? 'git clone -q /src /tmp/work' : 'git clone -q /src /work'),
      ),
    }).toEqual({ user: linux, store: true, clone: true })
  } finally {
    Object.assign(process.env, saved)
    process.getuid = ids.uid
    process.getgid = ids.gid
  }
}, 20_000)
