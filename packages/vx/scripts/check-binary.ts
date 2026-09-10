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
