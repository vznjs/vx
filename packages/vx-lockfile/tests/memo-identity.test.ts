// The digest memo was trusted on DIGEST_VERSION and the lockfile's hash:
// the claimant's identity is the source of the closures the plugin hands
// core, which wrap every parser alike. A parser fix that forgot the bump
// kept replaying digests the old parser folded. A copy of the plugin
// whose parser source differs by one comment must not trust the memo.
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { TaskNode } from '@vzn/vx'

const SRC = path.resolve(import.meta.dir, '..', 'src')
const LOCK = `lockfileVersion: '9.0'

importers:

  .: {}
`

let root: string
let copy: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-memo-id-'))
  await writeFile(path.join(root, 'pnpm-lock.yaml'), LOCK)
  // In the temp dir, not beside src: a sandboxed test task may write only
  // there. A link to the workspace's node_modules resolves `@vzn/vx`.
  copy = await mkdtemp(path.join(tmpdir(), 'vx-memo-id-src-'))
  await cp(SRC, path.join(copy, 'src'), { recursive: true })
  await cp(path.join(SRC, '..', 'package.json'), path.join(copy, 'package.json'))
  await symlink(
    path.resolve(import.meta.dir, '../../../node_modules'),
    path.join(copy, 'node_modules'),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(copy, { recursive: true, force: true })
})

const key = async (src: string): Promise<string> => {
  const { pnpm } = (await import(path.join(src, 'index.ts'))) as typeof import('../src/index.js')
  const ctx = { workspaceRoot: root, cacheDir: path.join(root, '.vx'), warn() {} }
  return (await pnpm().key!({ projectDir: root } as TaskNode, ctx))!['pnpm']!
}

it("a parser whose source changed does not trust the old parser's memo", async () => {
  await key(SRC)
  const memo = path.join(root, '.vx', 'lockfile-claims', 'pnpm-lock.yaml.json')
  const kept = JSON.parse(await readFile(memo, 'utf8')) as { importers: Record<string, string> }
  kept.importers['.'] = 'from-the-memo'
  await writeFile(memo, JSON.stringify(kept))
  // CONTROL: the same source trusts it.
  expect(await key(SRC)).toBe('from-the-memo')
  const parser = path.join(copy, 'src', 'pnpm.ts')
  await writeFile(parser, `${await readFile(parser, 'utf8')}\n// changed\n`)
  expect(await key(path.join(copy, 'src'))).not.toBe('from-the-memo')
})

// Bun's module mocks outlive the file that sets them, so the fold is
// swapped in a process of its own, over an unchanged copy of the source.
const PROBE = `import { expect, it, mock } from 'bun:test'
const real = { ...(await import('@vzn/vx')) }
if (process.env.FOLD) {
  const { reachDigests } = real
  const folded = (g) => reachDigests(g).map((d) => d + "'")
  folded.toString = () => String(reachDigests)
  mock.module('@vzn/vx', () => ({ ...real, reachDigests: folded }))
}
it('keys', async () => {
  const { pnpm } = await import('./src/index.ts')
  const root = process.env.ROOT
  const ctx = { workspaceRoot: root, cacheDir: root + '/.vx', warn() {} }
  console.log('KEY=' + (await pnpm().key({ projectDir: root }, ctx)).pnpm)
})
`
const keyIn = async (fold: boolean): Promise<string> => {
  await writeFile(path.join(copy, 'probe.test.ts'), PROBE)
  const p = Bun.spawn(['bun', 'test', './probe.test.ts'], {
    cwd: copy,
    env: { ...process.env, ROOT: root, FOLD: fold ? '1' : '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()]
  expect(await p.exited, err).toBe(0)
  return /KEY=(.*)/.exec(out)![1]!
}

it("a reachDigests that folds otherwise does not trust the old one's memo", async () => {
  // Its source is not the fold: a cycle's labels live in a helper it
  // calls, so a core upgrade that changed them kept the function's text.
  await key(SRC)
  const memo = path.join(root, '.vx', 'lockfile-claims', 'pnpm-lock.yaml.json')
  const kept = JSON.parse(await readFile(memo, 'utf8')) as { importers: Record<string, string> }
  kept.importers['.'] = 'from-the-memo'
  await writeFile(memo, JSON.stringify(kept))
  // CONTROL: the copy, its fold unchanged, trusts it.
  expect(await keyIn(false)).toBe('from-the-memo')
  expect(await keyIn(true)).not.toBe('from-the-memo')
})
