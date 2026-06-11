// Synthetic-workspace generator for the numbers in docs/benchmarks.md.
//
//   bun bench/generate.ts <dir> [projects=100]
//
// Shape matches the benchmark doc: N projects, each with
//   build   — leaf; writes dist/out.js from src/index.js
//   test    — depends on the project's own build
//   install — group task depending on ^build
// Projects chain dependencies in a 10-wide band (project i depends on
// up to 3 of the previous 10) so the graph has real fan-in without
// being a pathological chain.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const dir = process.argv[2]
const count = Number(process.argv[3] ?? 100)
if (!dir || !Number.isInteger(count) || count < 1) {
  console.error('usage: bun bench/generate.ts <dir> [projects=100]')
  process.exit(1)
}
const root = path.resolve(dir)

await mkdir(path.join(root, 'packages'), { recursive: true })
await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
await writeFile(
  path.join(root, 'package.json'),
  JSON.stringify({ name: 'bench-root', private: true }, null, 2),
)

for (let i = 0; i < count; i++) {
  const name = `pkg-${String(i).padStart(3, '0')}`
  const deps: Record<string, string> = {}
  // Up to 3 deps drawn from the previous 10 projects, deterministic.
  for (let k = 1; k <= 3; k++) {
    const j = i - k * 3
    if (j >= 0) deps[`pkg-${String(j).padStart(3, '0')}`] = 'workspace:*'
  }
  const pdir = path.join(root, 'packages', name)
  await mkdir(path.join(pdir, 'src'), { recursive: true })
  await writeFile(
    path.join(pdir, 'package.json'),
    JSON.stringify(
      { name, version: '0.0.0', ...(Object.keys(deps).length ? { dependencies: deps } : {}) },
      null,
      2,
    ),
  )
  await writeFile(path.join(pdir, 'src', 'index.js'), `export const v = ${i}\n`)
  await writeFile(
    path.join(pdir, 'vx.config.mjs'),
    `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cp src/index.js dist/out.js' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'node -e "process.exit(0)"' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
    install: { dependsOn: ['^build'] },
  },
}
`,
  )
}

// vx requires git for input enumeration.
const git = (...args: string[]) => {
  const p = Bun.spawnSync({ cmd: ['git', ...args], cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
}
git('init', '-q')
git('add', '-A')
git(
  '-c',
  'user.email=bench@vx',
  '-c',
  'user.name=bench',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-qm',
  'fixture',
)

console.log(`generated ${count} projects in ${root}`)
