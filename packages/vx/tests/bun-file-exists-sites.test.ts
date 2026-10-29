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
  'cli/init.ts': 1, // a starter file already there
  'cli/lock.ts': 1, // a vx.lock.json left beside no config
  'cli/plugin-templates.ts': 3, // the cache example's has() and get(): artifact file paths; a test's ran.txt
  'handoff.ts': 6, // a package.json, .git/HEAD (twice), a worktree's .git file, its commondir, a .vx/workspace.*
  'orchestrator/doctor.ts': 1, // the lockfile
  'orchestrator/projects.ts': 1, // a locked config a run reads is still there (X-144)
  'workspace/affected.ts': 2, // a file to read bytes from; a removed project's config
  'workspace/load-reads.ts': 1, // a root file: manifest, fingerprint file, workspace config
  'workspace/lockfile.ts': 1, // the lockfile
  'workspace/migration.ts': 3, // workspace config candidates; write targets; .vx/.gitignore
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
