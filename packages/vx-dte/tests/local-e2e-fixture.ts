// The workspace a distributed run on `local()` is tested in, end to end:
// the workers are processes in their own git worktrees, joined through the
// adapter's loopback relay. Its tests are split over two files, each a
// task of its own, so neither is the run's longest.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect } from 'bun:test'

export const DTE = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
export const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
export const CORE_INDEX = path.resolve(import.meta.dir, '../../vx/src/index.ts')
// Relative, as this package's test task sets it: each worker's worktree
// must still share the run's store.
process.env['VX_CACHE_DIR'] = '.vx/cache'
export let root = ''

/** A fresh workspace of every fixture project, committed and locked: `root`. */
export async function setup(): Promise<void> {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-e2e-'))
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws', private: true }),
    '.gitignore': 'out\n.vx/cache\n',
    '.vx/workspace.mjs': `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { max: 2, cpu: 1, memory: '1GB' } }, adapter: local() })] }
`,
    'a/vx.config.mjs': `export default { name: 'a', tasks: { gen: {
  exec: { command: 'mkdir -p out && echo made > out/a.txt' },
  inputs: { files: ['vx.config.mjs'] },
  cache: { outputs: { files: ['out/**'] } },
}, ro: {
  exec: { command: 'mkdir -p out && echo far > out/ro.txt', remote: 'only' },
  inputs: { files: ['vx.config.mjs'] },
  cache: { outputs: { files: ['out/ro.txt'] } },
} } }
`,
    // The marker lives outside every worktree, so the worker that runs the
    // task again sees the first one started it: in its own worktree it
    // slept the 60 s out (80 s of this file's 111 s).
    'b/vx.config.mjs': `const once = ${JSON.stringify(path.join(root, 'once'))}
export default { name: 'b', tasks: {
  use: {
    dependsOn: ['a#gen'],
    exec: { command: 'mkdir -p out && cat ../a/out/a.txt > out/b.txt && pwd > out/where.txt && echo used' },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['out/**'] } },
  },
  fail: { exec: { command: 'echo oops >&2; exit 3' } },
  trap: {
    exec: { command: "trap 'exit 0' TERM; echo > t.txt; sleep 10 & wait", timeout: '1s' },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['t.txt'] } },
  },
  far: { dependsOn: ['a#ro'], exec: { command: 'cat ../a/out/ro.txt' } },
  away: {
    exec: { command: 'rm -f away && ln -s / away' },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['away/**'] } },
  },
  bg: {
    exec: { command: 'echo a > bg.txt && (sleep 1; echo late > late.txt) &' },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['bg.txt', 'late.txt'] } },
  },
  timed: { exec: { command: 'sleep 0.5 && echo timed-ok', timeout: '2s' } },
  halt: {
    exec: {
      command: "trap 'exit 0' TERM; echo > h.txt; if [ x$VX_E2E_HALT = x1 ]; then touch halt.started; sleep 30 & wait; fi",
      env: { passThrough: ['VX_E2E_HALT'] },
    },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['h.txt'] } },
  },
  slow: { exec: { command: 'touch started && sleep 60' } },
  once: { exec: { command: 'if [ -e ' + once + ' ]; then echo again; else touch ' + once + ' && sleep 60; fi' } },
  env: { exec: {
    command: 'echo "shown=\${VX_E2E_SHOWN:-none} hidden=\${VX_E2E_HIDDEN:-none}"',
    env: { passThrough: ['VX_E2E_SHOWN'] },
  } },
  pat: {
    exec: { command: 'echo "auth=$VX_E2E_PAT"', env: { passThrough: ['VX_E2E_PAT'], secret: ['VX_E2E_PAT'] } },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: [] } },
  },
} }
`,
    // A server its tests need where they run: each start says where.
    's/vx.config.mjs': `const log = ${JSON.stringify(path.join(root, 'servers.log'))}
const t = (n) => ({ dependsOn: ['srv'], exec: { command: 'test -e up && echo saw' + n } })
// Two shards long enough to run at once, so on two machines.
const shard = (n) => ({ dependsOn: ['srv'], exec: { command: 'test -e up && sleep 3 && echo shard' + n } })
export default { name: 's', tasks: {
  srv: { exec: { command: 'echo "$PWD" >> ' + log + ' && touch up && echo up && exec sleep 60', persistent: { readyWhen: 'up' } } },
  t1: t(1), t2: t(2), t3: t(3), shard1: shard(1), shard2: shard(2),
} }
`,
    // Keys that fold a runtime probe: one every machine answers alike, one
    // naming a path under the checkout root, and one the worker's worktree
    // answers otherwise.
    'r/vx.config.mjs': `const log = ${JSON.stringify(path.join(root, 'probed.log'))}
const t = (probe) => ({
  exec: { command: 'echo "$PWD" >> ' + log },
  inputs: { files: ['vx.config.mjs'], runtime: [probe] },
  cache: { outputs: { files: [] } },
})
export default { name: 'r', tasks: { same: t('echo 1.4.2'), root: t('pwd'), here: t('git rev-parse --git-dir') } }
`,
    // Tasks core pins to the machine that runs \`vx run\`, each saying where it ran.
    'p/vx.config.mjs': `const log = ${JSON.stringify(path.join(root, 'pinned.log'))}
const at = (name) => 'echo "' + name + ' $PWD" >> ' + log
export default { name: 'p', tasks: {
  here: { exec: { command: at('here'), remote: false } },
  above: { dependsOn: ['here'], exec: { command: at('above') } },
  tty: { exec: { command: at('tty'), interactive: true } },
  srv: { exec: { command: at('srv') + ' && touch up && echo up && exec sleep 60', remote: false, persistent: { readyWhen: 'up' } } },
  near: { dependsOn: ['srv'], exec: { command: at('near') } },
} }
`,
    // A committed file under a task's output glob: never its output.
    'g/gen/keep.txt': 'tracked\n',
    'g/vx.config.mjs': `export default { name: 'g', tasks: {
  gen: { exec: { command: 'echo made > gen/out.txt' }, inputs: { files: ['vx.config.mjs'] }, cache: { outputs: { files: ['gen/**'] } } },
  use: { dependsOn: ['gen'], exec: { command: 'cat gen/keep.txt gen/out.txt' } },
} }
`,
    // A task that rewrites its own input, as a formatter does.
    'f/in.txt': '1\n',
    'f/vx.config.mjs': `export default { name: 'f', tasks: {
  fmt: { exec: { command: 'echo x >> in.txt && mkdir -p out && cp in.txt out/f.txt' }, inputs: { files: ['in.txt'] }, cache: { outputs: { files: ['out/**'] } } },
} }
`,
    // Two uncached generators, long enough to run on two workers, and a
    // task reading both: no cache carries their files (#4407).
    'k/vx.config.mjs': `const gen = (n) => ({ exec: { command: 'sleep 1 && echo ' + n + ' > ' + n + '.txt' } })
export default { name: 'k', tasks: {
  one: gen('one'), two: gen('two'),
  both: { dependsOn: ['one', 'two'], exec: { command: 'cat one.txt two.txt' } },
} }
`,
    // Tasks big enough that their peak memory is measured, one after another.
    'm/vx.config.mjs': `const t = (dependsOn) => ({ dependsOn, exec: { command: ${JSON.stringify(
      `${process.execPath} -e "const b = Buffer.alloc(64 * 2 ** 20, 1); await Bun.sleep(300); console.log(b[0])"`,
    )} } })
export default { name: 'm', tasks: { m1: t([]), m2: t([]), m3: t(['m1', 'm2']) } }
`,
    // Wide, then a two-task lull, then wide again.
    'c/vx.config.mjs': `const t = (dependsOn) => ({ exec: { command: 'sleep 0.3' }, dependsOn })
export default { name: 'c', tasks: {
  x1: t([]), x2: t([]), y1: t(['x1', 'x2']), y2: t(['y1']), z1: t(['y2']), z2: t(['y2']),
} }
`,
  }
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
  git('init', '-q')
  expect(vx(['lock']).exitCode).toBe(0)
  git('add', '-A')
  git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'i')
}

export async function teardown(): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

/** `vx`, a distributed run when `run` names one; its id is a fresh UUID. */
export function vx(args: string[], run?: string, extra: Record<string, string> = {}) {
  const { VX_DTE_RUN: _, ...env } = process.env
  return Bun.spawnSync([process.execPath, CORE_BIN, ...args], {
    cwd: root,
    env: {
      ...env,
      ...(run === undefined ? {} : { VX_DTE_RUN: crypto.randomUUID() }),
      NO_COLOR: '1',
      ...extra,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

/**
 * A worker started as CI starts one, after its run's orchestrator: one
 * that finds no live run yet leaves at once, and is started again.
 */
export async function workerOf(
  start: () => Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  run: Bun.Subprocess,
): Promise<{ exited: number; out: string }> {
  let over = false
  void run.exited.then(() => (over = true))
  for (;;) {
    const w = start()
    const [out, exited] = await Promise.all([new Response(w.stdout).text(), w.exited])
    if (out !== '' || over) return { exited, out }
    await Bun.sleep(100)
  }
}

/**
 * The pids under `pid`, by `pgrep -P`: macOS's `ps` is setuid, which the
 * sandbox will not spawn (EPERM on a developer Mac, 2026-10-21).
 */
export function descendants(pid: number): number[] {
  const kids = (p: number): number[] =>
    Bun.spawnSync(['pgrep', '-P', String(p)])
      .stdout.toString()
      .split('\n')
      .filter(Boolean)
      .map(Number)
  const out: number[] = []
  for (let i = -1; i < out.length; i++) out.push(...kids(i < 0 ? pid : out[i]!))
  return out
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
