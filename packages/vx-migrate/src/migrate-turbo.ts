// Turbo → vx migration: the RENDERING half. The mapping itself lives in
// `turbo()` (which runs it live); this file turns turbo's global
// fields into a root vx-preset.ts that each generated config imports and
// spreads — TypeScript composition replaces turbo's global config.

import path from 'node:path'
import {
  type GeneratedProject,
  type MigrationFormat,
  type MigrationPlan,
  PERSISTENT_TODO,
  type ProjectMeta,
  quoteTsLiteral as quote,
} from '@vzn/vx'
import { mapTurboWorkspace, rootTaskProject, type TurboGlobal } from './turbo/turbo-map.js'
import { relPosix } from './paths.js'
import { trackedFiles, trackedKinds } from './tracked-outputs.js'

/** What a task's `npm_package_*` read: the manifest, so a bump reaches them. */
const MANIFEST_IMPORT = "import pkg from './package.json' with { type: 'json' }"

/** The preset takes the configs' extension: plain arrays either way. */
function presetFile(format: MigrationFormat): string {
  return `vx-preset.${format}`
}

/** The preset export each global field becomes. */
const PRESET_NAMES: Record<TurboGlobal, string> = {
  inputs: 'globalInputs',
  env: 'globalEnvInputs',
  pass: 'globalPassThroughEnv',
}

export async function migrateTurbo(
  root: string,
  metas: readonly ProjectMeta[],
  format: MigrationFormat = 'ts',
): Promise<MigrationPlan> {
  const tracked = await trackedFiles(root)
  const mapping = await mapTurboWorkspace(root, await withRootProject(root, metas), {
    splice: (kind) => [{ raw: `...${PRESET_NAMES[kind]}` }],
    persistentTodo: PERSISTENT_TODO,
    manifestField: (key) => ({ raw: `pkg.${key}` }),
    ...(tracked === null ? {} : { tracked: trackedKinds(tracked) }),
    // The file this writes is each task's config.
    ownConfig: () => `vx.config.${format}`,
    sourceNames: (dir) => spelledNames(root, dir, tracked),
  })

  const projects: GeneratedProject[] = mapping.projects.map((p) => {
    const used = new Set<string>()
    for (const t of p.tasks) for (const kind of t.uses) used.add(PRESET_NAMES[kind])
    const readsManifest = p.tasks.some((t) => JSON.stringify(t.task ?? {}).includes('"pkg.'))
    return {
      name: p.name,
      dir: p.dir,
      importLines: [
        ...(readsManifest ? [MANIFEST_IMPORT] : []),
        ...presetImportLines(used, root, p.dir, format),
      ],
      tasks: p.tasks.map(({ name, todos, task }) => ({ name, todos, task })),
    }
  })

  const { inputs, env, pass } = mapping.globals
  const extraFiles: MigrationPlan['extraFiles'] = []
  if (inputs.length > 0 || env.length > 0 || pass.length > 0) {
    extraFiles.push({ relPath: presetFile(format), contents: renderPreset(inputs, env, pass) })
  }

  return { headerNotes: [], projects, extraFiles, notes: mapping.notes }
}

/** Source and env-example files a framework build reads its variables from. */
const SPELLS_ENV =
  /\.(c|m)?(j|t)sx?$|\.(vue|svelte|astro|html)$|(^|\/)\.env\.(example|sample|template)$/

/**
 * The upper-case names a package's tracked source spells (`NEXT_PUBLIC_API`
 * in `process.env.NEXT_PUBLIC_API` or an `.env.example`), sorted. Without
 * git, none: the note still names the framework's prefix.
 */
async function spelledNames(
  root: string,
  dir: string,
  tracked: readonly string[] | null,
): Promise<string[]> {
  if (tracked === null) return []
  const rel = relPosix(root, dir)
  const prefix = rel === '' || rel === '.' ? '' : `${rel}/`
  const names = new Set<string>()
  for (const f of tracked) {
    if (!f.startsWith(prefix) || !SPELLS_ENV.test(f)) continue
    const text = await Bun.file(path.join(root, f))
      .text()
      .catch(() => '')
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*_[A-Z0-9_]+\b/g)) names.add(m[0])
  }
  return [...names].sort()
}

/**
 * The workspace root as a project when turbo.json declares `//#` tasks and
 * no glob lists the root: the `vx.config.ts` written there is what makes
 * core read it as one (D-39), as `turbo()`'s `discover` hook does live.
 * Five of eleven real Turbo repos had root
 * tasks, and 36 edges to them were dropped (G-49).
 */
async function withRootProject(
  root: string,
  metas: readonly ProjectMeta[],
): Promise<readonly ProjectMeta[]> {
  const named = await rootTaskProject(root)
  // A root the globs list already is a project of this name; a package
  // that took the name leaves the root none to take.
  if (named === null || metas.some((m) => m.name === named.name)) return metas
  const packageJson = (await Bun.file(path.join(root, 'package.json')).json()) as never
  return [...metas, { ...named, packageJson, configPath: null }]
}

function presetImportLines(
  used: ReadonlySet<string>,
  root: string,
  dir: string,
  format: MigrationFormat,
): string[] {
  if (used.size === 0) return []
  // `.js` for the `.ts` file: Bun takes it to the `.ts`, and a user's
  // `tsc` accepts it under every resolution mode, where `.ts` fails
  // without `allowImportingTsExtensions` (TS5097; create-t3-turbo).
  const file = format === 'ts' ? 'vx-preset.js' : presetFile(format)
  const rel = relPosix(dir, path.join(root, file))
  const spec = rel.startsWith('.') ? rel : `./${rel}`
  return [`import { ${[...used].sort().join(', ')} } from '${spec}'`]
}

function renderPreset(inputs: string[], env: string[], pass: string[]): string {
  // Escape each entry via the shared `quote()` — a turbo.json global (a file
  // glob, or an env name a user hand-wrote) may contain a `'`/`\`/newline that
  // would otherwise splice into a malformed, unloadable `vx-preset.ts`.
  const arr = (xs: string[]): string => `[${xs.map(quote).join(', ')}]`
  const lines = [
    // The same name the configs carry (`verb` in index.ts): `vx migrate` is
    // no verb, and a reader who typed it got `unknown command`.
    '// Generated by `vx-migrate` from turbo.json. TypeScript composition',
    "// replaces turbo's global fields: each vx.config.ts imports these",
    '// arrays and spreads them into the matching task fields.',
  ]
  if (inputs.length > 0) {
    lines.push(
      '',
      '// From globalDependencies and what Turbo adds to them (the packages the',
      '// root depends on, microfrontends configs) — workspace-root-relative,',
      '// spread into each task’s cache.inputs.workspaceFiles.',
      `export const globalInputs = ${arr(inputs)}`,
    )
  }
  if (env.length > 0) {
    lines.push(
      '',
      '// From globalEnv: cache inputs AND passed through to every task',
      '// (vx child environments are isolated; see docs/schema.md).',
      `export const globalEnvInputs = ${arr(env)}`,
    )
  }
  if (pass.length > 0) {
    lines.push(
      '',
      '// From globalPassThroughEnv: forwarded to every task, never hashed.',
      `export const globalPassThroughEnv = ${arr(pass)}`,
    )
  }
  lines.push('')
  return lines.join('\n')
}
