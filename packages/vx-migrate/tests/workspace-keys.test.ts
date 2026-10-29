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

// What a bare `--affected` compares with: Nx's NX_BASE over nx.json's
// defaultBase (Nx 19's affected.defaultBase before it), Turbo's
// TURBO_SCM_BASE. A key the workspace sets is its own.
describe('the affected base', () => {
  const withEnv = async <T>(name: string, value: string | undefined, fn: () => Promise<T>) => {
    const prev = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env[name]
      else process.env[name] = prev
    }
  }

  it('nx(): NX_BASE is the base commit; defaultBase, then affected.defaultBase, the base branch', async () => {
    const branch = () => withEnv('NX_BASE', undefined, async () => (await staged(nx())).baseBranch)
    await writeFile(path.join(root, 'nx.json'), JSON.stringify({}))
    expect(await branch()).toBeUndefined()
    await writeFile(
      path.join(root, 'nx.json'),
      JSON.stringify({ affected: { defaultBase: 'origin/dev' } }),
    )
    expect(await branch()).toBe('dev')
    await writeFile(
      path.join(root, 'nx.json'),
      JSON.stringify({ defaultBase: 'develop', affected: { defaultBase: 'dev' } }),
    )
    expect(await branch()).toBe('develop')
    expect(await withEnv('NX_BASE', 'origin/next', async () => (await staged(nx())).base)).toBe(
      'origin/next',
    )
    expect(await withEnv('NX_BASE', undefined, () => staged(nx(), { baseBranch: 'main' }))).toEqual(
      { baseBranch: 'main' },
    )
  })

  it('turbo(): TURBO_SCM_BASE', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: {} }))
    // Off GitHub Actions, which vx's own CI is.
    const ci = process.env['GITHUB_ACTIONS']
    delete process.env['GITHUB_ACTIONS']
    try {
      await scmBase()
    } finally {
      if (ci !== undefined) process.env['GITHUB_ACTIONS'] = ci
    }
  })

  // Turbo's `get_github_base_ref`: with no TURBO_SCM_BASE, a pull request's
  // GITHUB_BASE_REF, else the push event's `before`, or the parent of its
  // first commit for a new or forced push. vx guessed origin/HEAD, which a
  // push to main is: nothing affected.
  it('turbo(): on GitHub Actions, the base the event names', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: {} }))
    const event = path.join(root, 'event.json')
    const gha = async (vars: Record<string, string | undefined>, payload?: unknown) => {
      if (payload !== undefined) await writeFile(event, JSON.stringify(payload))
      const names = ['TURBO_SCM_BASE', 'GITHUB_ACTIONS', 'GITHUB_BASE_REF', 'GITHUB_EVENT_PATH']
      const prev = names.map((n) => process.env[n])
      for (const n of names) delete process.env[n]
      Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: event, ...vars })
      for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]
      try {
        return (await staged(turbo())).base
      } finally {
        names.forEach((n, i) => {
          if (prev[i] === undefined) delete process.env[n]
          else process.env[n] = prev[i]
        })
      }
    }
    const sha = 'a'.repeat(40)
    const zero = '0'.repeat(40)
    expect(await gha({ GITHUB_BASE_REF: 'main' }, { before: sha })).toBe('main')
    expect(await gha({ GITHUB_BASE_REF: '' }, { before: sha })).toBe(sha)
    expect(await gha({}, { before: zero, commits: [{ id: 'c1' }, { id: 'c2' }] })).toBe('c1^')
    expect(await gha({}, { before: sha, forced: true, commits: [{ id: 'c1' }] })).toBe('c1^')
    expect(await gha({}, { before: zero, commits: [] })).toBeUndefined()
    expect(await gha({ TURBO_SCM_BASE: 'dev' }, { before: sha })).toBe('dev')
    // Off GitHub Actions, the event says nothing.
    expect(await gha({ GITHUB_ACTIONS: undefined }, { before: sha })).toBeUndefined()
    // A base ref the checkout lacks is origin's only under Turbo's future flag.
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ futureFlags: { githubActionsRemoteBaseRefFallback: true }, tasks: {} }),
    )
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    const git = (...a: string[]) =>
      Bun.spawnSync(
        ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a],
        { cwd: root, stderr: 'pipe' },
      )
    const commit = git('commit', '-q', '--allow-empty', '-m', 'x')
    expect({ code: commit.exitCode, err: commit.stderr.toString() }).toEqual({ code: 0, err: '' })
    git('update-ref', 'refs/remotes/origin/release', 'HEAD')
    expect(await gha({ GITHUB_BASE_REF: 'release' })).toBe('origin/release')
    git('branch', 'release')
    expect(await gha({ GITHUB_BASE_REF: 'release' })).toBe('release')
  })

  async function scmBase() {
    expect(await withEnv('TURBO_SCM_BASE', undefined, () => staged(turbo()))).toEqual({})
    expect(await withEnv('TURBO_SCM_BASE', '', () => staged(turbo()))).toEqual({})
    expect(await withEnv('TURBO_SCM_BASE', 'origin/develop', () => staged(turbo()))).toEqual({
      base: 'origin/develop',
    })
  }
})
