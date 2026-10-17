// src/settings.ts is the one list of vx's settings: every `VX_*` name core
// reads is one of them (or a variable vx sets for tasks), every
// `.vx/workspace` group field is one, a flag beats its variable, which
// beats the workspace, and the docs' tables are generated from it.
//
//   VX_UPDATE_CONTRACT=1 bun test tests/settings.test.ts   (rewrite the tables)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  checkSettingsEnv,
  envName,
  kindHint,
  parseSettingValue,
  resolveSetting,
  type Setting,
  SETTING_GROUPS,
  SETTINGS,
  settingEnv,
} from '../src/settings.js'
import { validateWorkspace } from '../src/workspace/index.js'
import { acceptedFlags } from '../src/cli/help.js'
import { parseRunArgs } from '../src/cli/run.js'

const ROOT = path.join(import.meta.dir, '..')
const SRC = path.join(ROOT, 'src')
/** What vx sets for the processes it starts: outputs, never settings. */
const TASK_MARKERS = ['VX_RUN_WORKSPACE', 'VX_RUN_TASK', 'VX_HANDED_OFF']

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(path.join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [path.join(dir, e.name)]
        : [],
  )
}

const setting = (p: string): Setting => SETTINGS.find((s) => s.path === p)!

describe('the settings list', () => {
  it('derives each variable from its path', () => {
    expect(envName('run.timeout')).toBe('VX_RUN_TIMEOUT')
    expect(envName('cache.inputStability.strategy')).toBe('VX_CACHE_INPUT_STABILITY_STRATEGY')
    expect(envName('debug.timing')).toBe('VX_DEBUG_TIMING')
  })

  it('reads no variable for cache.outputs.clean: config only (M, 2026-10-15)', () => {
    const env = { VX_CACHE_OUTPUTS_CLEAN: 'false' }
    expect(settingEnv('cache.outputs.clean', env)).toBeUndefined()
    expect(
      resolveSetting(
        'cache.outputs.clean',
        { cache: { outputs: { clean: true } } },
        undefined,
        env,
      ),
    ).toEqual({ value: true, source: 'workspace' })
  })

  it('derives no variable vx sets for tasks, and no two settings share one', () => {
    const names = SETTINGS.map((s) => envName(s.path))
    expect(names.filter((n) => TASK_MARKERS.includes(n))).toEqual([])
    expect(new Set(names).size).toBe(names.length)
  })

  it('names every VX_ variable src reads', () => {
    const known = new Set([
      ...SETTINGS.filter((s) => s.env !== false).map((s) => envName(s.path)),
      ...TASK_MARKERS,
    ])
    const stray: string[] = []
    for (const file of sources(SRC)) {
      if (file.endsWith(`${path.sep}settings.ts`)) continue
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/['"`](VX_[A-Z0-9_]+)['"`]/g)) {
        if (!m[1]!.startsWith('VX_E_') && !known.has(m[1]!))
          stray.push(`${path.relative(ROOT, file)}: ${m[1]}`)
      }
    }
    expect(stray).toEqual([])
  })

  it('holds every field of the workspace groups in src/config.ts, and the top-level settings', () => {
    const config = readFileSync(path.join(SRC, 'config.ts'), 'utf8')
    const fieldsOf = (name: string): string[] => {
      const body = config.slice(config.indexOf(`export interface ${name} {`))
      return [...body.slice(0, body.indexOf('\n}\n')).matchAll(/^ {2}(\w+)\?:/gm)].map((m) => m[1]!)
    }
    const declared = [
      ...fieldsOf('WorkspaceConfig').filter(
        (f) => !(SETTING_GROUPS as readonly string[]).includes(f) && f !== 'plugins',
      ),
      ...fieldsOf('RunSettings').map((f) => `run.${f}`),
      ...fieldsOf('CacheSettings').map((f) => `cache.${f}`),
      ...fieldsOf('LockSettings').map((f) => `lock.${f}`),
      ...fieldsOf('WatchSettings').map((f) => `watch.${f}`),
    ].sort()
    const listed = [
      ...new Set(
        SETTINGS.filter((s) => s.config !== false).map((s) =>
          s.path.split('.').slice(0, 2).join('.'),
        ),
      ),
    ].sort()
    expect(declared).toEqual(listed)
    expect([...SETTING_GROUPS]).toEqual(['run', 'cache', 'lock', 'watch'])
  })

  it('gives every flag on its verb', () => {
    const missing = SETTINGS.filter((s) => s.flag !== undefined).flatMap((s) =>
      [s.flag!.name].filter((n) => !acceptedFlags(s.flag!.verb).includes(n)),
    )
    expect(missing).toEqual([])
  })
})

/** A value each kind takes, for a workspace that sets everything. */
function sample(s: Setting): unknown {
  if (s.path === 'cache.policy') return 'local:rw,remote:r'
  if (s.path === 'baseBranch') return 'main'
  if (s.path === 'cache.dir') return 'build/cache'
  switch (s.kind.type) {
    case 'int':
      return 1
    case 'concurrency':
      return '50%'
    case 'duration':
      return '30s'
    case 'size':
      return '10GB'
    case 'bool':
      return true
    case 'enum':
      return s.kind.values[0]
    case 'string':
      return 'x'
  }
}

function setAt(config: Record<string, unknown>, p: string, value: unknown): void {
  const keys = p.split('.')
  let at = config
  for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Record<string, unknown>
  at[keys.at(-1)!] = value
}

describe('a workspace', () => {
  it('takes every setting at its path', () => {
    const config: Record<string, unknown> = {}
    for (const s of SETTINGS) if (s.config !== false) setAt(config, s.path, sample(s))
    expect(() => validateWorkspace(config, '.vx/workspace.ts')).not.toThrow()
  })

  it('refuses a setting read before it loads, and a field no setting is', () => {
    expect(() => validateWorkspace({ debug: { timing: true } } as never, 'w')).toThrow(
      'unknown field "debug"',
    )
    expect(() => validateWorkspace({ run: { timing: true } } as never, 'w')).toThrow(
      'w: `run` has unknown field "timing"',
    )
  })

  it('refuses a bare number for a duration, naming the forms with units', () => {
    expect(() => validateWorkspace({ run: { timeout: 30000 } } as never, 'w')).toThrow(
      "w: `run.timeout` takes a duration with its unit, like '30000ms' or '30s' (got 30000)",
    )
  })

  it('refuses a flat key from before the groups as any unknown field, with no history', () => {
    expect(() => validateWorkspace({ concurrency: 1 } as never, 'w')).toThrow(
      'w has unknown field "concurrency"',
    )
    expect(() => validateWorkspace({ concurrency: 1 } as never, 'w')).not.toThrow('removed')
  })
})

describe('precedence: flag, then variable, then workspace', () => {
  const ws = { run: { timeout: '1m' } }
  it('takes the flag over the variable and the workspace', () => {
    expect(resolveSetting('run.timeout', ws, 5, { VX_RUN_TIMEOUT: '2s' })).toEqual({
      value: 5,
      source: 'flag',
    })
  })
  it('takes the variable over the workspace', () => {
    expect(resolveSetting('run.timeout', ws, undefined, { VX_RUN_TIMEOUT: '2s' })).toEqual({
      value: 2000,
      source: 'env',
    })
  })
  it('takes the workspace, else the default', () => {
    expect(resolveSetting('run.timeout', ws, undefined, {})).toEqual({
      value: 60_000,
      source: 'workspace',
    })
    expect(resolveSetting('run.timeout', {}, undefined, {})).toEqual({
      value: undefined,
      source: 'default',
    })
  })
  it('reads a variable-only setting from no workspace', () => {
    expect(resolveSetting('debug.timing', { debug: { timing: true } }, undefined, {})).toEqual({
      value: undefined,
      source: 'default',
    })
  })
})

describe('the environment', () => {
  it('ignores a variable vx does not read, an old name included', () => {
    expect(() => checkSettingsEnv({ VX_KILL_GRACE_MS: '200', VX_TIMING: '1' })).not.toThrow()
  })
  it('refuses a value its kind does not take, before any verb runs', () => {
    expect(() => checkSettingsEnv({ VX_RUN_TIMEOUT: '0' })).toThrow(
      "VX_RUN_TIMEOUT must be a duration like '500ms', '30s' or '5m', at most 24 days (got 0)",
    )
    expect(() => checkSettingsEnv({ VX_RUN_RETRIES: '-1' })).toThrow('VX_RUN_RETRIES')
  })
  it('takes an empty variable as unset', () => {
    expect(() => checkSettingsEnv({ VX_RUN_TIMEOUT: '' })).not.toThrow()
  })
})

describe('flags', () => {
  it('parse each setting by its kind', () => {
    const p = parseRunArgs([
      'build',
      '--timeout',
      '2m',
      '--retries=2',
      '--schedule=critical-path',
      '--cache-download',
      'toplevel',
    ])
    expect(p.error).toBeUndefined()
    expect(p.settings).toEqual({
      'run.timeout': 120_000,
      'run.retries': 2,
      'run.schedule': 'critical-path',
      'cache.download': 'toplevel',
    })
  })
  it('take an alias', () => {
    expect(parseRunArgs(['build', '--cache-download=none']).settings).toEqual({
      'cache.download': 'none',
    })
  })
  it('refuse an old flag name as any unknown flag, with no history', () => {
    const error = parseRunArgs(['build', '--retry', '2']).error
    expect(error).toStartWith('unknown flag: --retry')
    expect(error).not.toContain('renamed')
  })
  it('refuse a bare number for a duration', () => {
    expect(parseRunArgs(['build', '--timeout', '500']).error).toBe(
      "--timeout takes a duration with its unit, like '500ms' or '1s' (got 500)",
    )
  })
})

describe('parseSettingValue', () => {
  it('reads durations in ms and refuses one past the timer', () => {
    const timer = setting('run.timeout').kind
    expect(parseSettingValue(timer, '500ms')).toBe(500)
    expect(parseSettingValue(timer, '2h')).toBe(7_200_000)
    expect(parseSettingValue(timer, '30d')).toBeNull()
    expect(parseSettingValue(setting('cache.retention.olderThan').kind, '30d')).toBe(2_592_000_000)
  })
})

/** The table docs/schema.md § Settings holds. */
function settingsTable(): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|')
  const rows = SETTINGS.map((s) => {
    const flag =
      s.flag === undefined ? '—' : `\`${s.flag.verb === 'watch' ? 'vx watch ' : ''}${s.flag.name}\``
    const what = s.doc + (s.task !== undefined ? ` A task's own \`${s.task}\` beats it.` : '')
    return `| \`${s.path}\`${s.config === false ? ' (variable or flag only)' : ''} | ${s.env === false ? '—' : `\`${envName(s.path)}\``} | ${flag} | ${cell(kindHint(s.kind))} | ${cell(s.default)} | ${cell(what)} |`
  })
  return [
    '| Setting | Variable | Flag | Value | Default | What it does |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

/** The table docs/cli.md § Environment variables holds: each variable vx reads. */
function variablesTable(): string {
  const rows = SETTINGS.filter((s) => s.env !== false).map(
    (s) =>
      `| \`${envName(s.path)}\` | [\`${s.path}\`](schema.md#settings) | ${s.doc.replace(/\|/g, '\\|')} |`,
  )
  return [
    '| Variable | Setting | What it does |',
    '| --- | --- | --- |',
    ...rows,
    "| `VX_HANDED_OFF` | — | Set by a global vx that hands the call to the project's own (§ Which vx runs): the path of the vx that handed off, so the receiver does not hand off again. |",
    '| `VX_RUN_WORKSPACE`, `VX_RUN_TASK` | — | Set by vx on every task (below); a `vx run` a task starts reads them back. |',
  ].join('\n')
}

/** Hold the generated table between `<!-- name: … -->` and `<!-- /name -->` in `rel`. */
function holdTable(rel: string, name: string, want: string): void {
  const file = path.join(ROOT, rel)
  const doc = readFileSync(file, 'utf8')
  const begin = `<!-- ${name}: generated by tests/settings.test.ts -->`
  const start = doc.indexOf(begin)
  const end = doc.indexOf(`<!-- /${name} -->`)
  expect(start).toBeGreaterThan(-1)
  // oxfmt pads the table; compare its cells, not its spaces.
  const cells = (t: string): string =>
    t
      .split('\n')
      .map((l) => l.replace(/ {2,}/g, ' ').replace(/-{3,}/g, '---').trim())
      .join('\n')
  const have = doc.slice(start + begin.length, end).trim()
  if (cells(have) !== cells(want) && process.env['VX_UPDATE_CONTRACT'] === '1') {
    writeFileSync(file, `${doc.slice(0, start + begin.length)}\n\n${want}\n\n${doc.slice(end)}`)
    return
  }
  expect(cells(have)).toBe(cells(want))
}

it('docs/schema.md § Settings is the list, as a table', () => {
  holdTable('docs/schema.md', 'settings table', settingsTable())
})

it('docs/cli.md § Environment variables lists each variable, from the list', () => {
  holdTable('docs/cli.md', 'variables table', variablesTable())
})
