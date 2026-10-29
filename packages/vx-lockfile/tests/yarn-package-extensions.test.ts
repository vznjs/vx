// Yarn Berry installs what `packageExtensions` add (the project's, in
// .yarnrc.yml, and Yarn's builtin `@babel/parser` → `@babel/types`) but
// the extended package's yarn.lock entry does not list it, so a
// lockfile-only bump of an added package moved no key (turborepo#14873).
// The lockfile is trimmed from Turbo's berry-redundant-package-extensions
// fixture (yarn 4.13.0): `extended` → is-number@7.0.0, which the
// `is-number@*` extension gives kind-of@^6; `redundant` → is-odd →
// is-number@6.0.0, extended too; `declares` → is-number@3.0.0, which
// declares kind-of itself; the babel workspaces reach @babel/types only
// through the builtin extension, but for `babel-new`, whose parser declares it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { type Logger } from '@vzn/vx'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { affectedIds, commitAll, moved } from './helpers/affected.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const WORKSPACES = ['babel-alias', 'babel-new', 'babel-old', 'declares', 'extended', 'redundant']
const BUILD =
  "export default { tasks: { build: { exec: { command: 'echo built' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } } } }\n"

const RC = `nodeLinker: node-modules

packageExtensions:
  "is-number@*":
    dependencies:
      kind-of: "^6.0.0"
  "is-odd@*":
    dependencies:
      is-number: "^7.0.0"
`

const pkg = (key: string, version: string, deps: Record<string, string> = {}) => {
  const name = key.slice(0, key.indexOf('@', 1))
  const lines = Object.entries(deps).map(([k, v]) => `    "${k}": "${v}"`)
  return `"${key}":
  version: ${version}
  resolution: "${name}@npm:${version}"
${lines.length === 0 ? '' : `  dependencies:\n${lines.join('\n')}\n`}  checksum: 10c0/${name.replace(/\W/g, '')}${version}
  languageName: node
  linkType: hard
`
}

const ws = (name: string, dir: string, deps: Record<string, string> = {}) => {
  const lines = Object.entries(deps).map(([k, v]) => `    "${k}": "${v}"`)
  return `"${name}@workspace:${dir}":
  version: 0.0.0-use.local
  resolution: "${name}@workspace:${dir}"
${lines.length === 0 ? '' : `  dependencies:\n${lines.join('\n')}\n`}  languageName: unknown
  linkType: soft
`
}

function lock(opts: { kindOf?: string; types?: string } = {}): string {
  return [
    `__metadata:\n  version: 8\n  cacheKey: 10c0\n`,
    pkg('@babel/helper-string-parser@npm:^7.29.7', '7.29.7'),
    pkg('@babel/parser@npm:7.24.6, parser-alias@npm:@babel/parser@7.24.6', '7.24.6'),
    pkg('@babel/parser@npm:7.29.0', '7.29.0', { '@babel/types': 'npm:^7.29.0' }),
    pkg('@babel/types@npm:^7.29.0, @babel/types@npm:^7.8.3', opts.types ?? '7.29.8', {
      '@babel/helper-string-parser': 'npm:^7.29.7',
    }),
    ws('babel-alias', 'packages/babel-alias', { 'parser-alias': 'npm:@babel/parser@7.24.6' }),
    ws('babel-new', 'packages/babel-new', { '@babel/parser': 'npm:7.29.0' }),
    ws('babel-old', 'packages/babel-old', { '@babel/parser': 'npm:7.24.6' }),
    ws('root', '.'),
    ws('declares', 'packages/declares', { 'is-number': 'npm:3.0.0' }),
    ws('extended', 'packages/extended', { 'is-number': 'npm:7.0.0' }),
    pkg('is-buffer@npm:^1.1.5', '1.1.6'),
    pkg('is-number@npm:3.0.0', '3.0.0', { 'kind-of': 'npm:^3.0.2' }),
    pkg('is-number@npm:7.0.0', '7.0.0'),
    pkg('is-number@npm:^6.0.0', '6.0.0'),
    pkg('is-odd@npm:3.0.1', '3.0.1', { 'is-number': 'npm:^6.0.0' }),
    pkg('kind-of@npm:^3.0.2', '3.2.2', { 'is-buffer': 'npm:^1.1.5' }),
    pkg('kind-of@npm:^6.0.0', opts.kindOf ?? '6.0.3'),
    ws('redundant', 'packages/redundant', { 'is-odd': 'npm:3.0.1' }),
  ].join('\n')
}

function silent(): Logger {
  return {
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
    status() {},
  } as never
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-yarn-ext-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
  )
  for (const name of WORKSPACES) {
    const dir = path.join(root, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
    await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
    await writeFile(path.join(dir, 'vx.config.mjs'), BUILD)
  }
  await writeFile(path.join(root, '.yarnrc.yml'), RC)
  await writeFile(path.join(root, 'yarn.lock'), lock())
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(['yarn()'], `import { yarn } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const plan = async () => {
  const p = await planRun({ cwd: root, tasks: ['build'], log: silent() })
  return Object.fromEntries(p.tasks.map((t) => [t.node.id, t.hash]))
}

it('a lockfile-only bump of what a .yarnrc.yml extension adds re-keys and selects the packages it extends', async () => {
  commitAll(root)
  const before = await plan()
  await writeFile(path.join(root, 'yarn.lock'), lock({ kindOf: '6.0.4' }))
  expect(moved(before, await plan())).toEqual(['extended#build', 'redundant#build'])
  expect(affectedIds(root, 'build')).toEqual(['extended#build', 'redundant#build'])
})

it("a bump of @babel/types re-keys and selects every package whose parser gets it, Yarn's builtin extension included", async () => {
  commitAll(root)
  const before = await plan()
  await writeFile(path.join(root, 'yarn.lock'), lock({ types: '7.29.9' }))
  const want = ['babel-alias#build', 'babel-new#build', 'babel-old#build']
  expect(moved(before, await plan())).toEqual(want)
  expect(affectedIds(root, 'build')).toEqual(want)
})

it('an entry nothing reaches, from an extension vx cannot read, re-keys every package', async () => {
  // No .yarnrc.yml to say which package kind-of@^6 extends: the entry is
  // installed for one of them, so every package folds it.
  await rm(path.join(root, '.yarnrc.yml'))
  commitAll(root)
  const before = await plan()
  await writeFile(path.join(root, 'yarn.lock'), lock({ kindOf: '6.0.4' }))
  const all = WORKSPACES.map((w) => `${w}#build`)
  expect(moved(before, await plan())).toEqual(all)
  expect(affectedIds(root, 'build')).toEqual(all)
})
