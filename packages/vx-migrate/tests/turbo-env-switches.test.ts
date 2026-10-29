// Turbo's own run switches (`TURBO_*` in crates/turborepo-config/src/env.rs)
// under turbo() and turboCache(): each is read, refused or ignored on
// purpose, and the README says which.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { UserError } from '@vzn/vx'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'
import { ownSplice } from './helpers/turbo-own.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-switches-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('TURBO_ROOT_TURBO_JSON', () => {
  const mapped = (value: string) =>
    withEnv({ TURBO_ROOT_TURBO_JSON: value }, () =>
      mapTurboWorkspace(root, [], { splice: ownSplice, persistentTodo: 'P' }).then(
        () => 'mapped',
        (e: unknown) => (e instanceof UserError ? e.message : e),
      ),
    )

  // Turbo reads its root config from the file it names, against the cwd
  // (vercel/turborepo#9087). turbo() read the root turbo.json in silence:
  // another task graph than `turbo run` ran.
  it('naming another file is refused; naming the root config, or nothing, maps', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: {} }))
    const other = path.join(root, 'config', 'turbo.ci.json')
    await mkdir(path.dirname(other), { recursive: true })
    await writeFile(other, JSON.stringify({ tasks: {} }))
    expect([
      await mapped(other),
      await mapped(path.join(root, 'turbo.json')),
      await mapped(path.relative(process.cwd(), path.join(root, 'turbo.json'))),
      await mapped(''),
    ]).toEqual([
      `TURBO_ROOT_TURBO_JSON names ${other}: turbo() reads only the workspace root's turbo.json or turbo.jsonc — unset it, or move that config to the root`,
      'mapped',
      'mapped',
      'mapped',
    ])
  })

  it('with no root config, the variable is what the refusal names', async () => {
    const other = path.join(root, 'turborepo.json')
    await writeFile(other, JSON.stringify({ tasks: {} }))
    expect(await mapped(other)).toBe(
      `TURBO_ROOT_TURBO_JSON names ${other}: turbo() reads only the workspace root's turbo.json or turbo.jsonc — unset it, or move that config to the root`,
    )
  })
})
