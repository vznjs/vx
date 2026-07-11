// Seed not-yet-existing @vzn npm package names with a tiny placeholder
// version. npm Trusted Publishing (the token-less OIDC path npm.yml uses)
// can only be configured for names that ALREADY exist on the registry, so a
// brand-new platform package 403s the CI publish until someone publishes a
// first version by hand — this script is that hand.
//
//   bun scripts/seed-npm-dummies.ts             # dry run: shows what would seed
//   bun scripts/seed-npm-dummies.ts --publish   # actually publish (needs `npm login`)
//
// Idempotent: names that already exist on the registry are skipped, so the
// worst a re-run does is nothing. The dummy is version 0.0.1 with no code —
// the real packages publish at the repo version (0.0.15+), which supersedes
// `latest`, and the main packages pin their platform optionalDependencies to
// an EXACT version, so a dummy can never be selected by an install.
//
// After seeding, on npmjs.com configure a Trusted Publisher for each seeded
// name (repo vznjs/vx, workflow .github/workflows/npm.yml), then re-run the
// npm workflow (workflow_dispatch) — the idempotent publish loop completes
// the set.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

interface Target {
  target: string
  os: string
  cpu: string
}

// Mirrors scripts/build-npm.ts TARGETS — the full published family is the
// two main packages plus one platform package per target per family.
const TARGETS: readonly Target[] = [
  { target: 'linux-x64', os: 'linux', cpu: 'x64' },
  { target: 'linux-arm64', os: 'linux', cpu: 'arm64' },
  { target: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { target: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
]

interface SeedName {
  name: string
  os?: string
  cpu?: string
}

const FAMILY: SeedName[] = [
  { name: '@vzn/vx' },
  ...TARGETS.map((t) => ({ name: `@vzn/vx-${t.target}`, os: t.os, cpu: t.cpu })),
  { name: '@vzn/vx-cloud' },
  ...TARGETS.map((t) => ({ name: `@vzn/vx-cloud-${t.target}`, os: t.os, cpu: t.cpu })),
]

const SEED_VERSION = '0.0.1'

async function existsOnRegistry(name: string): Promise<boolean> {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`)
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`registry check for ${name} → HTTP ${res.status}`)
  return true
}

async function writeDummy(dir: string, seed: SeedName): Promise<void> {
  await mkdir(dir, { recursive: true })
  const pkg: Record<string, unknown> = {
    name: seed.name,
    version: SEED_VERSION,
    description:
      'Placeholder release seeding this name for npm Trusted Publishing — real binaries publish from CI. Do not depend on this version.',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/vznjs/vx.git' },
    publishConfig: { access: 'public' },
    ...(seed.os !== undefined ? { os: [seed.os] } : {}),
    ...(seed.cpu !== undefined ? { cpu: [seed.cpu] } : {}),
  }
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  await writeFile(
    path.join(dir, 'README.md'),
    `# ${seed.name}\n\nPlaceholder ${SEED_VERSION} that seeds this package name so npm Trusted\nPublishing can be configured for it. The real package publishes from\n[vznjs/vx](https://github.com/vznjs/vx) CI — never depend on ${SEED_VERSION}.\n`,
  )
}

async function npm(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn({ cmd: ['npm', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, out: `${out}${err}`.trim() }
}

const publish = process.argv.includes('--publish')

const missing: SeedName[] = []
for (const seed of FAMILY) {
  if (await existsOnRegistry(seed.name)) {
    console.log(`skip     ${seed.name} (already on the registry)`)
  } else {
    missing.push(seed)
  }
}

if (missing.length === 0) {
  console.log('\nnothing to seed — every family name exists on the registry.')
  process.exit(0)
}

if (publish) {
  const who = await npm(['whoami'], process.cwd())
  if (who.code !== 0) {
    console.error(`\nnpm whoami failed — run \`npm login\` first.\n${who.out}`)
    process.exit(1)
  }
  console.log(`\npublishing as: ${who.out}`)
}

const stage = await mkdtemp(path.join(tmpdir(), 'vx-seed-'))
try {
  let failed = 0
  for (const seed of missing) {
    const dir = path.join(stage, seed.name.replace('@vzn/', ''))
    await writeDummy(dir, seed)
    const args = ['publish', '--access', 'public', ...(publish ? [] : ['--dry-run'])]
    const res = await npm(args, dir)
    const mode = publish ? 'seeded' : 'would seed'
    if (res.code === 0) {
      console.log(`${mode}   ${seed.name}@${SEED_VERSION}`)
    } else {
      failed++
      console.error(`FAILED   ${seed.name}: ${res.out.split('\n').slice(-5).join('\n')}`)
    }
  }
  if (failed > 0) process.exit(1)
} finally {
  await rm(stage, { recursive: true, force: true })
}

console.log(
  publish
    ? `\nDone. Next: on npmjs.com add a Trusted Publisher for each seeded name\n(repo vznjs/vx, workflow .github/workflows/npm.yml), then re-run the npm\nworkflow — its idempotent loop publishes the real versions.`
    : `\nDry run only. Re-run with --publish after \`npm login\` to seed for real.`,
)
