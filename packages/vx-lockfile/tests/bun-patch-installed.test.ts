// A pull that edits only a patch file moves no byte of bun.lock (it names
// the patch by path): the key folds the new patch, the tree still holds the
// old one, and the output saved under the new key replayed once `bun
// install` applied the new patch (probed, bun 1.4.4). Bun tags each copy it
// patched `.bun-tag-<hash>`; a tag of another patch refuses the run.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { KeyHookContext, TaskNode } from '@vzn/vx'
import { bun } from '../src/index.js'
import { bunPatchTag } from '../src/installed.js'

let root: string
let cacheDir: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-bun-patch-'))
  cacheDir = path.join(root, '.vx', 'cache')
  await mkdir(cacheDir, { recursive: true })
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function write(files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
}

const tag = (patch: string): string =>
  `.bun-tag-${bunPatchTag(new TextEncoder().encode(patch)).toString(16)}`

/** `a`'s key as a run after `vx lock` folds it: the refusal, or `ok`, and what it said. */
async function run(): Promise<{ said: string[]; result: string }> {
  const plugin = bun()
  const said: string[] = []
  const base = { workspaceRoot: root, cacheDir, warn: (m: string) => void said.push(m) }
  const projectDir = path.join(root, 'packages', 'a')
  const ctx: KeyHookContext = {
    ...base,
    async locked(file) {
      const d = await plugin.fingerprint!.digests!(file, {
        ...base,
        projects: [{ name: 'p', dir: projectDir }],
      })
      return d === undefined ? undefined : { extras: {}, digest: () => d.projects['p'] }
    },
  } as KeyHookContext
  try {
    await plugin.key!({ projectDir } as TaskNode, ctx)
    return { said, result: 'ok' }
  } catch (err) {
    return { said, result: err instanceof Error ? err.message : String(err) }
  }
}

const PATCH1 = '--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-x\n+// PATCH1\n'
const PATCH2 = PATCH1.replace('PATCH1', 'PATCH2')
const STORE = 'node_modules/.bun/is-number@7.0.0/node_modules/is-number'
const PKG = '{ "name": "is-number", "version": "7.0.0" }'
const WORKSPACE = {
  'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }',
  'packages/a/package.json':
    '{ "name": "a", "version": "1.0.0", "dependencies": { "is-number": "7.0.0" } }',
  'bun.lock': `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "root" },
    "packages/a": { "name": "a", "dependencies": { "is-number": "7.0.0" } },
  },
  "patchedDependencies": { "is-number@7.0.0": "patches/is-number@7.0.0.patch" },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "is-number": ["is-number@7.0.0", "", {}, "sha512-7"],
  }
}
`,
}
const REFUSED =
  'node_modules was installed from a different bun.lock (is-number@7.0.0 carries another patch than patches/is-number@7.0.0.patch) — run `bun install`'

it('refuses while the isolated store copy carries another patch than the patch file', async () => {
  await write({
    ...WORKSPACE,
    'patches/is-number@7.0.0.patch': PATCH2,
    [`${STORE}/package.json`]: PKG,
    [`${STORE}/${tag(PATCH1)}`]: '',
  })
  expect(await run()).toEqual({ said: [], result: REFUSED })
  // CONTROL: the install applied the patch the file holds.
  await rm(path.join(root, STORE, tag(PATCH1)))
  await write({ [`${STORE}/${tag(PATCH2)}`]: '' })
  expect(await run()).toEqual({ said: [], result: 'ok' })
})

it('refuses while the hoisted copy carries another patch, and compares again once the patch file moves', async () => {
  await write({
    ...WORKSPACE,
    'patches/is-number@7.0.0.patch': PATCH1,
    'node_modules/is-number/package.json': PKG,
    [`node_modules/is-number/${tag(PATCH1)}`]: '',
  })
  expect(await run()).toEqual({ said: [], result: 'ok' })
  // The match kept: a pull that edits only the patch file still compares.
  await Bun.sleep(1100)
  expect(await run()).toEqual({ said: [], result: 'ok' })
  expect(readdirSync(cacheDir).filter((f) => f.startsWith('vx-lockfile-installed-'))).toHaveLength(
    1,
  )
  await write({ 'patches/is-number@7.0.0.patch': PATCH2 })
  expect(await run()).toEqual({ said: [], result: REFUSED })
})

// A `file:` tarball bun.lock patches: its store copy was not compared, so a
// build between a patch edit and the install replayed the old patch's
// output (conformance inputs/patch-edit-built-before-install-not-replayed).
it('refuses a patched tarball copy in the store that carries another patch', async () => {
  const id = 'x@../../vendor/x.tgz'
  const file = 'patches/x@..%2F..%2Fvendor%2Fx.tgz.patch'
  const store = 'node_modules/.bun/x@..+..+vendor+x.tgz+a8e74b87a52ca5a7/node_modules/x'
  await write({
    'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }',
    'packages/a/package.json': `{ "name": "a", "dependencies": { "x": "file:../../vendor/x.tgz" } }`,
    'bun.lock': `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "root" },
    "packages/a": { "name": "a", "dependencies": { "x": "file:../../vendor/x.tgz" } },
  },
  "patchedDependencies": { "${id}": "${file}" },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "x": ["${id}", {}, "sha512-x"],
  }
}
`,
    [file]: PATCH2,
    [`${store}/package.json`]: '{ "name": "x", "version": "1.0.0" }',
    [`${store}/${tag(PATCH1)}`]: '',
  })
  expect(await run()).toEqual({
    said: [],
    result: `node_modules was installed from a different bun.lock (${id} carries another patch than ${file}) — run \`bun install\``,
  })
  // CONTROL: the install applied the patch the file holds.
  await rm(path.join(root, store, tag(PATCH1)))
  await write({ [`${store}/${tag(PATCH2)}`]: '' })
  expect(await run()).toEqual({ said: [], result: 'ok' })
})

// A pull that adds a first patch: the copy installed before it has no tag
// (Bun tags only what it patched), and its output was saved under the
// patched key, replayed once the install patched it (probed, bun 1.4.4).
it('refuses a copy with no tag where bun.lock names a patch', async () => {
  await write({
    ...WORKSPACE,
    'patches/is-number@7.0.0.patch': PATCH1,
    [`${STORE}/package.json`]: PKG,
  })
  expect(await run()).toEqual({
    said: [],
    result:
      'node_modules was installed from a different bun.lock (is-number@7.0.0 carries no patch, bun.lock names patches/is-number@7.0.0.patch) — run `bun install`',
  })
})

// A pull that removes the patch: `bun install` checks the patched copy
// unchanged and keeps it (bun 1.4.4); only a reinstall replaces it.
it('refuses a tagged copy where bun.lock names no patch, naming the reinstall', async () => {
  await write({
    ...WORKSPACE,
    'bun.lock': WORKSPACE['bun.lock'].replace(/ {2}"patchedDependencies": [^\n]*\n/, ''),
    'node_modules/is-number/package.json': PKG,
    [`node_modules/is-number/${tag(PATCH1)}`]: '',
  })
  expect(await run()).toEqual({
    said: [],
    result:
      'node_modules was installed from a different bun.lock (is-number@7.0.0 at node_modules/is-number carries a patch bun.lock does not name) — run `bun install --force`',
  })
  // CONTROL: the reinstalled copy, untagged.
  await rm(path.join(root, 'node_modules/is-number', tag(PATCH1)))
  expect(await run()).toEqual({ said: [], result: 'ok' })
})

// A copy that cannot be listed cannot be compared: said, not refused, and
// kept unmatched so the next run says it again.
it('says a patched copy it cannot list', async () => {
  await write({
    ...WORKSPACE,
    'patches/is-number@7.0.0.patch': PATCH1,
    'node_modules/.bun/is-number@7.0.0/node_modules/is-number': 'not a directory',
  })
  const said = [
    `[vx] bun(): is-number@7.0.0 at ${STORE} cannot be listed, so its patch is not checked: ENOTDIR: not a directory, scandir '${path.join(root, STORE)}'`,
  ]
  expect(await run()).toEqual({ said, result: 'ok' })
  expect(await run()).toEqual({ said, result: 'ok' })
})

/** A registry serving `dep@1.0.0` (`index.js`: `module.exports = 1`), from `root`. */
async function depRegistry(): Promise<Bun.Server<undefined>> {
  await mkdir(path.join(root, 'src', 'package'), { recursive: true })
  await writeFile(
    path.join(root, 'src', 'package', 'package.json'),
    '{ "name": "dep", "version": "1.0.0" }',
  )
  await writeFile(path.join(root, 'src', 'package', 'index.js'), 'module.exports = 1\n')
  const tar = Bun.spawn(['tar', 'czf', '-', '-C', path.join(root, 'src'), 'package'], {
    stdout: 'pipe',
  })
  const tgz = new Uint8Array(await new Response(tar.stdout).arrayBuffer())
  expect(await tar.exited).toBe(0)
  const integrity = `sha512-${new Bun.CryptoHasher('sha512').update(tgz).digest('base64')}`
  const registry: Bun.Server<undefined> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req): Response {
      const p = new URL(req.url).pathname
      if (p === '/dep')
        return Response.json({
          name: 'dep',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'dep',
              version: '1.0.0',
              dist: { tarball: `${registry.url.origin}/dep/-/dep-1.0.0.tgz`, integrity },
            },
          },
        })
      if (p === '/dep/-/dep-1.0.0.tgz') return new Response(tgz)
      return new Response('not found', { status: 404 })
    },
  })
  return registry
}

const DEP_PATCH =
  '--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1\n+module.exports = 2\n'

/** A workspace in `ws` whose `packages/a` depends on dep@1.0.0, patched or not. */
async function depWorkspace(
  ws: string,
  registry: Bun.Server<undefined>,
  linker: string,
  patched: boolean,
): Promise<void> {
  await mkdir(path.join(ws, 'packages', 'a'), { recursive: true })
  await writeFile(
    path.join(ws, 'package.json'),
    JSON.stringify({
      name: 'root',
      private: true,
      workspaces: ['packages/*'],
      ...(patched ? { patchedDependencies: { 'dep@1.0.0': 'patches/dep@1.0.0.patch' } } : {}),
    }),
  )
  await writeFile(
    path.join(ws, 'packages', 'a', 'package.json'),
    '{ "name": "a", "dependencies": { "dep": "1.0.0" } }',
  )
  if (patched) {
    await mkdir(path.join(ws, 'patches'), { recursive: true })
    await writeFile(path.join(ws, 'patches', 'dep@1.0.0.patch'), DEP_PATCH)
  } else await rm(path.join(ws, 'patches'), { recursive: true, force: true })
  await writeFile(
    path.join(ws, 'bunfig.toml'),
    `[install]\nlinker = "${linker}"\nregistry = "${registry.url.origin}/"\ncache = "${path.join(ws, '.cache')}"\n`,
  )
}

/** `bun install` with `args` in `ws`, which must succeed. */
async function install(ws: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn([process.execPath, 'install', ...args], {
    cwd: ws,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(ws, '.cache') },
  })
  const err = await new Response(p.stderr).text()
  const code = await p.exited
  expect({ args, code, err: code === 0 ? '' : err }).toEqual({ args, code: 0, err: '' })
}

// What Bun itself writes: a real install, from a registry served here, so a
// Bun that hashes the patch otherwise fails this before a user's run.
it('computes the tag a real bun install writes, under either linker', async () => {
  const registry = await depRegistry()
  try {
    for (const linker of ['isolated', 'hoisted']) {
      const ws = path.join(root, linker)
      await depWorkspace(ws, registry, linker, true)
      await install(ws)
      const copy = path.join(
        ws,
        linker === 'hoisted' ? 'node_modules/dep' : 'node_modules/.bun/dep@1.0.0/node_modules/dep',
      )
      expect({
        linker,
        patched: await Bun.file(path.join(copy, 'index.js')).text(),
        tags: readdirSync(copy).filter((n) => n.startsWith('.bun-tag')),
      }).toEqual({ linker, patched: 'module.exports = 2\n', tags: [tag(DEP_PATCH)] })
    }
  } finally {
    await registry.stop(true)
  }
}, 60_000)

// The pulls a real install leaves stale: a patch added (the copy was
// installed unpatched, with no tag), then removed (`bun install` keeps the
// patched copy, bun 1.4.4). Each bun.lock is Bun's own (`--lockfile-only`).
it('refuses a real install behind a patch added or removed, until the install that fixes it', async () => {
  const registry = await depRegistry()
  const ws = path.join(root, 'ws')
  const runIn = async (): Promise<string> => {
    const saved = root
    root = ws
    try {
      return (await run()).result
    } finally {
      root = saved
    }
  }
  try {
    await depWorkspace(ws, registry, 'isolated', false)
    await install(ws)
    await mkdir(path.join(ws, '.vx', 'cache'), { recursive: true })
    expect(await runIn()).toBe('ok')
    await depWorkspace(ws, registry, 'isolated', true)
    await install(ws, '--lockfile-only')
    expect(await runIn()).toBe(
      'node_modules was installed from a different bun.lock (dep@1.0.0 carries no patch, bun.lock names patches/dep@1.0.0.patch) — run `bun install`',
    )
    await install(ws)
    expect(await runIn()).toBe('ok')
    await depWorkspace(ws, registry, 'isolated', false)
    await install(ws, '--lockfile-only')
    await install(ws)
    const copy = path.join(ws, 'node_modules/.bun/dep@1.0.0/node_modules/dep')
    // Bun's own gap, the subject: the copy stays patched.
    expect(await Bun.file(path.join(copy, 'index.js')).text()).toBe('module.exports = 2\n')
    expect(await runIn()).toBe(
      'node_modules was installed from a different bun.lock (dep@1.0.0 at node_modules/.bun/dep@1.0.0/node_modules/dep carries a patch bun.lock does not name) — run `bun install --force`',
    )
    await install(ws, '--force')
    expect(await Bun.file(path.join(copy, 'index.js')).text()).toBe('module.exports = 1\n')
    expect(await runIn()).toBe('ok')
  } finally {
    await registry.stop(true)
  }
}, 60_000)

// A `file:` tarball bun.lock patches, from a real offline install under
// either linker: a patch edit before the install built against the old
// copy under the new patch's key, replayed once the install applied it.
it('refuses a real patched file: tarball install behind a patch edit, under either linker', async () => {
  const TGZ_PATCH = (to: string) =>
    `diff --git a/v.txt b/v.txt\n--- a/v.txt\n+++ b/v.txt\n@@ -1 +1 @@\n-x\n+${to}\n`
  const file = 'patches/x@..%2F..%2Fvendor%2Fx.tgz.patch'
  for (const linker of ['isolated', 'hoisted']) {
    const ws = path.join(root, `tgz-${linker}`)
    await mkdir(path.join(ws, 'vendor', 't', 'package'), { recursive: true })
    await mkdir(path.join(ws, 'packages', 'a'), { recursive: true })
    await mkdir(path.join(ws, 'patches'), { recursive: true })
    await writeFile(
      path.join(ws, 'vendor/t/package/package.json'),
      '{ "name": "x", "version": "1.0.0" }',
    )
    await writeFile(path.join(ws, 'vendor/t/package/v.txt'), 'x\n')
    const tar = Bun.spawnSync(['tar', 'czf', 'vendor/x.tgz', '-C', 'vendor/t', 'package'], {
      cwd: ws,
    })
    expect(tar.exitCode).toBe(0)
    await writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
        patchedDependencies: { 'x@../../vendor/x.tgz': file },
      }),
    )
    await writeFile(
      path.join(ws, 'packages/a/package.json'),
      '{ "name": "a", "dependencies": { "x": "file:../../vendor/x.tgz" } }',
    )
    await writeFile(path.join(ws, file), TGZ_PATCH('one'))
    await writeFile(
      path.join(ws, 'bunfig.toml'),
      `[install]\nlinker = "${linker}"\ncache = "${path.join(ws, '.cache')}"\n`,
    )
    await install(ws)
    const saved = root
    root = ws
    try {
      expect({ linker, result: (await run()).result }).toEqual({ linker, result: 'ok' })
      await writeFile(path.join(ws, file), TGZ_PATCH('two'))
      expect({ linker, result: (await run()).result }).toEqual({
        linker,
        result: `node_modules was installed from a different bun.lock (x@../../vendor/x.tgz carries another patch than ${file}) — run \`bun install\``,
      })
      await install(ws)
      expect({ linker, result: (await run()).result }).toEqual({ linker, result: 'ok' })
    } finally {
      root = saved
    }
  }
}, 60_000)
