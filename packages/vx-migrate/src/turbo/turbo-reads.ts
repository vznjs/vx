// What a turbo() run reads before it knows whether its kept mapping still
// holds: the mapping itself (`turbo-map.ts`, ~240 KB with what it imports)
// loads only when it does not.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { relPosix } from '../paths.js'

/** Turbo's name for the workspace root in `//#task` and `extends`. */
export const ROOT = '//'

// Turbo 2's framework inference: a package that depends on a framework
// has its variables hashed into its tasks and passed to them, with
// nothing in turbo.json saying so. vx env names are explicit, so the
// variables were stripped in silence and a build that inlines them
// (Next's `NEXT_PUBLIC_*`) read empty values (item 940). A live mapping
// (`envNames`) infers them as Turbo does; the migrate CLI lists the names
// the package's own files spell (`sourceNames`) and says so in a note.
// Turbo's own table (`packages/turbo-types/src/json/frameworks.json`),
// in its order: a package takes the FIRST framework it matches, `all`
// needing every dependency and `some` any one.
const NITRO_ENV = [
  'NITRO_*',
  'SERVER_*',
  'AWS_APP_ID',
  'INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN',
  'CLEAVR',
  'CF_PAGES',
  'FIREBASE_APP_HOSTING',
  'NETLIFY',
  'STORMKIT',
  'NOW_BUILDER',
  'ZEABUR',
  'RENDER',
]
export const FRAMEWORK_ENV: ReadonlyArray<{
  slug: string
  env: readonly string[]
  all: boolean
  dependencies: readonly string[]
}> = [
  { slug: 'astro', env: ['PUBLIC_*'], all: true, dependencies: ['astro'] },
  { slug: 'blitzjs', env: ['NEXT_PUBLIC_*'], all: true, dependencies: ['blitz'] },
  {
    slug: 'create-react-app',
    env: ['REACT_APP_*'],
    all: false,
    dependencies: ['react-scripts', 'react-dev-utils'],
  },
  { slug: 'expo', env: ['EXPO_PUBLIC_*'], all: true, dependencies: ['expo'] },
  { slug: 'gatsby', env: ['GATSBY_*'], all: true, dependencies: ['gatsby'] },
  {
    slug: 'nextjs',
    env: ['NEXT_PUBLIC_*', 'NEXT_DEPLOYMENT_ID'],
    all: true,
    dependencies: ['next'],
  },
  {
    slug: 'nitro',
    env: NITRO_ENV,
    all: false,
    dependencies: ['nitropack', 'nitropack-nightly', 'nitro', 'nitro-nightly'],
  },
  {
    slug: 'nuxtjs',
    env: ['NUXT_*', 'NUXT_ENV_*', ...NITRO_ENV, 'LAUNCH_EDITOR'],
    all: false,
    dependencies: ['nuxt', 'nuxt-edge', 'nuxt3', 'nuxt3-edge'],
  },
  { slug: 'redwoodjs', env: ['REDWOOD_ENV_*'], all: true, dependencies: ['@redwoodjs/core'] },
  {
    slug: 'remix',
    env: ['REMIX_*'],
    all: false,
    dependencies: ['@remix-run/dev', '@remix-run/react', '@remix-run/serve', '@react-router/dev'],
  },
  { slug: 'sanity', env: ['SANITY_STUDIO_*'], all: true, dependencies: ['@sanity/cli'] },
  { slug: 'solidstart', env: ['VITE_*'], all: true, dependencies: ['solid-js', 'solid-start'] },
  { slug: 'sveltekit', env: ['VITE_*', 'PUBLIC_*'], all: true, dependencies: ['@sveltejs/kit'] },
  { slug: 'vite', env: ['VITE_*'], all: true, dependencies: ['vite'] },
  {
    slug: 'vue',
    env: ['VUE_APP_*', 'LAUNCH_EDITOR'],
    all: true,
    dependencies: ['@vue/cli-service'],
  },
]

/** A name core takes in `inputs.env` and `exec.env.passThrough`. */
export const keyable = (name: string): boolean =>
  name.length > 0 && !name.startsWith('!') && !/[*?[\]{}=\0]/.test(name)

/**
 * The names of `names` a live mapping can read differently: each a `*` in
 * one of `configs` (turbo.json texts, any string, a superset) or in Turbo's
 * framework table matches, and each core cannot key (a literal one is
 * dropped only when no variable has it). The kept mapping keyed on every
 * name, so any variable that came or went (a CI step's, `VX_DEBUG_TIMING`)
 * remapped the workspace: ~330 ms a run on vercel/ai.
 */
export function envNamesThatMap(configs: readonly string[], names: readonly string[]): string[] {
  const patterns = new Set(FRAMEWORK_ENV.flatMap((f) => f.env).filter((e) => e.includes('*')))
  for (const text of configs)
    for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/g))
      if (m[1]!.includes('*')) patterns.add(m[1]!)
  // Backslashes and a leading `!` dropped, every `*` a wildcard: wider
  // than Turbo's reading, never narrower.
  const res = [...patterns].map(
    (p) =>
      new RegExp(
        `^${p.replaceAll('\\', '').replace(/^!/, '').split('*').map(RegExp.escape).join('.*')}$`,
      ),
  )
  return names.filter((n) => !keyable(n) || res.some((re) => re.test(n)))
}

/**
 * A directory's Turbo config: `turbo.json`, else `turbo.jsonc` (Turbo 2.5+
 * reads either). Only `turbo.json` was looked for, so a `turbo.jsonc` root
 * failed the run with ENOENT and a package's `turbo.jsonc` overlay was
 * skipped in silence — its `inputs` then keyed nothing (item 938).
 */
export async function turboConfigFile(dir: string): Promise<string | null> {
  for (const name of ['turbo.json', 'turbo.jsonc']) {
    const file = path.join(dir, name)
    if (await Bun.file(file).exists()) return file
  }
  return null
}

/**
 * The workspace root as a project to name when turbo.json declares `//#`
 * tasks: its package name and directory. Null with no such task, a
 * nameless root, or a file the mapping refuses (it names the file).
 */
export async function rootTaskProject(root: string): Promise<{ name: string; dir: string } | null> {
  const file = await turboConfigFile(root)
  if (file === null) return null
  let turbo: { tasks?: unknown; pipeline?: unknown } | null
  let pkg: { name?: unknown } | null
  try {
    turbo = Bun.JSONC.parse(await Bun.file(file).text()) as typeof turbo
    pkg = (await Bun.file(path.join(root, 'package.json')).json()) as typeof pkg
  } catch {
    return null
  }
  const tasks = turbo?.tasks ?? turbo?.pipeline
  const hasRootTask =
    typeof tasks === 'object' &&
    tasks !== null &&
    Object.keys(tasks).some((k) => k.startsWith(`${ROOT}#`))
  if (!hasRootTask || typeof pkg?.name !== 'string' || pkg.name === '') return null
  return { name: pkg.name, dir: root }
}

/**
 * The microfrontends configs Turbo hashes into every task: each package's
 * (the root's too) `microfrontends.json`, else `microfrontends.jsonc`, or
 * the one name `VC_MICROFRONTENDS_CONFIG_FILE_NAME` gives, unless it is a
 * child's `{ "partOf": … }` (Turbo's `update_turbo_json` appends them to
 * the root's global deps). Unread, an edit to `web`'s routes replayed every
 * sibling app's build (with-microfrontends, Turbo 2.11's dry run moves all
 * 18 tasks). Paths are root-relative; `text` is what the mapping read.
 */
export function microfrontendsConfigs(
  root: string,
  dirs: readonly string[],
  custom = process.env['VC_MICROFRONTENDS_CONFIG_FILE_NAME'] ?? '',
): { rel: string; text: string }[] {
  const names = custom === '' ? ['microfrontends.json', 'microfrontends.jsonc'] : [custom]
  const out: { rel: string; text: string }[] = []
  for (const dir of new Set(dirs.map((d) => path.resolve(d)))) {
    const file = names.map((n) => path.join(dir, n)).find((f) => existsSync(f))
    if (file === undefined) continue
    const text = readFileSync(file, 'utf8')
    let child = false
    try {
      const parsed = Bun.JSONC.parse(text) as { partOf?: unknown } | null
      child = typeof parsed?.partOf === 'string'
    } catch {}
    if (!child) out.push({ rel: relPosix(root, file), text })
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
}
