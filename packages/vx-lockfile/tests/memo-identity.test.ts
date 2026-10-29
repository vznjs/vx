// The digest memo was trusted on DIGEST_VERSION and the lockfile's hash:
// the claimant's identity is the source of the closures the plugin hands
// core, which wrap every parser alike. A parser fix that forgot the bump
// kept replaying digests the old parser folded. A copy of the plugin
// whose parser source differs by one comment must not trust the memo.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  // Beside src, so `@vzn/vx` resolves from the package's node_modules.
  copy = await mkdtemp(path.join(import.meta.dir, '..', '.memo-id-'))
  await cp(SRC, path.join(copy, 'src'), { recursive: true })
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
