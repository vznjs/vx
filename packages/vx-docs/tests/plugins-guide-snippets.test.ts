// The plugins guide says "Everything below is real, runnable code
// against the types exported from `@vzn/vx`." This pins the claim: every
// TypeScript block in the guide type-checks against the façade, so a seam
// that moves turns the guide red before an author copies a stale block.
// Blocks that open with `interface` are contract sketches with untyped
// parameters and are skipped on purpose.
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const SITE = path.resolve(import.meta.dir, '..')
const GUIDE = path.join(SITE, 'src/content/docs/guides/plugins.md')
// oxlint is a ROOT devDependency; Bun hoists it, so this package's own
// `node_modules/.bin` never has it and the root's is the one place it is.
const ROOT = path.resolve(SITE, '../..')
const OXLINT = path.join(ROOT, 'node_modules/.bin/oxlint')

it('every code block in the plugins guide type-checks against @vzn/vx', async () => {
  const text = await Bun.file(GUIDE).text()
  const blocks = [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!)
  expect(blocks.length).toBeGreaterThan(5)
  // A tmp dir OUTSIDE the repo — a test writing into its own project would
  // dirty the tree the cache hashes. `@vzn/vx` and `@types/bun` resolve
  // through the linked ROOT node_modules, and a self-contained tsconfig is
  // written beside the blocks (the site's own extends astro's, which is not
  // hoisted and would not resolve from here).
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-guide-snippets-'))
  try {
    await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          target: 'esnext',
          noEmit: true,
          allowImportingTsExtensions: true,
          types: ['bun'],
          // A plugin PACKAGE the guide imports for illustration resolves
          // through the SITE's own node_modules, not the root's: the site
          // declares it (package.json), Bun links it there and nowhere
          // else, and the sandbox grants a project's linked dependencies
          // while denying every other sibling — pointing straight at
          // `packages/vx-schedule-history` type-checked here and exited 1
          // under the sandboxed gate on CI (2026-09-10).
          paths: {
            '@vzn/vx-schedule-history': [
              path.join(SITE, 'node_modules', '@vzn', 'vx-schedule-history', 'src', 'index.ts'),
            ],
          },
        },
        include: ['*.ts', '*.d.ts'],
      }),
    )
    // A third-party module the guide imports for illustration (Sentry) is
    // ambient-typed as `any`: the pin is about vx's OWN types, and installing
    // an SDK to type-check a doc would be the tail wagging the dog.
    await writeFile(path.join(dir, 'ambient.d.ts'), "declare module '@sentry/node'\n")
    const files: string[] = []
    for (const [i, block] of blocks.entries()) {
      const firstCode = block.split('\n').find((l) => l.trim() !== '' && !l.startsWith('import '))
      if (firstCode?.startsWith('interface ')) continue
      const file = path.join(dir, `block-${String(i).padStart(2, '0')}.ts`)
      await writeFile(file, block)
      files.push(file)
    }
    expect(files.length).toBeGreaterThan(5)
    // `--type-check` is the flag that reports TypeScript errors; `--type-aware`
    // alone only enables the type-aware LINT rules and let a `const x: number =
    // 'a'` block through. The files are named one by one: pointed at the
    // directory, oxlint walks the symlinked node_modules for minutes.
    const p = Bun.spawnSync({
      cmd: [OXLINT, '--type-aware', '--type-check', ...files],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
    const errors = out.split('\n').filter((l) => /^\s*x |: error /.test(l))
    // A non-zero exit with no diagnostic line is oxlint failing before it
    // could type-check (a module it could not read, say); carry its tail
    // so the failure names the cause instead of just the exit code.
    const tail = p.exitCode === 0 ? [] : out.trim().split('\n').slice(-15)
    expect({ exitCode: p.exitCode, errors, tail }).toEqual({ exitCode: 0, errors: [], tail: [] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
