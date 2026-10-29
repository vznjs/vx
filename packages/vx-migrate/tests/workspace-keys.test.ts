// The adopted tool's workspace keys vx has a home for (G-49's silent gaps):
// turbo.json `concurrency`; nx.json `parallel`. Read by nothing,
// nx-examples' `parallel: 1` did not reach the run.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { WorkspaceConfig } from '@vzn/vx/config'
import { nx, turbo } from '../src/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-wskeys-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The workspace a plugin's `config` stage leaves, with the base commit it names (`setBranch`) as `base`. */
const staged = async (
  plugin: ReturnType<typeof turbo | typeof nx>,
  ws: WorkspaceConfig = {},
): Promise<WorkspaceConfig & { base?: string }> => {
  let base: string | undefined
  await plugin.config!(ws, {
    workspaceRoot: root,
    warn: () => {},
    setBranch: (facts) => void (base = facts.base ?? base),
  })
  return base === undefined ? ws : { ...ws, base }
}

describe('turbo(): turbo.json workspace keys', () => {
  it('concurrency, top level or under global', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ concurrency: '3', tasks: {} }))
    expect(await staged(turbo())).toEqual({ run: { concurrency: 3 } })
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ global: { concurrency: '50%' }, tasks: {} }),
    )
    expect(await staged(turbo())).toEqual({
      run: { concurrency: Math.max(1, Math.floor(availableParallelism() / 2)) },
    })
  })

  it('a key the workspace sets is its own', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ concurrency: '3', tasks: {} }))
    expect(await staged(turbo(), { run: { concurrency: 8 } })).toEqual({ run: { concurrency: 8 } })
  })

  // Turbo's environment sits above turbo.json; a CI that sets
  // TURBO_CONCURRENCY=1 for a small runner got turbo.json's 8 under vx.
  it('TURBO_CONCURRENCY wins over turbo.json', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ concurrency: '8', tasks: {} }))
    const saved = process.env['TURBO_CONCURRENCY']
    try {
      process.env['TURBO_CONCURRENCY'] = '1'
      const one = await staged(turbo())
      process.env['TURBO_CONCURRENCY'] = ''
      expect([one, await staged(turbo())]).toEqual([
        { run: { concurrency: 1 } },
        { run: { concurrency: 8 } },
      ])
    } finally {
      if (saved === undefined) delete process.env['TURBO_CONCURRENCY']
      else process.env['TURBO_CONCURRENCY'] = saved
    }
  })

  // Turbo #9053: an empty TURBO_SCM_BASE is unset, not a base of ''.
  it('TURBO_SCM_BASE names the base commit; an empty or blank one names none', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: {} }))
    const saved = { base: process.env['TURBO_SCM_BASE'], gha: process.env['GITHUB_ACTIONS'] }
    try {
      delete process.env['GITHUB_ACTIONS']
      const seen: unknown[] = []
      for (const v of ['origin/main', '', '  ']) {
        process.env['TURBO_SCM_BASE'] = v
        seen.push((await staged(turbo())).base)
      }
      expect(seen).toEqual(['origin/main', undefined, undefined])
    } finally {
      for (const [k, v] of [
        ['TURBO_SCM_BASE', saved.base],
        ['GITHUB_ACTIONS', saved.gha],
      ] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('a concurrency that is no positive whole number is left to the default', async () => {
    for (const concurrency of ['abc', '1.5', '-2']) {
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ concurrency, tasks: {} }))
      expect(await staged(turbo())).toEqual({})
    }
  })
})

// A relative root resolved against the cwd: `vx run` from a package dir
// read that package's tools/, or nothing. vx reads every other path from
// the workspace root.
describe("a relative root is the workspace root's", () => {
  it('turbo({ root }) and nx({ root })', async () => {
    await mkdir(path.join(root, 'tools'))
    await writeFile(
      path.join(root, 'tools', 'turbo.json'),
      JSON.stringify({ concurrency: '3', tasks: {} }),
    )
    await writeFile(path.join(root, 'tools', 'nx.json'), JSON.stringify({ parallel: 2 }))
    expect([await staged(turbo({ root: 'tools' })), await staged(nx({ root: 'tools' }))]).toEqual([
      { run: { concurrency: 3 } },
      { run: { concurrency: 2 } },
    ])
  })

  it('an empty root is refused, as it is no directory', () => {
    expect(() => turbo({ root: '' })).toThrow('turbo() option "root" is a directory, not empty')
    expect(() => nx({ root: '' })).toThrow('nx() option "root" is a directory, not empty')
  })
})
