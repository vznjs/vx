// `Bun.file(p).exists()` answers FALSE for a directory (measured on 1.3.11
// and 1.4.2), which made a literal input naming a gitignored directory fold
// nothing in silence (items 565 → 576). Every remaining site in `src/` hands
// it a FILE path, and this row holds that set: a site added for a path that
// may be a directory fails here and is read before it is allowed — the
// remedy is lstat (`existsOnDisk` / `isInputOnDisk` in cache/inputs.ts).
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(import.meta.dir, '..', 'src')

// Each entry names the path the site probes; all are files by construction.
const FILE_PATH_SITES: Record<string, number> = {
  'cache/cache.ts': 1, // the artifact file before restore
  'cli/init.ts': 3, // turbo.json, nx.json, the Nx project-graph json
  'orchestrator/doctor.ts': 1, // the lockfile
  'orchestrator/task-hash.ts': 1, // a file to hash
  'workspace/affected.ts': 1, // a file to read bytes from
  'workspace/fingerprint.ts': 1, // a workspace fingerprint file
  'workspace/lockfile.ts': 1, // the lockfile
  'workspace/migration.ts': 2, // workspace config candidates; write targets
  'workspace/project-loader.ts': 1, // a config file candidate
  'workspace/workspace.ts': 2, // pnpm-workspace.yaml, package.json
}

describe('Bun.file(...).exists() in src/ probes file paths only', () => {
  it('the set of sites is the known one, each counted', () => {
    const found: Record<string, number> = {}
    const glob = new Bun.Glob('**/*.ts')
    for (const rel of glob.scanSync({ cwd: SRC })) {
      // Code only: the docblocks in cache/inputs.ts name the call by way of
      // explaining why it is NOT used there.
      const code = readFileSync(path.join(SRC, rel), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
      const n = (code.match(/\.exists\(\)/g) ?? []).length
      if (n > 0) found[rel.split(path.sep).join('/')] = n
    }
    expect(found).toEqual(FILE_PATH_SITES)
  })
})
