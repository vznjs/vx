// Turbo's own run switches (`TURBO_*` in crates/turborepo-config/src/env.rs)
// under turbo() and turboCache(): each is read, refused or ignored on
// purpose, and the README says which.
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { UserError } from '@vzn/vx'
import type { WorkspaceConfig } from '@vzn/vx/config'
import { turbo } from '../src/index.js'
import type { PackageMeta } from '../src/packages.js'
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

// Turbo's switches turbo() and turboCache() leave alone, each with a
// value Turbo acts on. CONTROL: each Turbo config variable the plugins
// do not read is in this list, and the README names it.
const IGNORED: Record<string, string> = {
  TURBO_CACHE: 'local:,remote:r',
  TURBO_REMOTE_CACHE_READ_ONLY: 'true',
  TURBO_REMOTE_ONLY: 'true',
  TURBO_LOG_ORDER: 'grouped',
  TURBO_RUN_SUMMARY: 'true',
  TURBO_CACHE_DIR: 'elsewhere/cache',
  TURBO_CACHE_MAX_AGE: '1d',
  TURBO_CACHE_MAX_SIZE: '1GB',
  TURBO_SCM_HEAD: 'HEAD~1',
  TURBO_DAEMON: 'true',
  TURBO_UI: 'tui',
  TURBO_EXPERIMENTAL_UI: 'true',
  TURBO_TUI_SCROLLBACK_LENGTH: '10',
  TURBO_DANGEROUSLY_DISABLE_PACKAGE_MANAGER_CHECK: 'true',
  TURBO_ALLOW_NO_TURBO_JSON: 'true',
  TURBO_LOGIN: 'https://login.example',
  TURBO_SSO_LOGIN_CALLBACK_PORT: '9789',
  TURBO_NO_UPDATE_NOTIFIER: '1',
  TURBO_PRINT_VERSION_DISABLED: '1',
  TURBO_GLOBAL_WARNING_DISABLED: '1',
  TURBO_DOWNLOAD_LOCAL_ENABLED: '1',
  TURBO_LOG_VERBOSITY: 'debug',
  TURBO_LOG_FILE: 'turbo.log',
  TURBO_EXPERIMENTAL_OTEL_ENABLED: 'true',
}

/** Turbo's `TURBO_MAPPING` (crates/turborepo-config/src/env.rs, 2.11), the OTel family as one. */
const TURBO_CONFIG_ENV = [
  'TURBO_API',
  'TURBO_LOGIN',
  'TURBO_TEAM',
  'TURBO_TEAMID',
  'TURBO_TOKEN',
  'TURBO_REMOTE_CACHE_TIMEOUT',
  'TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT',
  'TURBO_UI',
  'TURBO_DANGEROUSLY_DISABLE_PACKAGE_MANAGER_CHECK',
  'TURBO_DAEMON',
  'TURBO_ENV_MODE',
  'TURBO_CACHE_DIR',
  'TURBO_CACHE_MAX_AGE',
  'TURBO_CACHE_MAX_SIZE',
  'TURBO_PREFLIGHT',
  'TURBO_SCM_BASE',
  'TURBO_SCM_HEAD',
  'TURBO_ROOT_TURBO_JSON',
  'TURBO_FORCE',
  'TURBO_LOG_ORDER',
  'TURBO_REMOTE_ONLY',
  'TURBO_REMOTE_CACHE_READ_ONLY',
  'TURBO_RUN_SUMMARY',
  'TURBO_ALLOW_NO_TURBO_JSON',
  'TURBO_CACHE',
  'TURBO_TUI_SCROLLBACK_LENGTH',
  'TURBO_CONCURRENCY',
  'TURBO_NO_UPDATE_NOTIFIER',
  'TURBO_SSO_LOGIN_CALLBACK_PORT',
  'TURBO_LOG_FILE',
  'TURBO_EXPERIMENTAL_OTEL_ENABLED',
]

const SRC = path.join(import.meta.dir, '..', 'src')
const srcText = (dir = SRC): string =>
  readdirSync(dir, { withFileTypes: true })
    .map((e) =>
      e.isDirectory()
        ? srcText(path.join(dir, e.name))
        : e.name.endsWith('.ts')
          ? readFileSync(path.join(dir, e.name), 'utf8')
          : '',
    )
    .join('\n')

describe("Turbo's switches the plugins leave alone", () => {
  it('each Turbo config variable is read, or ignored here and in the README', () => {
    const src = srcText()
    const readme = readFileSync(path.join(import.meta.dir, '..', 'README.md'), 'utf8')
    const line = readme.split('\n').find((l) => l.startsWith("- Turbo's run switches"))
    expect({
      unclassified: TURBO_CONFIG_ENV.filter((n) => !src.includes(`'${n}'`) && !(n in IGNORED)),
      ignoredButRead: Object.keys(IGNORED).filter((n) => src.includes(`'${n}'`)),
      // The OTel family is named as `TURBO_EXPERIMENTAL_OTEL_*`.
      ignoredUnnamed: Object.keys(IGNORED).filter(
        (n) => !line?.includes(n.replace(/^(TURBO_EXPERIMENTAL_OTEL)_ENABLED$/, '$1_*')),
      ),
    }).toEqual({ unclassified: [], ignoredButRead: [], ignoredUnnamed: [] })
  })

  it('a turbo() repo maps and stages the same with every one of them set', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { outputs: ['dist/**'] } }, concurrency: '3' }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    const packageJson = { name: 'a', scripts: { build: 'b' } }
    const metas: PackageMeta[] = [
      { name: 'a', dir, packageJson: packageJson as never, configPath: null },
    ]
    const both = async () => {
      const ws: WorkspaceConfig = {}
      const branch: unknown[] = []
      await turbo().config!(ws, {
        workspaceRoot: root,
        warn: () => {},
        setBranch: (f) => void branch.push(f),
      })
      const m = await mapTurboWorkspace(root, metas, { splice: ownSplice, persistentTodo: 'P' })
      return { ws, branch, tasks: m.projects.map((p) => p.tasks), notes: m.notes }
    }
    const unset = Object.fromEntries(Object.keys(IGNORED).map((n) => [n, '']))
    const before = await withEnv(unset, both)
    expect(before.ws).toEqual({ run: { concurrency: 3 } })
    expect(await withEnv(IGNORED, both)).toEqual(before)
  })
})
