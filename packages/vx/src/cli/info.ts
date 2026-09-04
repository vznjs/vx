// `vx info` — workspace doctor printout. One screen of environment +
// workspace + cache facts for bug reports and quick sanity checks.
// `vx stats` is a deprecated alias (info absorbed it).

import { Cache } from '../cache/index.js'
import { seeHelp } from './help.js'
import { VERSION } from '../version.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  loadWorkspaceConfig,
  lockfilePath,
  resolveCacheDir,
} from '../workspace/index.js'
import { formatBytes } from './format.js'

export async function infoCmd(args: readonly string[]): Promise<number> {
  if (args.length > 0) {
    process.stderr.write(`vx info: unknown argument: ${args[0]}${seeHelp('info')}\n`)
    return 1
  }
  const root = await findWorkspaceRoot(process.cwd())
  const metas = await listProjects(await loadWorkspace(root))

  let taskCount = 0
  await Promise.all(
    metas.map(async (meta) => {
      if (meta.configPath === null) return
      // A broken config must not take the doctor down with it — it
      // just contributes zero tasks to the count.
      try {
        const config = await loadProjectConfig(meta.configPath)
        taskCount += Object.keys(config.tasks ?? {}).length
      } catch {
        // counted as zero
      }
    }),
  )

  const cacheDir = resolveCacheDir(root, await loadWorkspaceConfig(root))
  const cache = new Cache(cacheDir)
  let stats
  try {
    stats = cache.stats()
  } finally {
    cache.close()
  }

  const lockPresent = await Bun.file(lockfilePath(root)).exists()

  const rows: [string, string][] = [
    ['vx', VERSION],
    ['bun', Bun.version],
    ['git', gitVersion()],
    // The one `git status` walk per run is the warm path's critical path on
    // a large tree (~55 ms at 1000 projects, measured 2026-09-02). git's
    // own caches make it near-free after the first run, and they are OFF by
    // default — say so, since nothing else in a run would.
    ['git status cache', gitStatusCache(root)],
    ['workspace root', root],
    ['projects', `${metas.length} (${taskCount} task${taskCount === 1 ? '' : 's'})`],
    ['cache dir', cacheDir],
    ['cache entries', `${stats.entryCount} (${formatBytes(stats.totalBytes)})`],
    ['runs (24h)', `${stats.runCountLast24h} (${stats.hitCountLast24h} cache hits)`],
    ['vx-lock.json', lockPresent ? 'yes' : 'no'],
  ]
  const labelW = Math.max(...rows.map(([label]) => label.length))
  const lines = rows.map(([label, value]) => `${`${label}:`.padEnd(labelW + 1)} ${value}`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

/** Whether git's fsmonitor / untracked cache are on, with the remedy when not. */
function gitStatusCache(root: string): string {
  try {
    const p = Bun.spawnSync({
      cmd: ['git', 'config', '--get-regexp', '^core\\.(fsmonitor|untrackedcache)$'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = p.exitCode === 0 ? new TextDecoder().decode(p.stdout) : ''
    const on = (key: string): boolean =>
      new RegExp(`^core\\.${key} (true|1|yes|on)$`, 'im').test(out)
    const fsmonitor = on('fsmonitor')
    const untracked = on('untrackedcache')
    if (fsmonitor && untracked) return 'fsmonitor + untrackedCache on'
    const missing = [
      ...(fsmonitor ? [] : ['core.fsmonitor']),
      ...(untracked ? [] : ['core.untrackedCache']),
    ]
    return `${missing.join(', ')} off — \`git config ${missing[0]} true\` makes every run's status walk near-free on a large tree`
  } catch {
    return '(unknown)'
  }
}

function gitVersion(): string {
  try {
    const p = Bun.spawnSync({ cmd: ['git', '--version'], stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) return '(not found)'
    return new TextDecoder()
      .decode(p.stdout)
      .trim()
      .replace(/^git version /, '')
  } catch {
    return '(not found)'
  }
}
