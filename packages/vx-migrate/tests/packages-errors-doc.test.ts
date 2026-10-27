// The README's table of what reading the members refuses, held to the
// messages src/packages.ts throws, both ways: a row nothing provokes, or a
// message no row names, fails (core's schema.md held it until 2026-10-14).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { discoverPackages, loadPackageWorkspace } from '../src/packages.js'

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

const normalize = (s: string): string => s.replaceAll('`', '')

/** The message `fn` throws over a fresh root holding `files`, or null. */
async function failure(
  files: Record<string, string>,
  fn: (root: string) => Promise<unknown>,
): Promise<string | null> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-members-doc-'))
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
  try {
    await fn(root)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

const CASES: [string, () => Promise<string | null>][] = [
  [
    'failed to parse <file>: <why>',
    () => failure({ 'pnpm-workspace.yaml': 'packages: [\n' }, loadPackageWorkspace),
  ],
  [
    '<file>: packages must be an array of glob strings',
    () => failure({ 'pnpm-workspace.yaml': 'packages: "packages/*"\n' }, loadPackageWorkspace),
  ],
  [
    '<file>: must be a JSON object',
    () => failure({ 'package.json': 'null' }, loadPackageWorkspace),
  ],
  [
    '<file>: "name" must be a string with no surrounding whitespace',
    () => failure({ 'package.json': '{"name":123}' }, loadPackageWorkspace),
  ],
  [
    '<file>: "name" cannot hold "#" — vx addresses a task as <name>#<task>',
    () => failure({ 'package.json': '{"name":"a#b"}' }, loadPackageWorkspace),
  ],
  [
    "<file>: must be a mapping (packages: and pnpm's settings)",
    () => failure({ 'pnpm-workspace.yaml': '- packages/*\n' }, loadPackageWorkspace),
  ],
  [
    '<file>: workspaces must be an array of glob strings',
    () => failure({ 'package.json': '{"name":"r","workspaces":[1]}' }, loadPackageWorkspace),
  ],
  [
    '<file>: workspaces.packages must be an array of glob strings',
    () =>
      failure(
        { 'package.json': '{"name":"r","workspaces":{"packages":"x"}}' },
        loadPackageWorkspace,
      ),
  ],
  [
    `<file>: <field> entry "<glob>" is an extglob, which vx's glob engine does not read`,
    () =>
      failure(
        { 'package.json': '{"name":"r","workspaces":["packages/!(x)"]}' },
        loadPackageWorkspace,
      ),
  ],
  [
    'workspace member <dir> (<abs>) is outside the workspace root <root>: vx keeps every project under the root',
    () =>
      failure(
        {
          'w/package.json': '{"name":"r","workspaces":["../ext/*"]}',
          'ext/e/package.json': '{"name":"e"}',
        },
        async (root) => discoverPackages(await loadPackageWorkspace(path.join(root, 'w'))),
      ),
  ],
]

async function documentedRows(): Promise<string[]> {
  const doc = await Bun.file(new URL('../README.md', import.meta.url)).text()
  const at = doc.indexOf('### Errors reading the members')
  expect(at).toBeGreaterThan(-1)
  const rows: string[] = []
  for (const line of doc.slice(at).split('\n')) {
    if (line.startsWith('| `')) {
      rows.push(normalize(line.slice(1, line.indexOf('|', 1)).trim()))
      continue
    }
    if (rows.length > 0) break
  }
  return rows
}

describe("the README's member-reading errors", () => {
  it('documents exactly the messages pinned here', async () => {
    expect((await documentedRows()).sort()).toEqual(CASES.map(([row]) => row).sort())
  })

  it.each(CASES)('%s', async (row, provoke) => {
    const message = await provoke()
    expect(message).not.toBeNull()
    for (const segment of row.split(/<[^>]+>/)) {
      const literal = segment.trim()
      if (literal.length > 0) expect(normalize(message ?? '')).toContain(literal)
    }
  })
})
