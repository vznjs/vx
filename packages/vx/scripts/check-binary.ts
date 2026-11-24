// The compiled binary, as a user meets it: compile THIS host's target the
// way npm.yml does, launch it (re-signed only if macOS refuses it,
// binary-launch.ts), and assert `--version` reports the version
// package.json carries, which src/version.ts inlines and the release
// workflows stamp. A layout move broke that stamp unseen for a week once
// (2026-08-26 → 09-03); this runs in every CI pipeline.
//
// One host binary, not four cross targets: what a dependant needs from
// core is its SOURCE, so `build` is not a task core has — the four
// release targets are `compile.bun.*`, and the gate proves the one it can
// run. The output lives under dist/check-binary/, apart from theirs.
//
// Then the config worker, which is why its source is an inline string
// (src/workspace/config-eval.ts): the binary's `vx info` over a workspace
// whose one config holds a function. The run-path load refuses it
// in-process, and the doctor's per-file fallback loads the same file
// AGAIN, which is the worker path; its error row is the worker's refusal,
// made by `nonJsonPaths` embedded by its source text (item 701). A worker
// that failed to start, or a source that minified into something else,
// names a different error, and a worker without the check reports none.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchVersion } from './binary-launch.ts'
import { LOCKFILE_VERSION } from '../src/workspace/index.ts'

const root = path.resolve(import.meta.dir, '..')
const host = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
// Not dist/vx-<host>: `release` runs compile.bun.<host> beside this on one
// worker, and its compile rewrote the file this was launching (EACCES).
const out = path.join(root, 'dist', 'check-binary', `vx-${host}`)

const text = (b: Uint8Array): string => new TextDecoder().decode(b)
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
const spawn = (cmd: string[], cwd: string, env?: Record<string, string>) =>
  Bun.spawnSync({ cmd, cwd, ...(env && { env }), stdout: 'pipe', stderr: 'pipe' })
const run = (cmd: string[], label: string): void => {
  const r = spawn(cmd, root)
  if (r.exitCode !== 0)
    fail(`${label} failed (exit ${r.exitCode}):\n${text(r.stdout)}${text(r.stderr)}`)
}

/**
 * A throwaway workspace of `files` (relative path → text). Outside the
 * repo: under dist/, discovery would find this repo's own workspace above it.
 */
function workspace(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `vx-check-${prefix}-`))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), body)
  }
  return dir
}
// One package `a`, its config given.
const oneProject = (config: string): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
  '.vx/workspace.mjs': 'export default {}\n',
  'packages/a/package.json': JSON.stringify({ name: 'a' }),
  'packages/a/vx.config.mjs': config,
})
// A host config that signs commits (an SSH signer such as 1Password's)
// reaches a service the sandbox refuses; a fixture needs git's defaults.
const git = (cwd: string, ...args: string[]): void => {
  Bun.spawnSync({
    cmd: ['git', '-c', 'user.email=ci@vx', '-c', 'user.name=ci', ...args],
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
}

// This task's own sandbox, where one is required: on Linux its tracer is
// vx's observer, an ancestor of this process, and not the strace it falls
// back to in silence when the host probe fails. The arm64 worker runs
// nothing else, so this is where the arm64 helper is proven.
if (
  process.platform === 'linux' &&
  process.env['VX_REQUIRE_SANDBOX'] === '1' &&
  process.env['VX_DEBUG_STRACE'] !== '1'
) {
  // From `self`, by the numbers /proc itself gives: a container that cannot
  // mount /proc shows the outer namespace's, where `process.ppid` is no name.
  const chain: string[] = []
  for (let at = 'self'; at !== '0';) {
    let stat: string
    try {
      stat = readFileSync(`/proc/${at}/stat`, 'utf8')
    } catch {
      break
    }
    if (at !== 'self') chain.push(stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')))
    at = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] ?? '0'
  }
  if (!chain.some((comm) => comm.startsWith('vx-observe'))) {
    fail(
      `this task's sandbox is not under vx's observer: its ancestors are ${chain.join(' < ') || 'unreadable'}`,
    )
  }
  console.log(
    `this task's sandbox reports through ${chain.find((comm) => comm.startsWith('vx-observe'))}`,
  )
}

run(
  [
    'bun',
    'build',
    '--compile',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    '--compile-autoload-package-json',
    '--minify',
    '--bytecode',
    '--format=esm',
    '--splitting',
    `--target=bun-${host}`,
    'src/bin.ts',
    '--outfile',
    out,
  ],
  'compile',
)

const want = `vx ${((await Bun.file(path.join(root, 'package.json')).json()) as { version: string }).version}`
const got = launchVersion(out)
if (got.exitCode !== 0 || got.version !== want) {
  fail(
    `binary reports ${JSON.stringify(got.version)} (exit ${got.exitCode}), expected ${JSON.stringify(want)}\n${got.stderr}`,
  )
}
console.log(`${path.relative(root, out)} reports ${got.version}`)

// `vx lock --check` evaluates the config twice in one process: the graph
// check's first load in process, then the audit's repeat load in the
// worker. A worker that let the function through would report drift.
const ws = workspace('binary', {
  ...oneProject(`export default {
  tasks: { build: { exec: { command: 'true' }, description: () => 'x' } },
}
`),
  // A header and no entry: the audit evaluates the config, which refuses.
  '.vx/projects.lock': `${JSON.stringify({ version: LOCKFILE_VERSION })}\n`,
})
const check = spawn([out, 'lock', '--check'], ws)
const refusal =
  'tasks.build.description is a function — a config must be JSON data, because the cache key is built from its JSON'
const said = text(check.stderr)
rmSync(ws, { recursive: true, force: true })
if (check.exitCode === 0 || !said.includes(refusal) || said.includes('evaluates differently')) {
  fail(
    `binary's config worker: \`vx lock --check\` said ${JSON.stringify(said)} (exit ${check.exitCode}), expected the refusal ${JSON.stringify(refusal)}`,
  )
}
console.log(`${path.relative(root, out)} refuses a non-JSON config in its config worker`)

// A compiled Bun binary loads `.env`, `.env.local` and `.env.<NODE_ENV>`
// from its working directory into its own environment unless it was built
// with --no-compile-autoload-dotenv, and a task's passThrough then saw a
// value no shell had set (item 1089). A workspace with a `.env` that sets
// the name a task passes through: the task must see it unset.
const dotenv = workspace('dotenv', {
  ...oneProject(
    `export default { name: 'a', tasks: { probe: { exec: { command: 'echo "probe=\${VX_DOTENV_PROBE-unset}"', env: { passThrough: ['VX_DOTENV_PROBE'] } } } } }\n`,
  ),
  '.env': 'VX_DOTENV_PROBE=from-dotenv\n',
})
git(dotenv, 'init', '-q')
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (k !== 'VX_DOTENV_PROBE' && v !== undefined) env[k] = v
}
// A run reads only the lock. Full logs: on CI they default to errors-only.
spawn([out, 'lock'], dotenv, env)
const probe = spawn([out, 'run', 'a#probe', '--output-logs=full'], dotenv, env)
rmSync(dotenv, { recursive: true, force: true })
const probed = /^probe=(\S+)$/m.exec(text(probe.stdout) + text(probe.stderr))?.[1]
if (probe.exitCode !== 0 || probed !== 'unset') {
  fail(
    `binary loaded the workspace's .env: its task saw VX_DOTENV_PROBE=${probed} (exit ${probe.exitCode}), expected unset\n${text(probe.stdout)}${text(probe.stderr)}`,
  )
}
console.log(`${path.relative(root, out)} leaves a workspace .env out of its environment`)

// A compiled Bun resolves an on-disk package by its root `index.*` alone
// unless built with --compile-autoload-package-json: `main` and `exports`
// went unread, and a workspace config importing `@vzn/vx-reapi` failed on
// `cannot find '@grpc/grpc-js'` (`main: build/src/index.js`, #1891). A
// config that imports a scoped package whose `main` is nested, and one
// whose `exports` is: the task must print both values.
const resolve = workspace('resolve', {
  ...oneProject(`import { m } from '@fixture/main'
import { e } from '@fixture/exports'
export default { name: 'a', tasks: { probe: { exec: { command: \`echo "resolved=\${m},\${e}"\` } } } }
`),
  'node_modules/@fixture/main/package.json': JSON.stringify({
    name: '@fixture/main',
    main: 'lib/x.js',
  }),
  'node_modules/@fixture/main/lib/x.js': "module.exports = { m: 'via-main' }\n",
  'node_modules/@fixture/exports/package.json': JSON.stringify({
    name: '@fixture/exports',
    type: 'module',
    exports: { '.': './lib/e.js' },
  }),
  'node_modules/@fixture/exports/lib/e.js': "export const e = 'via-exports'\n",
})
git(resolve, 'init', '-q')
// `vx lock` evaluates the config, so it is the import that must resolve.
const resolveLock = spawn([out, 'lock'], resolve)
const resolved = spawn([out, 'run', 'a#probe', '--output-logs=full'], resolve)
rmSync(resolve, { recursive: true, force: true })
const resolvedOut = text(resolveLock.stderr) + text(resolved.stdout) + text(resolved.stderr)
const got2 = /^resolved=(\S+)$/m.exec(resolvedOut)?.[1]
if (resolved.exitCode !== 0 || got2 !== 'via-main,via-exports') {
  fail(
    `binary ignored a package's main or exports: got ${got2} (exit ${resolved.exitCode}), expected via-main,via-exports\n${resolvedOut}`,
  )
}
console.log(`${path.relative(root, out)} resolves a package's main and exports`)

// A workspace written the way the docs show it: bare `@vzn/vx`,
// `@vzn/vx/config` and a plugin package resolved through node_modules
// (symlinks into this repo, as a workspace install makes them). Core has
// no root `index.ts` or `config/index.ts`: the binary answers both
// specifiers from its own copy. The plugin's own `@vzn/vx` import
// is a second copy of core beside the binary's, and its `schedule` hook
// runs across the two. The second run must restore the first run's
// output bytes (the command writes a fresh stamp) through the binary's
// own container reader.
const bare = workspace('bare', {
  'package.json': JSON.stringify({ name: 'ws', private: true }),
  'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
  'packages/a/package.json': JSON.stringify({ name: 'a' }),
  'packages/a/src/x.js': 'x\n',
  'packages/a/vx.config.mjs': `import { defineProject } from '@vzn/vx/config'
export default defineProject({ name: 'a', tasks: { build: { exec: { command: 'echo built-$(date +%s%N) > out.txt' }, inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true } } })
`,
  '.vx/workspace.mjs': `import { defineWorkspace } from '@vzn/vx'
import { vxHistory } from '@vzn/vx-history'
export default defineWorkspace({ plugins: [vxHistory({ assume: { 'a#build': 1000 } })] })
`,
  '.gitignore': 'node_modules\n.vx/cache/\n',
})
mkdirSync(path.join(bare, 'node_modules', '@vzn'), { recursive: true })
symlinkSync(root, path.join(bare, 'node_modules', '@vzn', 'vx'))
symlinkSync(
  path.resolve(root, '..', 'vx-history'),
  path.join(bare, 'node_modules', '@vzn', 'vx-history'),
)
git(bare, 'init', '-q')
spawn([out, 'lock'], bare)
git(bare, 'add', '-A')
git(bare, 'commit', '-qm', 'init')
const build = () => spawn([out, 'run', 'build', '--all'], bare)
const outFile = path.join(bare, 'packages', 'a', 'out.txt')
const first = build()
const built = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : undefined
rmSync(outFile, { force: true })
const second = build()
const restored = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : undefined
rmSync(bare, { recursive: true, force: true })
if (
  first.exitCode !== 0 ||
  second.exitCode !== 0 ||
  built?.startsWith('built-') !== true ||
  restored !== built
) {
  fail(
    `binary on a bare-specifier workspace: exits ${first.exitCode}, ${second.exitCode}; out.txt ${JSON.stringify(restored)}, expected the first run's ${JSON.stringify(built)}\n${text(first.stderr)}${text(second.stderr)}`,
  )
}
console.log(`${path.relative(root, out)} runs a bare-specifier workspace with a plugin package`)
