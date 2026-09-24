// The compiled binary, as a user meets it: compile THIS host's target the
// way release.yml does, make it launchable (Bun 1.4.0's `--compile`
// signature is rejected by macOS until re-signed ad hoc — the release
// workflow does the same), and assert `--version` reports the version
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    '--minify',
    '--bytecode',
    `--target=bun-${host}`,
    'src/bin.ts',
    '--outfile',
    out,
  ],
  'compile',
)
if (process.platform === 'darwin') run(['codesign', '-s', '-', '--force', out], 'codesign')

const want = `vx ${((await Bun.file(path.join(root, 'package.json')).json()) as { version: string }).version}`
const got = Bun.spawnSync({ cmd: [out, '--version'], stdout: 'pipe', stderr: 'pipe' })
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
