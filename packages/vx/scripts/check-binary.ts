// The compiled binary, as a user meets it: compile THIS host's target the
// way release.yml does, make it launchable (Bun 1.4.0's `--compile`
// signature is rejected by macOS until re-signed ad hoc — the release
// workflow does the same; below, only when the launch fails), and assert `--version` reports the version
// package.json carries, which src/version.ts inlines and the release
// workflows stamp. A layout move broke that stamp unseen for a week once
// (2026-08-26 → 09-03); this runs in every `vx run ci`.
//
// One host binary, not four cross targets: what a dependant needs from
// core is its SOURCE, so `build` is not a task core has — the four
// release targets are `build.bun.*`, and the gate proves the one it can
// run. The output lives beside them under dist/.
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

const root = path.resolve(import.meta.dir, '..')
const host = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const out = path.join(root, 'dist', `vx-${host}`)

const text = (b: Uint8Array): string => new TextDecoder().decode(b)
const run = (cmd: string[], label: string): void => {
  const r = Bun.spawnSync({ cmd, cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) {
    process.stderr.write(
      `${label} failed (exit ${r.exitCode}):\n${text(r.stdout)}${text(r.stderr)}`,
    )
    process.exit(1)
  }
}

run(
  [
    'bun',
    'build',
    '--compile',
    '--no-compile-autoload-dotenv',
    '--compile-autoload-package-json',
    '--minify',
    '--bytecode',
    `--target=bun-${host}`,
    'src/bin.ts',
    '--outfile',
    out,
  ],
  'compile',
)

const want = `vx ${((await Bun.file(path.join(root, 'package.json')).json()) as { version: string }).version}`
const launch = () => Bun.spawnSync({ cmd: [out, '--version'], stdout: 'pipe', stderr: 'pipe' })
let got = launch()
// Re-sign only a binary macOS refused: Bun 1.4.2's output is already
// ad-hoc signed and launches, and `codesign` inside the sandbox is a
// `system-fsctl` violation no grant can lift (macOS 27, 2026-10-03).
if (got.exitCode !== 0 && process.platform === 'darwin') {
  run(['codesign', '-s', '-', '--force', out], 'codesign')
  got = launch()
}
const version = text(got.stdout).trim()
if (got.exitCode !== 0 || version !== want) {
  process.stderr.write(
    `binary reports ${JSON.stringify(version)} (exit ${got.exitCode}), expected ${JSON.stringify(want)}\n${text(got.stderr)}`,
  )
  process.exit(1)
}
console.log(`${path.relative(root, out)} reports ${version}`)

// Outside the repo: under dist/, discovery would find this repo's own
// workspace above it.
const ws = mkdtempSync(path.join(os.tmpdir(), 'vx-check-binary-'))
mkdirSync(path.join(ws, 'packages', 'a'), { recursive: true })
writeFileSync(
  path.join(ws, 'package.json'),
  JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
)
writeFileSync(path.join(ws, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
writeFileSync(
  path.join(ws, 'packages', 'a', 'vx.config.mjs'),
  `export default {
  tasks: { build: { exec: { command: 'true' }, description: () => 'x' } },
}
`,
)
const info = Bun.spawnSync({
  cmd: [out, 'info', '--format=json'],
  cwd: ws,
  stdout: 'pipe',
  stderr: 'pipe',
})
const errors = JSON.stringify(
  info.exitCode === 0
    ? (JSON.parse(text(info.stdout)) as { configErrors: unknown }).configErrors
    : text(info.stderr),
)
const wantErrors = JSON.stringify([
  {
    path: 'packages/a/vx.config.mjs',
    message:
      'tasks.build.description is a function — a config must be JSON data, because the cache key folds its JSON',
  },
])
rmSync(ws, { recursive: true, force: true })
if (errors !== wantErrors) {
  process.stderr.write(
    `binary's config worker: \`vx info\` reports ${errors} (exit ${info.exitCode}), expected ${wantErrors}\n`,
  )
  process.exit(1)
}
console.log(`${path.relative(root, out)} refuses a non-JSON config in its config worker`)

// A compiled Bun binary loads `.env`, `.env.local` and `.env.<NODE_ENV>`
// from its working directory into its own environment unless it was built
// with --no-compile-autoload-dotenv, and a task's passThrough then saw a
// value no shell had set (item 1089). A workspace with a `.env` that sets
// the name a task passes through: the task must see it unset.
const dotenv = mkdtempSync(path.join(os.tmpdir(), 'vx-check-dotenv-'))
mkdirSync(path.join(dotenv, 'packages', 'a'), { recursive: true })
writeFileSync(
  path.join(dotenv, 'package.json'),
  JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
)
writeFileSync(path.join(dotenv, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
writeFileSync(
  path.join(dotenv, 'packages', 'a', 'vx.config.mjs'),
  `export default { tasks: { probe: { exec: { command: 'echo "probe=\${VX_DOTENV_PROBE-unset}"', env: { passThrough: ['VX_DOTENV_PROBE'] } } } } }\n`,
)
writeFileSync(path.join(dotenv, '.env'), 'VX_DOTENV_PROBE=from-dotenv\n')
Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: dotenv })
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (k !== 'VX_DOTENV_PROBE' && v !== undefined) env[k] = v
}
const probe = Bun.spawnSync({
  cmd: [out, 'run', 'a#probe'],
  cwd: dotenv,
  env,
  stdout: 'pipe',
  stderr: 'pipe',
})
rmSync(dotenv, { recursive: true, force: true })
const probed = /^probe=(\S+)$/m.exec(text(probe.stdout) + text(probe.stderr))?.[1]
if (probe.exitCode !== 0 || probed !== 'unset') {
  process.stderr.write(
    `binary loaded the workspace's .env: its task saw VX_DOTENV_PROBE=${probed} (exit ${probe.exitCode}), expected unset\n${text(probe.stdout)}${text(probe.stderr)}`,
  )
  process.exit(1)
}
console.log(`${path.relative(root, out)} leaves a workspace .env out of its environment`)

// A compiled Bun resolves an on-disk package by its root `index.*` alone
// unless built with --compile-autoload-package-json: `main` and `exports`
// went unread, and a workspace config importing `@vzn/vx-reapi` failed on
// `cannot find '@grpc/grpc-js'` (`main: build/src/index.js`, #1891). A
// config that imports a scoped package whose `main` is nested, and one
// whose `exports` is: the task must print both values.
const resolve = mkdtempSync(path.join(os.tmpdir(), 'vx-check-resolve-'))
const pkgDir = (name: string): string => path.join(resolve, 'node_modules', '@fixture', name)
mkdirSync(path.join(pkgDir('main'), 'lib'), { recursive: true })
mkdirSync(path.join(pkgDir('exports'), 'lib'), { recursive: true })
mkdirSync(path.join(resolve, 'packages', 'a'), { recursive: true })
writeFileSync(
  path.join(pkgDir('main'), 'package.json'),
  JSON.stringify({ name: '@fixture/main', main: 'lib/x.js' }),
)
writeFileSync(path.join(pkgDir('main'), 'lib', 'x.js'), "module.exports = { m: 'via-main' }\n")
writeFileSync(
  path.join(pkgDir('exports'), 'package.json'),
  JSON.stringify({ name: '@fixture/exports', type: 'module', exports: { '.': './lib/e.js' } }),
)
writeFileSync(path.join(pkgDir('exports'), 'lib', 'e.js'), "export const e = 'via-exports'\n")
writeFileSync(
  path.join(resolve, 'package.json'),
  JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
)
writeFileSync(path.join(resolve, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
writeFileSync(
  path.join(resolve, 'packages', 'a', 'vx.config.mjs'),
  `import { m } from '@fixture/main'
import { e } from '@fixture/exports'
export default { tasks: { probe: { exec: { command: \`echo "resolved=\${m},\${e}"\` } } } }
`,
)
Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: resolve })
const resolved = Bun.spawnSync({
  cmd: [out, 'run', 'a#probe'],
  cwd: resolve,
  stdout: 'pipe',
  stderr: 'pipe',
})
rmSync(resolve, { recursive: true, force: true })
const resolvedOut = text(resolved.stdout) + text(resolved.stderr)
const got2 = /^resolved=(\S+)$/m.exec(resolvedOut)?.[1]
if (resolved.exitCode !== 0 || got2 !== 'via-main,via-exports') {
  process.stderr.write(
    `binary ignored a package's main or exports: got ${got2} (exit ${resolved.exitCode}), expected via-main,via-exports\n${resolvedOut}`,
  )
  process.exit(1)
}
console.log(`${path.relative(root, out)} resolves a package's main and exports`)

// A workspace written the way the docs show it: bare `@vzn/vx` and a
// plugin package resolved through node_modules (symlinks into this repo,
// as a workspace install makes them). The plugin's own `@vzn/vx` import
// is a second copy of core beside the binary's, and its `schedule` hook
// runs across the two. The second run must restore the first run's
// output bytes (the command writes a fresh stamp) through the binary's
// own container reader.
const bare = mkdtempSync(path.join(os.tmpdir(), 'vx-check-bare-'))
mkdirSync(path.join(bare, 'packages', 'a', 'src'), { recursive: true })
mkdirSync(path.join(bare, 'node_modules', '@vzn'), { recursive: true })
symlinkSync(root, path.join(bare, 'node_modules', '@vzn', 'vx'))
symlinkSync(
  path.resolve(root, '..', 'vx-schedule-history'),
  path.join(bare, 'node_modules', '@vzn', 'vx-schedule-history'),
)
writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
writeFileSync(path.join(bare, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
writeFileSync(path.join(bare, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
writeFileSync(path.join(bare, 'packages', 'a', 'src', 'x.js'), 'x\n')
writeFileSync(
  path.join(bare, 'packages', 'a', 'vx.config.mjs'),
  `import { defineProject } from '@vzn/vx'
export default defineProject({ tasks: { build: { exec: { command: 'echo built-$(date +%s%N) > out.txt' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } } } } })
`,
)
writeFileSync(
  path.join(bare, 'vx.workspace.mjs'),
  `import { defineWorkspace } from '@vzn/vx'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'
export default defineWorkspace({ plugins: [scheduleHistoryPlugin({ assume: { 'a#build': 1000 } })] })
`,
)
writeFileSync(path.join(bare, '.gitignore'), 'node_modules\n.vx\n')
const git = (...args: string[]): void => {
  Bun.spawnSync({
    cmd: ['git', '-c', 'user.email=ci@vx', '-c', 'user.name=ci', ...args],
    cwd: bare,
  })
}
git('init', '-q')
git('add', '-A')
git('commit', '-qm', 'init')
const build = () =>
  Bun.spawnSync({ cmd: [out, 'run', 'build', '--all'], cwd: bare, stdout: 'pipe', stderr: 'pipe' })
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
  process.stderr.write(
    `binary on a bare-specifier workspace: exits ${first.exitCode}, ${second.exitCode}; out.txt ${JSON.stringify(restored)}, expected the first run's ${JSON.stringify(built)}\n${text(first.stderr)}${text(second.stderr)}`,
  )
  process.exit(1)
}
console.log(`${path.relative(root, out)} runs a bare-specifier workspace with a plugin package`)
