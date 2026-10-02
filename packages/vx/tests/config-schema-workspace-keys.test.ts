// Keys pasted into vx.workspace from pnpm-workspace.yaml, Lerna and the
// root package.json name vx's home for them (D-98).
import { expect, it } from 'bun:test'
import { validateWorkspace } from '../src/workspace/config-schema.js'

const where = (key: string): string | undefined => {
  try {
    validateWorkspace({ [key]: {} } as never, 'vx.workspace.ts')
  } catch (err) {
    return (err as Error).message.split(' — ')[1]
  }
  return undefined
}

it("names vx's home for a workspace key another tool spells (D-98)", () => {
  const members =
    "vx spells it `workspaces` in package.json or pnpm-workspace.yaml's `packages`, where vx reads the members"
  expect(where('packages')).toBe(members)
  expect(where('workspaces')).toBe(members)
  expect(where('projects')).toBe(members)
  expect(where('ignore')).toBe(
    'vx spells it a `!` pattern in the workspace globs (package.json `workspaces` or pnpm-workspace.yaml)',
  )
  expect(where('catalog')).toBe(
    "vx spells it pnpm-workspace.yaml's or package.json's `catalog`, where the package manager reads it",
  )
  expect(where('npmClient')).toBe(
    "vx spells it no field: a task's command runs as written, with no package manager in between",
  )
  expect(where('cache')).toBe(
    "vx spells it each task's `cache` in its project's vx.config (a task caches only when it declares one)",
  )
  expect(where('remote')).toBe('vx spells it a cache plugin in `plugins`')
  expect(where('env')).toBe(
    'vx spells it `cache.inputs.env` on the tasks it keys, or `exec.env` on the tasks it passes to',
  )
  // CONTROL: a typo still gets the nearest spelling.
  expect(where('cachedir')).toBe('did you mean cacheDir?')
})
