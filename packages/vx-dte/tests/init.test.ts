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
  const run = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  expect(run).toContain('      id-token: write\n')
  expect(run).toContain('      actions: write\n')
  expect(run).toContain('GITHUB_TOKEN: ${{ github.token }}')
  // No task runs on the orchestrator: vx and the plugins only.
  expect(run).toContain("      - run: bun install --frozen-lockfile --filter './'\n")
  // The tasks are the user's: none written, so the run fails until named.
  expect(run).toContain(
    "      - run: bun vx run ${{ github.event_name == 'pull_request' && '--affected' || '--all' }}\n",
  )
  // No relay named yet: how to deploy one, and the rest of the steps.
  expect(printed.join('')).toContain('https://vznjs.github.io/vx/docs/relay/')
  expect(printed.join('')).toContain('https://vznjs.github.io/vx/docs/remote-cache/')
  expect(printed.join('')).toContain(
    'Its ALLOW (a plain var, no secret): https://token.actions.githubusercontent.com:<owner>/<repo>:ci.yml https://token.actions.githubusercontent.com:<owner>/<repo>:vx-worker.yml',
  )
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

// A `: ` in a plain scalar made GitHub refuse the workflow (2026-10-25).
it('writes workflows that parse as YAML', async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  expect(await init({ workers: sizes, adapter: github() })).toBe(0)
  for (const file of [WORKFLOW, '.github/workflows/ci.yml']) {
    const yml = await readFile(path.join(root, file), 'utf8')
    expect(() => Bun.YAML.parse(yml)).not.toThrow()
  }
  const steps = (
    Bun.YAML.parse(await readFile(path.join(root, WORKFLOW), 'utf8')) as {
      jobs: { worker: { steps: { run?: string }[] } }
    }
  ).jobs.worker.steps
  expect(steps.some((s) => s.run?.startsWith('jq -r'))).toBe(true)
})

// CI reads its files at the repository's root: a workspace in a
// subdirectory got them in its own, which no CI reads (2026-10-25).
it('writes the CI files at the repository’s root, running in the workspace’s directory', async () => {
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  const ws = path.join(root, 'ws')
  await mkdir(ws, { recursive: true })
  await writeFile(path.join(ws, 'pnpm-lock.yaml'), '')
  const at = (options: Parameters<typeof dte>[0]) =>
    Promise.resolve(
      dte(options).commands!['dte']!.run(['init'], { workspaceRoot: ws } as CommandContext),
    )
  expect(await at({ workers: sizes, adapter: github() })).toBe(0)
  for (const file of [WORKFLOW, '.github/workflows/ci.yml']) {
    const yml = await readFile(path.join(root, file), 'utf8')
    expect(yml).toContain('    defaults:\n      run:\n        working-directory: ws\n')
    expect(yml).toContain(
      '      - uses: pnpm/action-setup@v4\n        with: { package_json_file: ws/package.json }\n',
    )
  }
  const relay = 'https://relay.example.com'
  expect(await at({ relay, workers: sizes, adapter: gitlab() })).toBe(0)
  const ci = await readFile(path.join(root, '.gitlab-ci.yml'), 'utf8')
  expect(ci).toContain("  before_script:\n    - cd 'ws'\n    - pnpm install --frozen-lockfile\n")
  expect(ci).toContain("    - git checkout -q FETCH_HEAD\n    - cd 'ws'\n")
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

it('gitlab() writes one pipeline file: the run, and a job per size only its trigger runs', async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  const adapter = gitlab({ tags: { mac: ['saas-macos-medium-m1'] } })
  expect(init({ workers: sizes, adapter })).rejects.toThrow('gitlab() needs dte({ relay })')
  expect(await init({ relay: 'https://relay.example.com', workers: sizes, adapter })).toBe(0)
  const ci = await readFile(path.join(root, '.gitlab-ci.yml'), 'utf8')
  expect(ci).toContain('  id_tokens: { VX_DTE_TOKEN: { aud: https://relay.example.com } }\n')
  expect(ci).toContain('    - if: $CI_PIPELINE_SOURCE == "pipeline" && $VX_DTE_SIZE\n')
  // No task runs on the orchestrator: vx and the plugins only.
  expect(ci).toContain("  before_script:\n    - bun install --frozen-lockfile --filter './'\n")
  expect(ci).toContain("      variables: { VX_TASKS: '--all' }\n")
  expect(ci).toContain('# Name the tasks in the vx job')
  expect(ci).toContain('    - git fetch -q --depth 1 origin $VX_DTE_SHA\n')
  expect(ci).toContain(
    `'vx-worker mac':\n  extends: .vx-worker\n  parallel:\n    matrix:\n      - VX_DTE_SLOT: ['1', '2']\n  rules: [{ if: $VX_DTE_SIZE == "mac" && $VX_DTE_SLOT =~ $VX_DTE_PICK }]\n  tags: ['saas-macos-medium-m1']\n`,
  )
  expect(ci).toContain(`      - VX_DTE_SLOT: ['1', '2', '3', '4', '5', '6', '7', '8']\n`)
  // A matrix needs its length.
  expect(
    init({ relay: 'https://r', workers: { small: { cpu: 2, memory: '8GB' } }, adapter }, '--force'),
  ).rejects.toThrow('gitlab() needs workers.small.max, 1 to 200')
  expect(ci).not.toContain('bunx')
  expect(printed.join('')).toContain(
    'ALLOW (a plain var, no secret): https://gitlab.com:<group>/<project>:.gitlab-ci.yml',
  )
  expect(printed.join('')).toContain(
    'The relay at https://relay.example.com must admit these workflows.',
  )
})

it("gitlab()'s ALLOW names the origin's GitLab, a self-managed one too", async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  const adapter = gitlab()
  const relay = 'https://relay.example.com'
  for (const [url, allow] of [
    ['git@gitlab.example.com:group/sub/app.git', 'https://gitlab.example.com:group/sub/app'],
    ['ssh://git@gitlab.example.com:2222/group/app.git', 'https://gitlab.example.com:group/app'],
    [
      'https://ci@gitlab.example.com:8443/group/app.git',
      'https://gitlab.example.com:8443:group/app',
    ],
    ['https://gitlab.com/group/app', 'https://gitlab.com:group/app'],
  ]) {
    Bun.spawnSync(['git', 'remote', 'remove', 'origin'], { cwd: root })
    Bun.spawnSync(['git', 'remote', 'add', 'origin', url!], { cwd: root })
    printed = []
    expect(await init({ relay, workers: sizes, adapter }, '--dry')).toBe(0)
    expect(printed.join('')).toContain(`ALLOW (a plain var, no secret): ${allow}:.gitlab-ci.yml\n`)
  }
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
  // The relay's ALLOW names the origin's repository.
  Bun.spawnSync(['git', 'remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: root })
  const written = Bun.spawnSync([process.execPath, CORE_BIN, 'dte', 'init'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
  })
  expect(written.stdout.toString()).toContain(
    'https://token.actions.githubusercontent.com:acme/app:ci.yml',
  )
  // The run line as written, no task named, fails on CI and lists the tasks.
  const run = Bun.spawnSync([process.execPath, CORE_BIN, 'run', '--all'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', CI: 'true' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect([run.exitCode, run.stderr.toString()]).toEqual([
    1,
    expect.stringContaining('missing task name'),
  ])
})

it('the README shows the workflow vx dte init writes for its sizes', async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  const small = { small: { max: 8, cpu: 4, memory: '16GB' } }
  expect(await init({ workers: small, adapter: github() })).toBe(0)
  const written = await readFile(path.join(root, WORKFLOW), 'utf8')
  const readme = await readFile(path.resolve(import.meta.dir, '..', 'README.md'), 'utf8')
  expect(readme).toContain('```yaml\n# .github/workflows/vx-worker.yml\n' + written + '```')
  const run = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  expect(readme).toContain('```yaml\n# .github/workflows/ci.yml\n' + run + '```')
  const gl = await gitlab().init!({
    workspaceRoot: root,
    dir: '',
    relay: 'https://relay.example.com',
    sizes: [{ name: 'small', max: 4 }],
    manager: 'bun',
    tasks: { main: '', change: '' },
  })
  expect(readme).toContain('```yaml\n# .gitlab-ci.yml\n' + gl.files['.gitlab-ci.yml'] + '```')
})

it('writes the tasks asked for: main with --all, a change request with --affected', async () => {
  const setup = {
    workspaceRoot: root,
    dir: '',
    relay: 'https://r',
    sizes: [{ name: 'small', max: 4 }],
    manager: 'bun' as const,
    tasks: { main: 'build test e2e', change: 'build test' },
  }
  const gh = (await github().init!(setup)).files['.github/workflows/ci.yml']!
  expect(gh).toContain(
    "      - run: bun vx run ${{ github.event_name == 'pull_request' && 'build test --affected' || 'build test e2e --all' }}\n",
  )
  expect(gh).not.toContain('Name the tasks')
  const gl = (await gitlab().init!(setup)).files['.gitlab-ci.yml']!
  expect(gl).toContain("      variables: { VX_TASKS: 'build test e2e --all' }\n")
  expect(gl).toContain("      variables: { VX_TASKS: 'build test --affected' }\n")
  expect(gl).toContain('    - bun vx run $VX_TASKS\n')
  expect(gl).toContain('  script: [bun vx dte worker]\n')
  expect(gl).not.toContain('Name the tasks')
})

it('vx dte --help prints the usage and exits 0', async () => {
  await mkdir(path.join(root, '.vx'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { cpu: 2, memory: '8GB' } }, adapter: local() })] }
`,
  )
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  for (const args of [['--help'], ['-h'], ['help'], ['init', '--help'], ['worker', '-h']]) {
    const r = Bun.spawnSync([process.execPath, CORE_BIN, 'dte', ...args], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect([args, r.exitCode, r.stdout.toString()]).toEqual([
      args,
      0,
      'Usage: vx dte worker | vx dte init [--dry] [--force]\n',
    ])
  }
})

it('vx dte says what is wrong with the line typed', async () => {
  await mkdir(path.join(root, '.vx'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { cpu: 2, memory: '8GB' } }, adapter: local() })] }
`,
  )
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  const said = (args: string[]) =>
    Bun.spawnSync([process.execPath, CORE_BIN, 'dte', ...args], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
      stderr: 'pipe',
    })
      .stderr.toString()
      .split('\n')[0]
  expect([said([]), said(['bogus']), said(['worker', '--bogus'])]).toEqual([
    '✗ vx dte  missing subcommand',
    '✗ vx dte  unknown subcommand: bogus',
    '✗ vx dte  vx dte worker takes no arguments: --bogus',
  ])
})

it('a relay URL with no http(s) scheme is refused, named', async () => {
  await mkdir(path.join(root, '.vx'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  const workspace = (relay: string) =>
    writeFile(
      path.join(root, '.vx/workspace.mjs'),
      `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ relay: ${JSON.stringify(relay)}, workers: { small: { cpu: 2, memory: '8GB' } }, adapter: local() })] }
`,
    )
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  const said = (env: Record<string, string>) => {
    const { VX_DTE_RELAY: _, ...rest } = process.env
    return Bun.spawnSync([process.execPath, CORE_BIN, 'dte', 'worker'], {
      cwd: root,
      env: { ...rest, ...env, NO_COLOR: '1', VX_DTE_RUN: crypto.randomUUID() },
      stderr: 'pipe',
    }).stderr.toString()
  }
  await workspace('relay.example.com')
  expect(said({})).toContain('dte() option "relay" must be an http(s) URL, got "relay.example.com"')
  await workspace('https://relay.example.com')
  expect(said({ VX_DTE_RELAY: 'relay.example.com' })).toStartWith(
    '✗ vx dte  vx dte worker: VX_DTE_RELAY must be http(s), got relay.example.com\n',
  )
})

it('vx dte worker names only what it lacks', async () => {
  await mkdir(path.join(root, '.vx'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { cpu: 2, memory: '8GB' } }, adapter: local() })] }
`,
  )
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  const said = (env: Record<string, string>) => {
    const { VX_DTE_RUN: _, VX_DTE_RELAY: __, ...rest } = process.env
    const r = Bun.spawnSync([process.execPath, CORE_BIN, 'dte', 'worker'], {
      cwd: root,
      env: { ...rest, ...env, NO_COLOR: '1' },
      stderr: 'pipe',
    })
    return r.stderr.toString().split('\n')[0]
  }
  expect([
    said({}),
    said({ VX_DTE_RUN: crypto.randomUUID() }),
    said({ VX_DTE_RELAY: 'http://127.0.0.1:9' }),
  ]).toEqual([
    '✗ vx dte  vx dte worker needs VX_DTE_RUN, and VX_DTE_RELAY or dte({ relay })',
    '✗ vx dte  vx dte worker needs VX_DTE_RELAY or dte({ relay })',
    '✗ vx dte  vx dte worker needs VX_DTE_RUN',
  ])
})
