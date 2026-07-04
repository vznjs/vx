#!/usr/bin/env bun
// Assemble the publishable npm tree for the `vx` CLI from the compiled
// standalone binaries (`dist/vx-<target>`, produced by `vx run build`).
//
// Emits, under <out> (default dist/npm):
//   @vzn/vx-<target>/   — one per platform: the raw binary + os/cpu-gated manifest
//   vx/                 — the primary @vzn/vx package: the library source
//                         (exports ./src/index.ts) PLUS the Node launcher and
//                         the 4 platform packages as optionalDependencies.
//
// npm installs only the platform package matching the user's os/cpu, and the
// launcher execs its binary — so `npm i -g @vzn/vx` gives the `vx` command with
// no Bun and no install-time download. Publishing is done by the workflow
// (`npm publish` in each emitted dir); this script only builds the tree.
//
//   bun scripts/build-npm.ts <version> [--out=dist/npm] [--only=linux-x64]

import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface Target {
  target: string
  os: string
  cpu: string
}

const TARGETS: readonly Target[] = [
  { target: 'linux-x64', os: 'linux', cpu: 'x64' },
  { target: 'linux-arm64', os: 'linux', cpu: 'arm64' },
  { target: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { target: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
]

const ROOT = dirname(import.meta.dir) // scripts/ -> repo root
const REPOSITORY = 'https://github.com/vznjs/vx'

function parseArgs(argv: readonly string[]): { version: string; out: string; only?: string } {
  let version: string | undefined
  let out = 'dist/npm'
  let only: string | undefined
  for (const a of argv) {
    if (a.startsWith('--out=')) out = a.slice('--out='.length)
    else if (a.startsWith('--only=')) only = a.slice('--only='.length)
    else if (!a.startsWith('--')) version = a
  }
  if (version === undefined) {
    throw new Error('usage: bun scripts/build-npm.ts <version> [--out=dir] [--only=target]')
  }
  // Accept a leading `v` (a git tag like v1.2.3) and strip it.
  version = version.replace(/^v/, '')
  return { version, out, ...(only !== undefined ? { only } : {}) }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(value, null, 2) + '\n')
}

async function main(): Promise<void> {
  const { version, out, only } = parseArgs(Bun.argv.slice(2))
  const outDir = join(ROOT, out)
  const targets = only ? TARGETS.filter((t) => t.target === only) : TARGETS
  if (targets.length === 0) throw new Error(`--only=${only}: unknown target`)

  await rm(outDir, { recursive: true, force: true })

  const rootPkg = (await Bun.file(join(ROOT, 'package.json')).json()) as {
    description?: string
    dependencies?: Record<string, string>
  }

  // --- per-platform binary packages ---------------------------------------
  const optionalDependencies: Record<string, string> = {}
  for (const t of targets) {
    const pkgName = `@vzn/vx-${t.target}`
    optionalDependencies[pkgName] = version

    const binSrc = join(ROOT, 'dist', `vx-${t.target}`)
    if (!(await Bun.file(binSrc).exists())) {
      throw new Error(
        `missing binary ${binSrc} — run \`vx run build\` (or build.bun.${t.target}) first`,
      )
    }
    const pkgDir = join(outDir, pkgName)
    await mkdir(pkgDir, { recursive: true })
    const binDst = join(pkgDir, 'vx')
    await cp(binSrc, binDst)
    await chmod(binDst, 0o755)

    await writeJson(join(pkgDir, 'package.json'), {
      name: pkgName,
      version,
      description: `Prebuilt vx binary for ${t.os}-${t.cpu}.`,
      license: 'MIT',
      repository: REPOSITORY,
      os: [t.os],
      cpu: [t.cpu],
      files: ['vx'],
    })
    await Bun.write(
      join(pkgDir, 'README.md'),
      `# ${pkgName}\n\nThe ${t.os}-${t.cpu} prebuilt binary for [\`@vzn/vx\`](${REPOSITORY}).\n\nYou don't install this directly — it's an optionalDependency of \`@vzn/vx\`, which npm installs automatically on a matching platform.\n`,
    )
  }

  // Always list ALL 4 optionalDependencies in the published manifest, even for
  // a --only local build — the registry install resolves the right one, and a
  // partial local build is for launcher testing, not publishing.
  const allOptional: Record<string, string> = {}
  for (const t of TARGETS) allOptional[`@vzn/vx-${t.target}`] = version

  // --- primary @vzn/vx package (library + launcher) -----------------------
  const mainDir = join(outDir, 'vx')
  await mkdir(mainDir, { recursive: true })
  await cp(join(ROOT, 'src'), join(mainDir, 'src'), { recursive: true })
  await cp(join(ROOT, 'scripts', 'npm-launcher.mjs'), join(mainDir, 'launcher.mjs'))
  await cp(join(ROOT, 'README.md'), join(mainDir, 'README.md'))
  await cp(join(ROOT, 'LICENSE'), join(mainDir, 'LICENSE'))

  await writeJson(join(mainDir, 'package.json'), {
    name: '@vzn/vx',
    version,
    description: rootPkg.description ?? 'An open, extensible monorepo task runner.',
    type: 'module',
    // The library surface — plugin authors `import { defineProject } from '@vzn/vx'`.
    exports: { '.': { types: './src/index.ts', import: './src/index.ts' } },
    types: './src/index.ts',
    // The CLI — a Node launcher that execs the matching platform binary.
    bin: { vx: './launcher.mjs' },
    engines: { node: '>=18' },
    // Only the matching platform package installs (os/cpu-gated); the launcher
    // execs its binary. optional = a lib-only consumer can `--no-optional`.
    optionalDependencies: only ? allOptional : optionalDependencies,
    // Runtime deps the library source needs when imported (the binary embeds
    // its own copy). Mirrors the workspace root so versions never drift.
    dependencies: rootPkg.dependencies ?? {},
    files: ['src', 'launcher.mjs', 'README.md', 'LICENSE'],
    repository: REPOSITORY,
    homepage: `${REPOSITORY}#readme`,
    bugs: `${REPOSITORY}/issues`,
    license: 'MIT',
    keywords: ['monorepo', 'task-runner', 'build', 'cache', 'bun', 'turborepo', 'nx'],
  })

  const names = [...targets.map((t) => `@vzn/vx-${t.target}`), '@vzn/vx']
  process.stdout.write(
    `built npm tree at ${out} (version ${version}):\n` +
      names.map((n) => `  ${n}`).join('\n') +
      `\n\nto publish (needs NPM auth):\n` +
      names.map((n) => `  npm publish ${join(out, n)} --access public`).join('\n') +
      '\n',
  )
}

await main()
