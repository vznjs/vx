// What a turbo() run reads before it knows whether its kept mapping still
// holds: the mapping itself (`turbo-map.ts`, ~240 KB with what it imports)
// loads only when it does not.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { relPosix } from '../paths.js'

/** Turbo's name for the workspace root in `//#task` and `extends`. */
export const ROOT = '//'

// Turbo 2's framework inference: a package that depends on a framework has its
// variables hashed into its tasks and passed to them, with nothing in
// turbo.json saying so. Unmapped, a build that inlines them (Next's
// `NEXT_PUBLIC_*`) read empty values; mapped, they join each task's
// `inputs.env` as written, `*` names included. Turbo's own table
// (`packages/turbo-types/src/json/frameworks.json`), in its order: a package
// takes the FIRST framework it matches, `all` needing every dependency and
// `some` any one.
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
  /** Turbo's `envConditionals`: `include` is keyed while `key` holds `value`. */
  conditionals?: ReadonlyArray<{ key: string; value: string; include: readonly string[] }>
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
    // Skew protection builds the deployment id into the app (vercel/turborepo#9853).
    conditionals: [
      { key: 'VERCEL_SKEW_PROTECTION_ENABLED', value: '1', include: ['VERCEL_DEPLOYMENT_ID'] },
    ],
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

// Turbo's own env, from crates/turborepo-env (edace4621): the promise is a
// Turbo repo run unchanged, so these mirror it exactly.
/** `DEFAULT_ENV_VARS`: hashed into every task as if listed in `globalEnv` (a `!` there takes them back). */
export const TURBO_DEFAULT_ENV: readonly string[] = ['VERCEL_ANALYTICS_ID', 'VERCEL_TARGET_ENV']
/** `BUILTIN_PASS_THROUGH_ENV`: passed to every task, never hashed. */
export const TURBO_BUILTIN_PASS_THROUGH: readonly string[] = [
  'HOME',
  'USER',
  'TZ',
  'LANG',
  'SHELL',
  'PWD',
  'XDG_DATA_*',
  'XDG_RUNTIME_DIR',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'CI',
  'NODE_OPTIONS',
  'COREPACK_*',
  'LD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'LIBPATH',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
  'TERM_PROGRAM',
  'DISPLAY',
  'TMP',
  'TEMP',
  'WINDIR',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'VSCODE_*',
  'ELECTRON_RUN_AS_NODE',
  'DOCKER_*',
  'BUILDKIT_*',
  'COMPOSE_*',
  'JB_IDE_*',
  'JB_INTERPRETER',
  '_JETBRAINS_TEST_RUNNER_RUN_SCOPE_TYPE',
  'TURBO_*',
  'VERCEL',
  'VERCEL_*',
  'NEXT_*',
  'USE_OUTPUT_FOR_EDGE_FUNCTIONS',
  'NOW_BUILDER',
  'VC_MICROFRONTENDS_CONFIG_FILE_NAME',
  'GITHUB_*',
  'RUNNER_*',
  '__NIXOS_*',
  'NIX_*',
  'APPDATA',
  'LOCALAPPDATA',
  'PATH',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'PNPM_HOME',
  'pnpm_config_verify_deps_before_run',
  'NPM_CONFIG_STORE_DIR',
  'COMSPEC',
  'PATHEXT',
]

/** A name core takes in `inputs.env` and `exec.env.passThrough`. */
export const keyable = (name: string): boolean =>
  name.length > 0 && !name.startsWith('!') && !/[*?[\]{}=\0]/.test(name)

/**
 * Whether some name may match both `*` patterns (or a pattern and a name):
 * their heads before the first `*`, and tails after the last, agree.
 */
export function mayOverlap(a: string, b: string): boolean {
  const head = (p: string) => (p.includes('*') ? p.slice(0, p.indexOf('*')) : p)
  const tail = (p: string) => (p.includes('*') ? p.slice(p.lastIndexOf('*') + 1) : p)
  if (!a.includes('*') || !b.includes('*')) {
    const [pat, name] = a.includes('*') ? [a, b] : [b, a]
    return new RegExp(`^${pat.split('*').map(RegExp.escape).join('.*')}$`).test(name)
  }
  const [ha, hb, ta, tb] = [head(a), head(b), tail(a), tail(b)]
  return (ha.startsWith(hb) || hb.startsWith(ha)) && (ta.endsWith(tb) || tb.endsWith(ta))
}

/**
 * A directory's Turbo config: `turbo.json`, else `turbo.jsonc` (Turbo 2.5+
 * reads either). Only `turbo.json` was looked for, so a `turbo.jsonc` root
 * failed the run with ENOENT and a package's `turbo.jsonc` overlay was skipped
 * in silence — its `inputs` then keyed nothing.
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
