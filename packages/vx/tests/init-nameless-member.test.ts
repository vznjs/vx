// A member whose package.json has no "name" is no project: `vx init`
// names it rather than leave its scripts unmapped without a word (remix's
// packages/component/bench).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function notes(members: Record<string, object | string>): Promise<string[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-nameless-'))
  try {
    await writeFile(
      path.join(root, 'package.json'),
      '{ "name": "r", "workspaces": ["packages/*"] }',
    )
    for (const [dir, pkg] of Object.entries(members)) {
      await mkdir(path.join(root, 'packages', dir), { recursive: true })
      await writeFile(
        path.join(root, 'packages', dir, 'package.json'),
        typeof pkg === 'string' ? pkg : JSON.stringify(pkg),
      )
    }
    const proc = Bun.spawn([process.execPath, BIN, 'init', '--dry'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    return out.split('\n').filter((l) => l.startsWith('note: not mapped:'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('names the nameless members whose scripts map to nothing', async () => {
  expect(
    await notes({
      a: { scripts: { build: 'tsc' } },
      b: { name: 'b', scripts: { build: 'tsc' } },
      // CONTROLS: nameless with no script, and with only an empty one.
      c: {},
      d: { scripts: { build: '' } },
      // A byte-order mark (a Windows editor's) is no parse error: init
      // threw a SyntaxError and a stack on it.
      e: '\uFEFF{ "scripts": { "build": "tsc" } }',
    }),
  ).toEqual([
    'note: not mapped: packages/a, packages/e — their package.json files have no "name", and vx names a project by it; give each one and run `vx init` again',
  ])
  // Every member nameless: the report that maps nothing says it too.
  expect(
    await notes({
      a: { scripts: { build: 'tsc' } },
      b: { scripts: { test: 'vitest' } },
      c: { scripts: { x: 'y' } },
      d: { scripts: { x: 'y' } },
    }),
  ).toEqual([
    'note: not mapped: packages/a, packages/b, packages/c, and 1 more — their package.json files have no "name", and vx names a project by it; give each one and run `vx init` again',
  ])
}, 30_000)
