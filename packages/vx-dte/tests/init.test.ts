// `vx dte init`: each adapter writes the CI files that start its workers,
// from dte()'s own sizes, so none is copied by hand.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { CommandContext } from '@vzn/vx'
import { dte, github, gitlab, local } from '../src/index.js'

const DTE = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')

let root: string
let printed: string[]
const write = process.stdout.write.bind(process.stdout)
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-init-'))
  printed = []
  process.stdout.write = ((chunk: string) => {
    printed.push(String(chunk))
    return true
  }) as typeof process.stdout.write
})
afterEach(async () => {
  process.stdout.write = write
  await rm(root, { recursive: true, force: true })
})

function init(options: Parameters<typeof dte>[0], ...args: string[]): Promise<number> {
  const verb = dte(options).commands!['dte']!
  return Promise.resolve(
    verb.run(['init', ...args], { workspaceRoot: root } as CommandContext),
  ) as Promise<number>
}

const WORKFLOW = '.github/workflows/vx-worker.yml'
const sizes = {
  small: { max: 8, cpu: 4, memory: '16GB' },
  mac: { max: 2, cpu: 3, memory: '7GB', platform: 'darwin-arm64' },
} as const

it('github() writes the workers workflow: the inputs it dispatches, a runner per size, the repo vx', async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  expect(await init({ workers: sizes, adapter: github() })).toBe(0)
  const yml = await readFile(path.join(root, WORKFLOW), 'utf8')
  // The inputs dispatch() sends, each one required.
  for (const input of ['run', 'relay', 'sha', 'size', 'workers'])
    expect(yml).toContain(`      ${input}: { required: true }\n`)
  expect(yml).toContain(
    `runs-on: \${{ fromJSON('{"small":"ubuntu-latest","mac":"macos-latest"}')[inputs.size] }}`,
  )
  expect(yml).toContain('name: ${{ matrix.worker }}')
  expect(yml).toContain('VX_DTE_WORKER: ${{ matrix.worker }}')
  expect(yml).toContain("with: { ref: '${{ inputs.sha }}' }")
  expect(yml).toContain(
    '      - run: bun install --frozen-lockfile\n      - run: bun vx dte worker\n',
  )
  // Never a download: `bunx` fetches a package the repo lacks.
  expect(yml).not.toContain('bunx')
  expect(printed.join('')).toContain('actions: write')
})

it('github({ runsOn }) names a size its runner; pnpm gets its setup step', async () => {
  await writeFile(path.join(root, 'pnpm-lock.yaml'), '')
  const adapter = github({ workflow: 'w.yml', runsOn: { small: 'ubuntu-latest-16-cores' } })
  expect(await init({ workers: sizes, adapter })).toBe(0)
  const yml = await readFile(path.join(root, '.github/workflows/w.yml'), 'utf8')
  expect(yml).toContain(`'{"small":"ubuntu-latest-16-cores","mac":"macos-latest"}'`)
  expect(yml).toContain(
    '      - uses: pnpm/action-setup@v4\n      - run: pnpm install --frozen-lockfile\n',
  )
})

it('keeps a workflow its owner changed unless --force, and says when it is up to date', async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  await mkdir(path.join(root, '.github/workflows'), { recursive: true })
  await writeFile(path.join(root, WORKFLOW), 'mine\n')
  expect(init({ workers: sizes, adapter: github() })).rejects.toThrow(
    'vx dte init: .github/workflows/vx-worker.yml already exists with other contents',
  )
  expect(await readFile(path.join(root, WORKFLOW), 'utf8')).toBe('mine\n')
  expect(await init({ workers: sizes, adapter: github() }, '--dry')).toBe(0)
  expect(await readFile(path.join(root, WORKFLOW), 'utf8')).toBe('mine\n')
  expect(printed.join('')).toContain('# .github/workflows/vx-worker.yml\n')
  expect(await init({ workers: sizes, adapter: github() }, '--force')).toBe(0)
  printed = []
  expect(await init({ workers: sizes, adapter: github() })).toBe(0)
  expect(printed.join('')).toContain('vx dte init: .github/workflows/vx-worker.yml is up to date')
})

it('gitlab() writes the include its workers extend, the token for the relay', async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  const adapter = gitlab({ include: '.gitlab/vx.yml' })
  expect(init({ workers: sizes, adapter })).rejects.toThrow('gitlab() needs dte({ relay })')
  expect(await init({ relay: 'https://relay.example.com', workers: sizes, adapter })).toBe(0)
  const yml = await readFile(path.join(root, '.gitlab/vx.yml'), 'utf8')
  expect(yml).toContain('.vx-worker:\n  extends: .vx\n')
  expect(yml).toContain('id_tokens: { VX_DTE_TOKEN: { aud: https://relay.example.com } }')
  expect(yml).toContain('    - bun install --frozen-lockfile\n')
  expect(printed.join('')).toContain('script: [bun vx dte plan build test --all]')
})

it('an adapter that starts workers here writes nothing; no lockfile is refused', async () => {
  expect(await init({ workers: sizes, adapter: local() })).toBe(0)
  expect(printed.join('')).toContain('no CI files to write')
  expect(init({ workers: sizes, adapter: github() })).rejects.toThrow('no lockfile')
})

it('vx dte init runs from the CLI', async () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws', private: true }),
    'bun.lock': '',
    '.vx/workspace.mjs': `import { dte, github } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { cpu: 2, memory: '8GB' } }, adapter: github() })] }
`,
  }
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  const r = Bun.spawnSync([process.execPath, CORE_BIN, 'dte', 'init', '--dry'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect([r.exitCode, r.stderr.toString()]).toEqual([0, ''])
  expect(r.stdout.toString()).toContain(`'{"small":"ubuntu-latest"}'`)
})

it('the README shows the workflow vx dte init writes for its sizes', async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  const small = { small: { max: 8, cpu: 4, memory: '16GB' } }
  expect(await init({ workers: small, adapter: github() })).toBe(0)
  const written = await readFile(path.join(root, WORKFLOW), 'utf8')
  const readme = await readFile(path.resolve(import.meta.dir, '..', 'README.md'), 'utf8')
  expect(readme).toContain('```yaml\n# .github/workflows/vx-worker.yml\n' + written + '```')
})
