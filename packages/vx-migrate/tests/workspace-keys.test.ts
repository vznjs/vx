// The adopted tool's run-wide settings a `config` hook gives a run: its
// environment only (TURBO_CONCURRENCY, NX_PARALLEL, TURBO_SCM_BASE, NX_BASE).
// A run reads no turbo.json or nx.json (owner, 2026-11-25: a run reads only
// the locks); `vx-migrate` writes their keys into `.vx/workspace.ts`.
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
  lock = false,
): Promise<WorkspaceConfig & { base?: string }> => {
  let base: string | undefined
  await plugin.config!(ws, {
    workspaceRoot: root,
    warn: () => {},
    setBranch: (facts) => void (base = facts.base ?? base),
    lock,
  })
  return base === undefined ? ws : { ...ws, base }
}

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

describe('a run reads no turbo.json or nx.json', () => {
  it('turbo.json concurrency and futureFlags, nx.json parallel and defaultBase, under lock or not', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        concurrency: '3',
        futureFlags: { githubActionsRemoteBaseRefFallback: true },
        tasks: {},
      }),
    )
    await writeFile(path.join(root, 'nx.json'), JSON.stringify({ parallel: 2, defaultBase: 'dev' }))
    const quiet = async (fn: () => Promise<unknown>) =>
      withEnv('TURBO_CONCURRENCY', undefined, () =>
        withEnv('NX_PARALLEL', undefined, () => withEnv('NX_BASE', undefined, fn)),
      )
    expect(
      await quiet(async () => [
        await staged(turbo()),
        await staged(nx()),
        await staged(turbo(), {}, true),
        await staged(nx(), {}, true),
      ]),
    ).toEqual([{}, {}, {}, {}])
  })
})

describe('turbo(): its environment', () => {
  it('TURBO_CONCURRENCY, a count or a share of the cores; a key the workspace sets is its own', async () => {
    const at = (v: string, ws: WorkspaceConfig = {}) =>
      withEnv('TURBO_CONCURRENCY', v, () => staged(turbo(), ws))
    expect([
      await at('3'),
      await at('50%'),
      await at(''),
      await at('3', { run: { concurrency: 8 } }),
    ]).toEqual([
      { run: { concurrency: 3 } },
      { run: { concurrency: Math.max(1, Math.floor(availableParallelism() / 2)) } },
      {},
      { run: { concurrency: 8 } },
    ])
    for (const v of ['abc', '1.5', '-2', '0']) expect(await at(v)).toEqual({})
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

  // Turbo #9053: `turbo run --affected` diffs TURBO_SCM_BASE...TURBO_SCM_HEAD.
  // vx's head is the checkout (HEAD and its working tree), so a head that is
  // HEAD's commit is honoured as is, and any other one is said, not ignored.
  it('TURBO_SCM_HEAD at the checkout is honoured; another head is warned of', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: {} }))
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root })
        .stdout.toString()
        .trim()
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'one')
    git('commit', '-q', '--allow-empty', '-m', 'two')
    const [head, parent] = [git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD~1')]
    const saved = process.env['TURBO_SCM_HEAD']
    try {
      const warned: Record<string, string[]> = {}
      for (const v of ['HEAD', head, '', ' ', parent, 'no-such-ref']) {
        process.env['TURBO_SCM_HEAD'] = v
        const said: string[] = []
        await turbo().config!(
          {},
          { workspaceRoot: root, warn: (m) => void said.push(m), setBranch: () => {}, lock: false },
        )
        warned[v] = said
      }
      expect(Object.values(warned).map((w) => w.length)).toEqual([0, 0, 0, 0, 1, 1])
      expect(warned[parent]![0]).toContain(`TURBO_SCM_HEAD (${parent})`)
      expect(warned['no-such-ref']![0]).toContain('TURBO_SCM_HEAD (no-such-ref)')
    } finally {
      if (saved === undefined) delete process.env['TURBO_SCM_HEAD']
      else process.env['TURBO_SCM_HEAD'] = saved
    }
  })
})

// A relative root resolved against the cwd: `vx run` from a package dir
// read that package's tools/, or nothing. vx reads every other path from
// the workspace root.
describe("a relative root is the workspace root's", () => {
  it('turbo({ root }): `vx lock` reads its boundaries there', async () => {
    await mkdir(path.join(root, 'tools'))
    await writeFile(
      path.join(root, 'tools', 'turbo.json'),
      JSON.stringify({
        boundaries: { tags: { web: { dependencies: { deny: ['internal'] } } } },
        tasks: {},
      }),
    )
    expect(await staged(turbo({ root: 'tools' }), {}, true)).toEqual({
      run: { rules: { dependencies: [{ from: 'tag:web', deny: ['tag:internal'] }] } },
    })
  })

  it('an empty root is refused, as it is no directory', () => {
    expect(() => turbo({ root: '' })).toThrow('turbo() option "root" is a directory, not empty')
    expect(() => nx({ root: '' })).toThrow('nx() option "root" is a directory, not empty')
  })
})

// What a bare `--affected` compares with: Nx's NX_BASE over nx.json's
// defaultBase (Nx 19's affected.defaultBase before it), Turbo's
// TURBO_SCM_BASE (pinned above) or GitHub Actions' base. A key the
// workspace sets is its own.
describe('the affected base', () => {
  it("nx(): NX_BASE is the base commit; nx.json's defaultBase is not read", async () => {
    await writeFile(path.join(root, 'nx.json'), JSON.stringify({ defaultBase: 'develop' }))
    expect(await withEnv('NX_BASE', undefined, () => staged(nx()))).toEqual({})
    expect(await withEnv('NX_BASE', 'origin/next', async () => (await staged(nx())).base)).toBe(
      'origin/next',
    )
  })

  it('nx(): NX_PARALLEL, a count or a share of the cores', async () => {
    expect([
      await withEnv('NX_PARALLEL', '2', () => staged(nx())),
      await withEnv('NX_PARALLEL', '2', () => staged(nx(), { run: { concurrency: 8 } })),
    ]).toEqual([{ run: { concurrency: 2 } }, { run: { concurrency: 8 } }])
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
  })
})
