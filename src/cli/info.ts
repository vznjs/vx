// `vx info` — workspace doctor printout. One screen of environment +
// workspace + cache facts for bug reports and quick sanity checks.
// `vx stats` is a deprecated alias (info absorbed it).

import { Cache } from '../cache/index.js'
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
    process.stderr.write(`vx info: unknown argument: ${args[0]}\n`)
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
