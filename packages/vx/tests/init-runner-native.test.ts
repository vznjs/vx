// `vx init` in a Turbo or Nx repo writes native configs through the
// workspace's own `@vzn/vx-migrate` writer and never declares turbo() or
// nx() (owner, 2026-10-02). The writer here is a stand-in that records
// what core handed it: its rendering is vx-migrate's own suite.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

/** A workspace with one package and `files` at its root; `writer` installs the stand-in. */
async function fixture(
  files: Record<string, string>,
  writer: string | null = 'export async function migrateCmd(argv) {\n' +
    "  await Bun.write(new URL('./argv.json', import.meta.url), JSON.stringify(argv))\n" +
    "  process.stdout.write('writer ran\\n')\n" +
    '  return Number(process.env.WRITER_EXIT ?? 0)\n}\n',
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-native-'))
  await writeFile(path.join(root, 'package.json'), '{ "name": "r", "workspaces": ["packages/*"] }')
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), '{ "name": "a" }')
  for (const [f, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, f)), { recursive: true })
    await writeFile(path.join(root, f), text)
  }
  if (writer !== null) {
    const dir = path.join(root, 'node_modules', '@vzn', 'vx-migrate')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'package.json'),
      '{ "name": "@vzn/vx-migrate", "type": "module", "exports": "./index.js" }',
    )
    await writeFile(path.join(dir, 'index.js'), writer)
  }
  return root
}

const argv = (root: string): unknown =>
  JSON.parse(
    readFileSync(path.join(root, 'node_modules', '@vzn', 'vx-migrate', 'argv.json'), 'utf8'),
  )

it('hands the runner and the flags to the writer, then says the runner file can go', async () => {
  const rows: Record<string, unknown> = {}
  for (const [label, files, args] of [
    ['turbo.json', { 'turbo.json': '{}' }, []],
    // Turbo 2.5+ reads `turbo.jsonc` as well (item 938).
    ['turbo.jsonc', { 'turbo.jsonc': '{}' }, ['--force', '--mjs']],
    ['nx.json', { 'nx.json': '{}' }, []],
    // Both checked in: Turbo's, as before.
    ['both', { 'nx.json': '{}', 'turbo.json': '{}' }, []],
    ['dry', { 'turbo.json': '{}' }, ['--dry']],
    // An executor target runs through Nx's API, which reads nx.json.
    [
      'nx-exec',
      {
        'nx.json': '{}',
        'packages/a/vx.config.mjs':
          "export default { tasks: { b: { exec: { command: 'nx-exec a:b' } } } }\n",
      },
      [],
    ],
  ] as [string, Record<string, string>, string[]][]) {
    const root = await fixture(files)
    try {
      const r = await vx(root, ['init', ...args])
      rows[label] = [
        r.code,
        r.err,
        r.out,
        argv(root),
        existsSync(path.join(root, 'vx.workspace.ts')),
      ]
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  const gone = (f: string) => `writer ran\nvx no longer reads ${f}: delete it once a run passes.\n`
  expect(rows).toEqual({
    'turbo.json': [0, '', gone('turbo.json'), ['--from', 'turbo'], false],
    'turbo.jsonc': [0, '', gone('turbo.jsonc'), ['--from', 'turbo', '--force', '--mjs'], false],
    'nx.json': [0, '', gone('nx.json'), ['--from', 'nx'], false],
    both: [0, '', gone('turbo.json'), ['--from', 'turbo'], false],
    dry: [
      0,
      '',
      'writer ran\nturbo.json stays the source until the files are written.\n',
      ['--from', 'turbo', '--dry'],
      false,
    ],
    'nx-exec': [
      0,
      '',
      'writer ran\nnx.json stays while a task runs `nx-exec` or `nx-env` (Nx executors read it); delete it once none does.\n',
      ['--from', 'nx'],
      false,
    ],
  })
}, 60_000)

it("a writer's failure is init's exit, with nothing added", async () => {
  const root = await fixture({ 'turbo.json': '{}' })
  try {
    const proc = Bun.spawn([process.execPath, BIN, 'init'], {
      cwd: root,
      env: { ...process.env, WRITER_EXIT: '3' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect([await proc.exited, await new Response(proc.stdout).text()]).toEqual([3, 'writer ran\n'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('no writer installed: the install line for the lockfile, exit 1, nothing written', async () => {
  const rows: string[] = []
  for (const [lock, body] of [
    [null, ''],
    ['pnpm-lock.yaml', ''],
    ['yarn.lock', '# yarn lockfile v1\n'],
    // Berry has no `-W` and refuses it.
    ['yarn.lock', '__metadata:\n  version: 8\n'],
    ['bun.lock', ''],
  ] as [string | null, string][]) {
    const root = await fixture({ 'turbo.json': '{}', ...(lock ? { [lock]: body } : {}) }, null)
    try {
      const r = await vx(root, ['init'])
      expect([r.code, r.out]).toEqual([1, ''])
      expect(existsSync(path.join(root, 'vx.workspace.ts'))).toBe(false)
      rows.push(r.err)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  const line = (install: string) =>
    `vx init: turbo.json found — its tasks become native vx.config.ts files through @vzn/vx-migrate, not installed here: ${install} @vzn/vx-migrate, then vx init again\n`
  expect(rows).toEqual([
    line('npm install -D'),
    line('pnpm add -D -w'),
    line('yarn add -D -W'),
    line('yarn add -D'),
    line('bun add -d'),
  ])
}, 60_000)

it('a writer without migrateCmd is named, not crashed on', async () => {
  const root = await fixture({ 'nx.json': '{}' }, 'export const nx = 1\n')
  try {
    const r = await vx(root, ['init'])
    expect([r.code, r.out, r.err]).toEqual([
      1,
      '',
      'vx init: the @vzn/vx-migrate installed here has no writer (migrateCmd); update it and run vx init again\n',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('a remote cache or Nx Cloud the repo shows is named after the write', async () => {
  const rows: Record<string, string[]> = {}
  for (const [label, files] of [
    ['turbo.json remoteCache', { 'turbo.json': '{ "remoteCache": { "teamId": "t" } }' }],
    [
      'workflow TURBO_TOKEN',
      { 'turbo.json': '{}', '.github/workflows/ci.yml': 'env:\n  TURBO_TOKEN: ${{ secrets.T }}\n' },
    ],
    [
      'nx gitlab',
      {
        'nx.json': '{}',
        '.gitlab-ci.yml': 'variables:\n  NX_SELF_HOSTED_REMOTE_CACHE_SERVER: https://c\n',
      },
    ],
    ['disabled', { 'turbo.json': '{ "remoteCache": { "enabled": false } }' }],
    ['turbo link', { 'turbo.json': '{}', '.turbo/config.json': '{ "teamid": "team_1" }' }],
    ['an empty link', { 'turbo.json': '{}', '.turbo/config.json': '{ "teamId": "" }' }],
    [
      'disabled, with a CI token',
      {
        'turbo.json': '{ "remoteCache": { "enabled": false } }',
        '.github/workflows/ci.yml': 'env:\n  TURBO_TOKEN: x\n',
      },
    ],
    ['nx with a Turbo token', { 'nx.json': '{}', '.gitlab-ci.yml': 'TURBO_TOKEN: x\n' }],
    [
      'a comment naming TURBO_TOKEN',
      { 'turbo.json': '{}', '.github/workflows/ci.yml': 'jobs:\n  # TURBO_TOKEN later\n' },
    ],
    ['nx cloud', { 'nx.json': '{ "nxCloudId": "abc" }' }],
    [
      'nx cloud, legacy runner',
      { 'nx.json': '{ "tasksRunnerOptions": { "default": { "runner": "@nrwl/nx-cloud" } } }' },
    ],
    ['nx, an empty cloud id', { 'nx.json': '{ "nxCloudId": "" }' }],
  ] as [string, Record<string, string>][]) {
    const root = await fixture(files)
    try {
      const r = await vx(root, ['init'])
      rows[label] = r.out.split('\n').filter((l) => /[Cc]ache|Cloud/.test(l))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  const add = (why: string, plugin: string) =>
    `${why}: add ${plugin}() from @vzn/vx-migrate to the workspace file's plugins and vx shares that remote cache.`
  const cloud =
    'nx.json connects Nx Cloud, whose cache vx cannot share: runs cache on this machine (nxCache() serves a self-hosted Nx cache).'
  expect(rows).toEqual({
    'turbo.json remoteCache': [add('turbo.json names a remoteCache', 'turboCache')],
    'workflow TURBO_TOKEN': [add('.github/workflows/ci.yml sets TURBO_TOKEN', 'turboCache')],
    'nx gitlab': [add('.gitlab-ci.yml sets NX_SELF_HOSTED_REMOTE_CACHE_SERVER', 'nxCache')],
    disabled: [],
    'turbo link': [add('.turbo/config.json links a team (turbo link)', 'turboCache')],
    'an empty link': [],
    'disabled, with a CI token': [],
    'nx with a Turbo token': [],
    'a comment naming TURBO_TOKEN': [],
    'nx cloud': [cloud],
    'nx cloud, legacy runner': [cloud],
    'nx, an empty cloud id': [],
  })
}, 60_000)
