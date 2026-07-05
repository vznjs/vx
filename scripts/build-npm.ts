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
// no Bun and no install-time download.
//
// ALSO emits `@vzn/vx-cloud` — the orchestrator service + the first-party
// `cloud()` plugin. Unlike `vx` it's a Bun-source package (its bin is a
// Bun-shebang `.ts`, and it embeds the dashboard via a relative import), so it
// requires Bun on the consumer (CI already provides it via setup-bun) and
// depends on `@vzn/vx` at the same version for the bare `import '@vzn/vx'`.
//
// Publishing is done by the workflow (`npm publish` in each emitted dir); this
// script only builds the tree.
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

  await buildCloudPackage(version, outDir)

  const names = [...targets.map((t) => `@vzn/vx-${t.target}`), '@vzn/vx', '@vzn/vx-cloud']
  process.stdout.write(
    `built npm tree at ${out} (version ${version}):\n` +
      names.map((n) => `  ${n}`).join('\n') +
      `\n\nto publish (needs NPM auth):\n` +
      names.map((n) => `  npm publish ${join(out, dirFor(n))} --access public`).join('\n') +
      '\n',
  )
}

/** The emitted directory basename for a package name (the main pkgs drop the scope). */
function dirFor(name: string): string {
  if (name === '@vzn/vx') return 'vx'
  if (name === '@vzn/vx-cloud') return 'vx-cloud'
  return name
}

/**
 * Emit the `@vzn/vx-cloud` package: a Bun-source package (its bin is the
 * Bun-shebang `src/cli/bin.ts`, and `ui-asset.ts` embeds the dashboard via a
 * relative `../../ui/dist/index.html` import, so `src` + `ui/dist` ship
 * together). It depends on `@vzn/vx` at the SAME version so the plugin + CLI's
 * bare `import '@vzn/vx'` resolves without the dev workspace symlink.
 */
async function buildCloudPackage(version: string, outDir: string): Promise<void> {
  const CLOUD = join(ROOT, 'packages', 'cloud')
  const dir = join(outDir, 'vx-cloud')
  await mkdir(dir, { recursive: true })
  // The dashboard SPA dist is a build artifact (not committed) — build it so
  // `ui/dist/index.html` exists to copy into the package (ui-asset.ts embeds it
  // via a relative import at the consumer's `bun run`).
  const spa = Bun.spawnSync({
    cmd: ['bun', 'run', 'build'],
    cwd: join(CLOUD, 'ui'),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (spa.exitCode !== 0) throw new Error('vx-cloud dashboard SPA build failed')
  await cp(join(CLOUD, 'src'), join(dir, 'src'), { recursive: true })
  await cp(join(CLOUD, 'ui', 'dist'), join(dir, 'ui', 'dist'), { recursive: true })
  await cp(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'))
  await Bun.write(
    join(dir, 'README.md'),
    `# @vzn/vx-cloud\n\nThe [vx](${REPOSITORY}) orchestrator service (\`vx-cloud serve\` / \`agent\` / \`connect\`) and the first-party \`cloud()\` plugin.\n\n\`\`\`sh\nnpm i -g @vzn/vx-cloud   # the vx-cloud CLI (requires Bun >= 1.3)\n\`\`\`\n\nOr just the plugin, in your \`vx.workspace.ts\`:\n\n\`\`\`ts\nimport { defineWorkspace } from '@vzn/vx'\nimport { cloud } from '@vzn/vx-cloud/plugin'\nexport default defineWorkspace({ plugins: [cloud()] })\n\`\`\`\n\nUnlike \`@vzn/vx\` (a standalone binary, no Bun needed), \`vx-cloud\` ships as Bun\nsource and **requires Bun** on the host — the service is Bun-native. See the\n[docs](${REPOSITORY}) for self-hosting + distributed CI.\n`,
  )
  await writeJson(join(dir, 'package.json'), {
    name: '@vzn/vx-cloud',
    version,
    description:
      'The vx-cloud orchestrator service (serve, agents, distribution) + the cloud() plugin.',
    type: 'module',
    exports: {
      '.': { types: './src/index.ts', import: './src/index.ts' },
      './plugin': { types: './src/plugin.ts', import: './src/plugin.ts' },
    },
    types: './src/index.ts',
    // Bun-shebang bin — the service is Bun-native (contrast @vzn/vx's no-Bun launcher).
    bin: { 'vx-cloud': './src/cli/bin.ts' },
    engines: { bun: '>=1.3' },
    // Pin core to the same version so the bare `import '@vzn/vx'` in the plugin
    // + CLI resolves from node_modules (no dev workspace symlink in a publish).
    dependencies: { '@vzn/vx': version },
    files: ['src', 'ui/dist', 'README.md', 'LICENSE'],
    repository: REPOSITORY,
    homepage: `${REPOSITORY}#readme`,
    bugs: `${REPOSITORY}/issues`,
    license: 'MIT',
    keywords: ['vx', 'monorepo', 'ci', 'distributed', 'remote-cache', 'dashboard', 'bun'],
  })
}

await main()
