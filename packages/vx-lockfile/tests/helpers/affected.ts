import path from 'node:path'

const CORE_BIN = path.resolve(import.meta.dir, '..', '..', '..', 'vx', 'src', 'bin.ts')

/** The task ids whose key moved between two plans of the same tasks, sorted. */
export function moved(before: Record<string, string>, after: Record<string, string>): string[] {
  if (Object.keys(after).sort().join() !== Object.keys(before).sort().join()) {
    throw new Error('the two plans hold different tasks')
  }
  return Object.keys(after)
    .filter((id) => after[id] !== before[id])
    .sort()
}

/** Commit everything in the fixture, so `--affected=HEAD` diffs the working tree against it. */
export function commitAll(root: string): void {
  const git = (...args: string[]) =>
    Bun.spawnSync({
      cmd: [
        'git',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.email=t@vx',
        '-c',
        'user.name=t',
        ...args,
      ],
      cwd: root,
    })
  git('add', '.')
  git('commit', '-q', '-m', 'init')
}

/**
 * `vx run <task> --affected=HEAD --dry=json` through the real CLI: the ids
 * of the tasks the run selected, sorted. An empty selection prints no plan,
 * only its "nothing affected" line.
 */
export function affectedIds(root: string, task: string): string[] {
  const r = Bun.spawnSync({
    cmd: [process.execPath, CORE_BIN, 'run', task, '--affected=HEAD', '--dry=json'],
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  const stdout = new TextDecoder().decode(r.stdout)
  const all = stdout + new TextDecoder().decode(r.stderr)
  if (r.exitCode !== 0) throw new Error(`vx run --affected exited ${r.exitCode}:\n${all}`)
  if (all.includes('nothing affected')) return []
  const plan = JSON.parse(stdout) as { tasks: Array<{ id: string }> }
  return plan.tasks.map((t) => t.id).sort()
}
