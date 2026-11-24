// A distributed run end to end on `local()`: the files a task makes on a
// worker, as they come back here and to its dependants on other workers
// (local-e2e-fixture.ts).

import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { CORE_BIN, CORE_INDEX, DTE, root, setup, teardown, vx } from './local-e2e-fixture.ts'

// Every kind of file an output may be: modes, a link, empty directories and
// a file big enough to stream in parts. Random bytes, so no part repeats;
// the worker writes their checksum beside them.
const gen = (n: number) => `{
  exec: { command: ${JSON.stringify(
    [
      'sleep 1',
      `rm -rf out${n}`,
      `mkdir -p out${n}/empty/deeper out${n}/bin out${n}/priv`,
      `printf '#!/bin/sh\\necho hi\\n' > out${n}/bin/run.sh`,
      `chmod 755 out${n}/bin/run.sh`,
      `echo key > out${n}/priv/key`,
      `chmod 600 out${n}/priv/key`,
      `chmod 700 out${n}/priv`,
      `ln -s bin/run.sh out${n}/link`,
      `: > out${n}/zero`,
      `head -c 41943040 /dev/urandom > out${n}/big.bin`,
      `cksum < out${n}/big.bin > out${n}/big.sum`,
    ].join(' && '),
  )} },
  inputs: { files: ['vx.config.mjs'] },
  outputs: { files: ['out${n}/**'] },
  cache: true,
}`
const check = (n: number) =>
  `cksum < out${n}/big.bin | cmp - out${n}/big.sum && test -x out${n}/bin/run.sh && [ "$(readlink out${n}/link)" = bin/run.sh ] && test -d out${n}/empty/deeper && test -f out${n}/zero`

beforeEach(async () => {
  await setup()
  await mkdir(path.join(root, 'z'))
  await writeFile(
    path.join(root, 'z/vx.config.mjs'),
    `export default { name: 'z', tasks: {
  gen1: ${gen(1)},
  gen2: ${gen(2)},
  both: { dependsOn: ['gen1', 'gen2'], exec: { command: ${JSON.stringify(`${check(1)} && ${check(2)} && echo both-ok`)} } },
} }
`,
  )
  commit()
})
afterEach(teardown)

function commit(at = root): void {
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: at })
  expect(Bun.spawnSync([process.execPath, CORE_BIN, 'lock'], { cwd: at }).exitCode).toBe(0)
  git('add', '-A')
  git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qm', 'z')
}

/** Each path under `dir`: its kind, its mode, and its bytes' hash or its link's target. */
async function manifest(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (rel: string): Promise<void> => {
    for (const name of (await readdir(path.join(dir, rel))).sort()) {
      const r = path.join(rel, name)
      const at = path.join(dir, r)
      const st = await lstat(at)
      const mode = (st.mode & 0o777).toString(8)
      if (st.isSymbolicLink()) out[r] = `link ${await readlink(at)}`
      else if (st.isDirectory()) {
        out[r] = `dir ${mode}`
        await walk(r)
      } else
        out[r] =
          `file ${mode} ${st.size} ${new Bun.CryptoHasher('sha256').update(await readFile(at)).digest('hex')}`
    }
  }
  await walk('')
  return out
}

/** What a worker's files must be: each as made, the random bytes as their checksum says. */
async function expectMade(dir: string): Promise<void> {
  const m = await manifest(dir)
  const sum = await readFile(path.join(dir, 'big.sum'), 'utf8')
  const got = Bun.spawnSync(['cksum'], { stdin: await readFile(path.join(dir, 'big.bin')) })
  expect(got.stdout.toString()).toBe(sum)
  const made: Record<string, string> = {
    ...m,
    'big.bin': m['big.bin']!.split(' ').slice(0, 3).join(' '),
    'big.sum': '',
  }
  expect(made).toEqual({
    bin: 'dir 755',
    'bin/run.sh': `file 755 18 ${sha('#!/bin/sh\necho hi\n')}`,
    'big.bin': 'file 644 41943040',
    'big.sum': '',
    empty: 'dir 755',
    'empty/deeper': 'dir 755',
    link: 'link bin/run.sh',
    priv: 'dir 700',
    'priv/key': `file 600 4 ${sha('key\n')}`,
    zero: `file 644 0 ${sha('')}`,
  })
}

const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')

/** Which worker ran each task, from the run's own lines. */
const ranOn = (out: string): Record<string, string> =>
  Object.fromEntries([...out.matchAll(/(z#\w+) · (linux\.small#\d+)/g)].map((m) => [m[1]!, m[2]!]))

it('brings a worker’s files home as made, and hands them to a dependant on another worker', async () => {
  const r = vx(['run', 'z#both', '--output-logs=full'], 'artifacts')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out.includes('both-ok')]).toEqual([0, true])
  const on = ranOn(out)
  expect(on['z#gen1'] !== on['z#gen2']).toBe(true)
  await expectMade(path.join(root, 'z/out1'))
  await expectMade(path.join(root, 'z/out2'))
}, 90_000)

/**
 * A remote cache over `store`, as a content-addressed one keeps it: first
 * write wins, and a write lands whole or not at all.
 */
async function remote(store: string): Promise<void> {
  await mkdir(store, { recursive: true })
  const plugin = path.join(path.dirname(store), 'plugin')
  await mkdir(plugin, { recursive: true })
  await writeFile(path.join(plugin, 'package.json'), '{"name":"e2e-remote"}')
  const at = (h: string) => `${JSON.stringify(store)} + '/' + ${h}`
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { definePlugin } from ${JSON.stringify(CORE_INDEX)}
import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [
  dte({ workers: { linux: { machines: { small: { max: 2, cpu: 1, memory: '1GB' } } } }, adapter: local() }),
  definePlugin({ dir: ${JSON.stringify(plugin)} }, { cache: () => ({
    has: async (h) => (existsSync(${at('h')}) ? {} : null),
    get: async (h) => (existsSync(${at('h')}) ? { body: new Blob([readFileSync(${at('h')})]), durationMs: 1 } : null),
    put: async (h, b) => {
      if (existsSync(${at('h')})) return
      const tmp = ${at('h')} + '.' + process.pid + '.' + Math.random()
      writeFileSync(tmp, new Uint8Array(await b.arrayBuffer()))
      renameSync(tmp, ${at('h')})
    },
  }) }),
] }
`,
  )
  commit()
}

/** `vx run`, a distributed run in `at`, started now. */
function start(at: string, args: string[]) {
  const { VX_DTE_RUN: _, ...env } = process.env
  return Bun.spawn([process.execPath, CORE_BIN, 'run', ...args, '--output-logs=full'], {
    cwd: at,
    // CI: as a CI job, the run writes the remote cache.
    env: { ...env, VX_DTE_RUN: crypto.randomUUID(), NO_COLOR: '1', CI: 'true' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function done(p: ReturnType<typeof start>): Promise<{ code: number; out: string }> {
  const [o, e, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out: o + e }
}

// Two runs whose workers make the same key at once, each saving it to the
// cache they share; a third workspace's worker then finds it there, and its
// next run finds it in its own store: each lands as made, every time.
it('lands a key two workers made at once as made, from the remote cache and from its own store', async () => {
  const away = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-same-'))
  try {
    await remote(path.join(away, 'store'))
    const clones = ['one', 'two', 'three'].map((n) => path.join(away, n))
    for (const c of clones) Bun.spawnSync(['git', 'clone', '-q', root, c])
    const [one, two] = await Promise.all([
      done(start(clones[0]!, ['z#gen1'])),
      done(start(clones[1]!, ['z#gen1'])),
    ])
    expect([one.code, two.code]).toEqual([0, 0])
    for (const c of clones.slice(0, 2)) await expectMade(path.join(c, 'z/out1'))
    expect((await readdir(path.join(away, 'store'))).filter((f) => f.includes('.'))).toEqual([])
    // Each made its own random bytes; the store keeps one of them whole.
    const made = await Promise.all(
      clones.slice(0, 2).map((c) => readFile(path.join(c, 'z/out1/big.sum'), 'utf8')),
    )
    let sum: string | undefined
    for (const name of ['remote', 'local']) {
      await rm(path.join(clones[2]!, 'z/out1'), { recursive: true, force: true })
      const hit = await done(start(clones[2]!, ['z#both']))
      expect([name, hit.code, hit.out.includes('both-ok')]).toEqual([name, 0, true])
      await expectMade(path.join(clones[2]!, 'z/out1'))
      const got = await readFile(path.join(clones[2]!, 'z/out1/big.sum'), 'utf8')
      sum ??= got
      expect([name, made.includes(got), got]).toEqual([name, true, sum])
    }
  } finally {
    await rm(away, { recursive: true, force: true })
  }
}, 180_000)

// Under every download mode a remote-only task's files stay on the workers,
// and a dependant run here reads this machine's own state.
it('lands no remote-only task’s files here, whatever the download mode', async () => {
  for (const mode of ['all', 'toplevel', 'none']) {
    const r = vx(['run', 'b#far', 'a#ro', `--cache-download=${mode}`], `ro-${mode}`)
    expect([mode, r.exitCode]).toEqual([mode, 0])
    expect([mode, await Bun.file(path.join(root, 'a/out/ro.txt')).exists()]).toEqual([mode, false])
  }
}, 120_000)
