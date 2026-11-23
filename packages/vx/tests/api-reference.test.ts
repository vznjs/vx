// docs/api.md is generated from `src/index.ts`: every export, its
// declaration as the contract records it (tests/helpers/api-surface.ts) and
// the doc comment above it. The committed page must equal what the source
// says, so a changed signature or comment turns this red until the page is
// regenerated:
//   VX_UPDATE_CONTRACT=1 bun test tests/api-reference.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { exportsOf } from './helpers/api-surface.js'

const ROOT = path.resolve(import.meta.dir, '..')
const PAGE = path.join(ROOT, 'docs', 'api.md')

function page(): string {
  const entries = exportsOf(path.join(ROOT, 'src', 'index.ts'), ROOT)
  const out = [
    '# API reference',
    '',
    'Every export of `@vzn/vx`, generated from `src/index.ts` by',
    '`tests/api-reference.test.ts`: the declaration (comments dropped, a',
    'function to its signature, a class to its public members) and the doc',
    'comment above it. [The public surface](modules/index.md#srcindexts--public-package-surface) groups the',
    'same names by what they are for; the plugins guide shows them in use.',
    '',
  ]
  for (const e of entries) {
    out.push(`## \`${e.name}\``, '', `${e.kind} · \`${e.file}\``, '')
    if (e.doc !== '') out.push(e.doc, '')
    out.push('```ts', ...e.text, '```', '')
  }
  return out.join('\n')
}

it('docs/api.md is what src/index.ts exports, with each doc comment', () => {
  const want = page()
  if (process.env['VX_UPDATE_CONTRACT'] === '1') writeFileSync(PAGE, want)
  expect(readFileSync(PAGE, 'utf8')).toBe(want)
})

// A plugin author implements and reads these, so every type their
// declarations name must be one `@vzn/vx` exports: `ExecuteResult` named
// `SandboxViolation`, `ExecuteRequest` `CaptureConfig` and `TaskInputs`,
// every hook context `BaseContext`, `Logger` `RunContext` and the telemetry
// records `FailedAttempt` and `RunStage`, and none could be imported.
const PLUGIN_FACING =
  /^(VxPlugin|PluginHooks|\w+Context|TaskExecutor|Execute\w+|RemoteCacheLayer|PluginCache|TelemetrySink|TelemetryRecord|RunSummaryRecord|TaskTelemetry|Logger|RunReport\w*|WorkspaceConfig|ProjectConfig|TaskConfig|ExecConfig|RunSettings|SandboxConfig)$/
// `Plugin` is the shape `WorkspaceConfig.plugins` holds, so the schema
// needn't import the orchestrator: a plugin names `VxPlugin`.
const GLOBALS = new Set(
  'Plugin Map ReadonlyMap Set ReadonlySet Promise Record Readonly ReadonlyArray Partial Omit Pick Exclude Error Blob Response AbortSignal NodeJS ProcessEnv Uint8Array ReadableStream Bun ReturnType Iterable K'.split(
    ' ',
  ),
)

it('a plugin-facing declaration names only types the package exports', () => {
  const entries = exportsOf(path.join(ROOT, 'src', 'index.ts'), ROOT)
  const exported = new Set(entries.map((e) => e.name))
  const missing: string[] = []
  let checked = 0
  for (const e of entries) {
    if (!PLUGIN_FACING.test(e.name)) continue
    checked += 1
    // `ui.Inline` is reached through the exported `ui` namespace.
    const code = e.text
      .join('\n')
      .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')
      .replace(/\bui\.\w+/g, '')
    for (const [, t] of code.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) {
      if (!exported.has(t!) && !GLOBALS.has(t!)) missing.push(`${e.name}: ${t}`)
    }
  }
  expect(checked).toBeGreaterThan(20)
  expect([...new Set(missing)].sort()).toEqual([])
})
