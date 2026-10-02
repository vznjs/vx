// `pn`, pnpm's own short name, read as pnpm by `vx init` (D-97).
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
  name,
  dir,
  packageJson: { name, scripts } as never,
  configPath: null,
})

it('a root script running the members through `pn` is left out (D-97)', () => {
  // pnpm/pnpm's root: `test-pkgs-all` (`pn … -r .test`), `release` (`pn
  // --filter=…`) and `dev-setup` (`pn -C=…`) mapped as root tasks.
  const root = meta('root', '/w', {
    'test-pkgs-all': 'pn remove-temp-dir && pn --workspace-concurrency=2 -r .test',
    release: 'pn --filter=@pnpm/exe run build-artifacts',
    'dev-setup': 'pn -C=./pnpm11/pnpm/dev link -g',
    'test-all': 'pn lint && pn test-pkgs-all',
    // CONTROLS: `pn` running a root script that runs no member, `pnx`.
    lint: 'pn spellcheck',
    spellcheck: 'cspell "**/*.ts"',
    'remove-temp-dir': 'shx rm -rf ../pnpm_tmp',
    typecheck: 'pnx tsgo --build -r',
  })
  const a = meta('a', '/w/packages/a', { compile: 'tsc' })
  expect(
    migrateScripts([root, a]).projects.map((p) => [p.name, p.tasks.map((t) => t.name)]),
  ).toEqual([
    ['a', ['compile']],
    ['root', ['lint', 'spellcheck', 'remove-temp-dir', 'typecheck']],
  ])
})

it('`pn <script>` alone is a group over it, as `pnpm <script>` is (D-97)', () => {
  const tasks = migrateScripts([meta('a', '/w/a', { b: 'tsc', c: 'pn b', d: 'pn run b' })])
    .projects[0]!.tasks
  expect(Object.fromEntries(tasks.map((t) => [t.name, t.task]))).toEqual({
    b: { exec: { command: 'tsc' } },
    c: { dependsOn: ['b'] },
    d: { dependsOn: ['b'] },
  })
})
