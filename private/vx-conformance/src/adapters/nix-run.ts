#!/usr/bin/env bun
// A run as a Nix user makes it: nix-build the requested tasks' derivations
// from the workspace's default.nix, then copy each built task's `$out` (its
// declared outputs, at their workspace paths) back into the tree, as one
// copies out of `result`. argv[2]: JSON { tasks, projects?, args?, concurrency?, dry? }.
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { jsRegExp } from './nix.ts'

interface Info {
  id: string
  drv: string
  out: string
  outRe: string[]
  outEx: string[]
}

const req = JSON.parse(process.argv[2]!) as {
  tasks: string[]
  projects?: string[]
  args?: string[]
  concurrency?: number
  dry?: boolean
}

const SKIP = new Set(['.git', 'node_modules'])
const SKIP_ROOT = new Set(['.home', '.ran', '.left', '.stop-watch'])

let root = process.cwd()
while (!existsSync(path.join(root, 'default.nix'))) {
  if (path.dirname(root) === root) {
    console.error('nix-run: no default.nix above the working directory')
    process.exit(1)
  }
  root = path.dirname(root)
}
const home = process.env['HOME']!
// A store of the case's own, under its home: its store directory is
// writable there, so the builds need no namespace to see it.
const store = `local?store=${home}/nix/store&state=${home}/nix/var&log=${home}/nix/log`
// The harness's marks live in the workspace; a build reads where from here,
// a path no derivation names, so the workspace's place never keys a task.
await mkdir('/tmp/vx-conformance-nix', { recursive: true })
await writeFile('/tmp/vx-conformance-nix/root', root)

const run = JSON.stringify({
  tasks: req.tasks,
  ...(req.projects ? { projects: req.projects } : {}),
  args: req.args ?? [],
  nonce: crypto.randomUUID(),
})
const common = [
  '--store',
  store,
  '--option',
  'build-users-group',
  '',
  '--option',
  'substituters',
  '',
  path.join(root, 'default.nix'),
  '--argstr',
  'run',
  run,
]

const evaluated = Bun.spawnSync(
  ['nix-instantiate', '--eval', '--strict', '--json', '--read-write-mode', ...common, '-A', 'info'],
  { stdout: 'pipe', stderr: 'inherit' },
)
if (evaluated.exitCode !== 0) process.exit(evaluated.exitCode)
const info = JSON.parse(evaluated.stdout.toString()) as Info[]

const build = Bun.spawn(
  [
    'nix-build',
    ...common,
    '-A',
    'selected',
    '--no-out-link',
    ...(req.concurrency !== undefined ? ['--max-jobs', String(req.concurrency)] : []),
    ...(req.dry ? ['--dry-run'] : []),
  ],
  { stdout: 'inherit', stderr: 'pipe' },
)
let log = ''
const decoder = new TextDecoder()
for await (const chunk of build.stderr) {
  process.stderr.write(chunk)
  log += decoder.decode(chunk, { stream: true })
}
const exit = await build.exited

await writeFile(
  path.join(home, 'nix-last.json'),
  JSON.stringify({ drvs: Object.fromEntries(info.map((t) => [t.id, t.drv])), log }),
)

if (!req.dry)
  // Dependencies first, so a dependant's output at the same path is what stays.
  for (const t of info.toReversed()) {
    if (!existsSync(t.out)) continue
    if (t.outRe.length > 0) await clear(t)
    restore(t.out, root)
  }
process.exit(exit)

/** Remove what the task's outputs match in the tree: the restore replaces it. */
async function clear(t: Info): Promise<void> {
  const inc = t.outRe.map(jsRegExp)
  const exc = t.outEx.map(jsRegExp)
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP.has(e.name) || (rel === '' && SKIP_ROOT.has(e.name))) continue
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) await walk(r)
      else if (inc.some((x) => x.test(r)) && !exc.some((x) => x.test(r)))
        await rm(path.join(root, r), { force: true })
    }
  }
  await walk('')
}

/**
 * Copy a store tree into the workspace as `cp -R` does (links as links,
 * through a link to a directory), then make what it copied writable: the
 * store keeps only whether a file is executable.
 */
function restore(from: string, to: string): void {
  Bun.spawnSync(
    [
      'sh',
      '-c',
      'cp -RP --remove-destination "$1/." "$2/" && cd "$1" && find . ! -type l -print0 | (cd "$2" && xargs -0 chmod u+w)',
      'sh',
      from,
      to,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  )
}
