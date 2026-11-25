// `vx dte init`: each adapter writes the CI files that start its workers,
// from dte()'s own sizes, so none is copied by hand.

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { CommandContext } from '@vzn/vx'
import { dte, github, gitlab, local } from '../src/index.js'
import { askTasks } from '../src/init.js'

const DTE = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')

let root: string
let printed: string[]
const write = process.stdout.write.bind(process.stdout)
const noColor = process.env['NO_COLOR']
beforeEach(async () => {
  // The words, as a pipe reads them: a CI's env paints what is captured here.
  process.env['NO_COLOR'] = '1'
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-init-'))
  printed = []
  process.stdout.write = ((chunk: string) => {
    printed.push(String(chunk))
    return true
  }) as typeof process.stdout.write
})
afterEach(async () => {
  process.stdout.write = write
  if (noColor === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = noColor
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
  linux: {
    machines: {
      small: { max: 8, cpu: 4, memory: '16GB' },
      mac: { max: 2, cpu: 3, memory: '7GB', platform: 'darwin-arm64' },
    },
  },
} as const

it('github() writes the workers workflow: the inputs it dispatches, a runner per size, the repo vx', async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  expect(await init({ workers: sizes, adapter: github() })).toBe(0)
  const yml = await readFile(path.join(root, WORKFLOW), 'utf8')
  // The inputs dispatch() sends, each one required.
  for (const input of ['run', 'relay', 'sha', 'size', 'workers'])
    expect(yml).toContain(`      ${input}: { required: true }\n`)
  expect(yml).toContain(
    `runs-on: \${{ fromJSON('{"linux.small":"ubuntu-latest","linux.mac":"macos-latest"}')[inputs.size] }}`,
  )
  expect(yml).toContain('name: ${{ matrix.worker }}')
  // A write is the job's alone, as the supply-chain law holds this repo's.
  expect(yml).toContain('permissions:\n  contents: read\n  id-token: write\n\njobs:\n')
  expect(yml).toContain(
    '    permissions:\n      contents: read\n      id-token: write\n      # A worker of a run that is over cancels its own run.\n      actions: write\n',
  )
  expect(yml).toContain(
    '    env:\n      VX_DTE_WORKER: ${{ matrix.worker }}\n      GITHUB_TOKEN: ${{ github.token }}\n',
  )
  expect(yml).toContain("with: { ref: '${{ inputs.sha }}', persist-credentials: false }")
  expect(yml).toMatch(
    /      - run: bun install --frozen-lockfile\n(      #.*\n)*      - run: bun vx dte worker\n$/,
  )
  // Never a download: `bunx` fetches a package the repo lacks.
  expect(yml).not.toContain('bunx')
  const run = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  expect(run).toContain('      id-token: write\n')
  expect(run).toContain('      actions: write\n')
  expect(run).toContain('GITHUB_TOKEN: ${{ github.token }}')
  // A merge queue's run, as .gitlab-ci.yml runs a merge train's: without
  // the trigger a queue that requires ci waited on a check never started.
  expect(run).toContain('on:\n  pull_request:\n  merge_group:\n  push:\n')
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

it('a machine’s runsOn names its runner; pnpm gets its setup step', async () => {
  await writeFile(path.join(root, 'pnpm-lock.yaml'), '')
  const adapter = github({ workflow: 'w.yml' })
  const workers = {
    linux: {
      machines: {
        ...sizes.linux.machines,
        small: { ...sizes.linux.machines.small, runsOn: 'ubuntu-latest-16-cores' },
      },
    },
  }
  expect(await init({ workers, adapter })).toBe(0)
  const yml = await readFile(path.join(root, '.github/workflows/w.yml'), 'utf8')
  expect(yml).toContain(`'{"linux.small":"ubuntu-latest-16-cores","linux.mac":"macos-latest"}'`)
  expect(yml).toContain(
    '      - uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0\n      - run: pnpm install --frozen-lockfile\n',
  )
})

// Yarn 1, what corepack runs without a packageManager field, ignores
// --immutable and rewrites a stale yarn.lock; both majors honour
// --frozen-lockfile.
it('installs a Yarn workspace frozen under Yarn 1 and Berry alike', async () => {
  await writeFile(path.join(root, 'yarn.lock'), '')
  expect(await init({ workers: sizes, adapter: github() })).toBe(0)
  for (const file of [WORKFLOW, '.github/workflows/ci.yml']) {
    const yml = await readFile(path.join(root, file), 'utf8')
    expect(yml).toContain(
      '      - run: corepack enable\n      - run: yarn install --frozen-lockfile\n',
    )
  }
})

// `yarn vx` under Berry runs a bin with node, whatever its shebang: vx's
// bin.ts failed at its first import. Bun reads no Plug'n'Play either, so
// Bun's own .bin lookup is the one that runs vx under every Yarn.
it('runs vx with Bun in a Yarn workspace', async () => {
  await writeFile(path.join(root, 'yarn.lock'), '')
  expect(await init({ workers: sizes, adapter: github() })).toBe(0)
  const worker = await readFile(path.join(root, WORKFLOW), 'utf8')
  expect(worker).toContain('      - run: bun vx dte worker\n')
  const run = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  expect(run).toContain('      - run: bun vx lock --check\n')
  expect(run).not.toContain('yarn vx')
  const { files } = await gitlab().init!({
    workspaceRoot: root,
    dir: '',
    relay: 'https://r',
    sizes: [{ name: 'small', max: 1 }],
    manager: 'yarn',
    tasks: { main: '', change: '' },
  })
  expect(files['.gitlab-ci.yml']).toContain('  script: [bun vx dte worker]\n')
  expect(files['.gitlab-ci.yml']).not.toContain('yarn vx')
})

// An empty or non-string label was written into runs-on, a workflow GitHub refuses.
it('refuses a machine runsOn that is not a runner label', () => {
  for (const label of ['', ' ', 5])
    expect(() =>
      dte({
        workers: {
          linux: { machines: { small: { cpu: 1, memory: '1GB', runsOn: label as string } } },
        },
        adapter: github(),
      }),
    ).toThrow(
      typeof label === 'string'
        ? 'dte() option "workers.linux.machines.small.runsOn" must be a runner label'
        : 'workers.linux.machines.small',
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
})

// A tag is its maintainer's to move (or whoever takes their account), and
// checkout writes the job's token (actions: write on the run) into
// .git/config for every later step: the rules this repo's own workflows
// keep (supply-chain.unsafe.test.ts).
it('pins every action it writes to a commit SHA and keeps the token out of checkout', async () => {
  for (const lock of ['bun.lock', 'pnpm-lock.yaml']) {
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, lock), '')
    expect(await init({ workers: sizes, adapter: github() })).toBe(0)
    for (const file of [WORKFLOW, '.github/workflows/ci.yml']) {
      const yml = await readFile(path.join(root, file), 'utf8')
      const uses = [...yml.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)]
      expect(uses.length).toBeGreaterThan(1)
      expect(
        uses
          .filter((m) => !/@[0-9a-f]{40}$/.test(m[1]!) || !/^\s*# v\d+\.\d+\.\d+$/.test(m[2]!))
          .map((m) => m[0].trim()),
      ).toEqual([])
      const doc = Bun.YAML.parse(yml) as {
        jobs: Record<string, { steps: { uses?: string; with?: Record<string, unknown> }[] }>
      }
      const checkouts = Object.values(doc.jobs)
        .flatMap((j) => j.steps)
        .filter((s) => s.uses?.startsWith('actions/checkout@'))
      expect(checkouts.length).toBe(1)
      for (const c of checkouts) expect(c.with?.['persist-credentials']).toBe(false)
    }
  }
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
    expect(yml).toContain("    defaults:\n      run:\n        working-directory: 'ws'\n")
    expect(yml).toContain(
      "      - uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0\n        with: { package_json_file: 'ws/package.json' }\n",
    )
  }
  const relay = 'https://relay.example.com'
  expect(await at({ relay, workers: sizes, adapter: gitlab() })).toBe(0)
  const ci = await readFile(path.join(root, '.gitlab-ci.yml'), 'utf8')
  expect(ci).toContain(
    "    - cd 'ws'\n    - npm install -g --silent bun@1.4\n    - corepack enable\n    - pnpm install --frozen-lockfile\n",
  )
  expect(ci).toContain("    - git checkout -q FETCH_HEAD\n    - cd 'ws'\n")
})

// Written bare, ' #' began a YAML comment: the jobs ran in 'my app', and
// pnpm's step was no YAML at all.
it("quotes the workspace's directory in the GitHub workflows", async () => {
  const dir = "my app #1's"
  for (const manager of ['pnpm', 'bun'] as const) {
    const { files } = await github().init!({
      workspaceRoot: root,
      dir,
      sizes: [{ name: 'small' }],
      manager,
      tasks: { main: '', change: '' },
    })
    for (const text of Object.values(files)) {
      const job = Object.values(
        (Bun.YAML.parse(text) as { jobs: Record<string, Record<string, unknown>> }).jobs,
      )[0]!
      expect(job['defaults']).toEqual({ run: { 'working-directory': dir } })
      const steps = job['steps'] as { uses?: string; with?: unknown }[]
      if (manager === 'pnpm')
        expect(steps.find((s) => s.uses?.startsWith('pnpm/action-setup@'))?.with).toEqual({
          package_json_file: `${dir}/package.json`,
        })
    }
  }
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
  expect(printed.join('')).toContain('── .github/workflows/vx-worker.yml ──\n')
  expect(await init({ workers: sizes, adapter: github() }, '--force')).toBe(0)
  // Its header names the rewrite a size change needs: a plain init refuses it.
  expect(await readFile(path.join(root, WORKFLOW), 'utf8')).toContain('run vx dte init --force')
  printed = []
  expect(await init({ workers: sizes, adapter: github() })).toBe(0)
  expect(printed.join('')).toContain('vx dte init: .github/workflows/vx-worker.yml is up to date')
})

// A repo can carry `.github/workflows/vx-worker.yml -> /anywhere`: init
// wrote through it, outside the repo.
for (const [what, existing] of [
  ['a dangling', false],
  ['an existing', true],
] as const) {
  it(`refuses a workflow that is a link to ${what} file, even under --force`, async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-init-outside-'))
    try {
      const victim = path.join(outside, 'x')
      if (existing) await writeFile(victim, 'mine\n')
      await writeFile(path.join(root, 'bun.lock'), '')
      await mkdir(path.join(root, '.github/workflows'), { recursive: true })
      await symlink(victim, path.join(root, WORKFLOW))
      expect(init({ workers: sizes, adapter: github() }, '--force')).rejects.toThrow(
        `vx dte init: refusing to write ${WORKFLOW}: it is a symlink to ${victim}; remove the link and run again`,
      )
      expect(await readFile(victim, 'utf8').catch(() => null)).toBe(existing ? 'mine\n' : null)
      // Refused before any write.
      expect(
        await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8').catch(() => null),
      ).toBe(null)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
}

it('gitlab() writes one pipeline file: the run, and a job per size only its trigger runs', async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  const adapter = gitlab({ tags: { 'linux.mac': ['saas-macos-medium-m1'] } })
  expect(init({ workers: sizes, adapter })).rejects.toThrow('gitlab() needs dte({ relay })')
  expect(await init({ relay: 'https://relay.example.com', workers: sizes, adapter })).toBe(0)
  const ci = await readFile(path.join(root, '.gitlab-ci.yml'), 'utf8')
  expect(ci).toContain('  id_tokens: { VX_DTE_TOKEN: { aud: https://relay.example.com } }\n')
  expect(ci).toContain('    - if: $CI_PIPELINE_SOURCE == "pipeline" && $VX_DTE_SIZE\n')
  // No task runs on the orchestrator: vx and the plugins only.
  expect(ci).toContain("    - bun install --frozen-lockfile --filter './'\n  script:\n")
  expect(ci).toContain("      variables: { VX_TASKS: '--all' }\n")
  expect(ci).toContain('# Name the tasks in the vx job')
  expect(ci).toContain('    - git fetch -q --depth 1 origin $VX_DTE_SHA\n')
  expect(ci).toContain(
    `'vx-worker linux.mac':\n  extends: .vx-worker\n  parallel:\n    matrix:\n      - VX_DTE_SLOT: ['1', '2']\n  rules: [{ if: $VX_DTE_SIZE == "linux.mac" && $VX_DTE_SLOT =~ $VX_DTE_PICK }]\n  tags: ['saas-macos-medium-m1']\n`,
  )
  expect(ci).toContain(`      - VX_DTE_SLOT: ['1', '2', '3', '4', '5', '6', '7', '8']\n`)
  // A matrix needs its length.
  expect(
    init(
      {
        relay: 'https://r',
        workers: { linux: { machines: { small: { cpu: 2, memory: '8GB' } } } },
        adapter,
      },
      '--force',
    ),
  ).rejects.toThrow('gitlab() needs workers.linux.machines.small.max, 1 to 200')
  expect(ci).not.toContain('bunx')
  expect(printed.join('')).toContain(
    'ALLOW (a plain var, no secret): https://gitlab.com:<group>/<project>:.gitlab-ci.yml',
  )
  expect(printed.join('')).toContain(
    'Let these workflows use the relay at https://relay.example.com: set its ALLOW.',
  )
})

it('gitlab() says to let a developer set pipeline variables, which its trigger passes', async () => {
  // Before: a project made since GitLab 17.7 lets no one set them, so every
  // trigger was refused, 400 "Insufficient permissions to set pipeline variables".
  const { next } = await gitlab().init!({
    workspaceRoot: root,
    dir: '',
    relay: 'https://relay.example.com',
    sizes: [{ name: 'small', max: 4 }],
    manager: 'bun',
    tasks: { main: '', change: '' },
  })
  expect(next.join('\n')).toContain(
    'Settings > CI/CD > Variables: set "Minimum role to use pipeline variables" to Developer',
  )
})

it('gitlab() jobs add git to an image that lacks it, as oven/bun does', async () => {
  // Before: oven/bun has no git, so the run failed "a DTE run needs a git
  // commit" and each worker's `git fetch` was "command not found".
  const ci = (
    await gitlab().init!({
      workspaceRoot: root,
      dir: '',
      relay: 'https://relay.example.com',
      sizes: [{ name: 'small', max: 4 }],
      manager: 'bun',
      tasks: { main: '', change: '' },
    })
  ).files['.gitlab-ci.yml']!
  // By digest: a tag is its publisher's to move (oven/bun's moved on 2026-10-22).
  expect(ci).toMatch(/\n {2}image: oven\/bun:1\.4\.4@sha256:[0-9a-f]{64}\n/)
  const git =
    '    - command -v git || (apt-get update -qq && apt-get install -qq -y --no-install-recommends git)\n'
  expect(ci).toContain(
    `  before_script:\n${git}    - bun install --frozen-lockfile --filter './'\n`,
  )
  expect(ci).toContain(`  before_script:\n${git}    - git fetch -q --depth 1 origin $VX_DTE_SHA\n`)
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
    // A credential never reaches the written files: the userinfo ends at
    // its last `@`, and a query is dropped.
    [
      'https://ci:p@ss@gitlab.example.com:8443/group/app.git',
      'https://gitlab.example.com:8443:group/app',
    ],
    ['https://gitlab.com/group/app.git?private_token=X#f', 'https://gitlab.com:group/app'],
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
export default { plugins: [dte({ workers: { linux: { machines: { small: { cpu: 2, memory: '8GB' } } } }, adapter: github() })] }
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
  expect(r.stdout.toString()).toContain(`'{"linux.small":"ubuntu-latest"}'`)
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
  const small = { linux: { machines: { small: { max: 8, cpu: 4, memory: '16GB' } } } }
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
    sizes: [{ name: 'linux.small', max: 4 }],
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

// Enter at the main question wrote a ci.yml running `vx run --all` with no
// task, which fails, though the workspace declared `pipelines.main`.
it("offers pipelines.main's tasks as main's default, and refuses no tasks", () => {
  const answers = (...a: string[]) => {
    const asked: string[] = []
    return { asked, ask: (q: string) => (asked.push(q), a.shift() ?? '') }
  }
  const enter = answers('', '')
  expect(askTasks('build test', true, enter.ask)).toEqual({
    main: 'build test',
    change: 'build test',
  })
  expect(enter.asked[0]).toBe('Tasks to run on main [build test]:')
  expect(askTasks('build test', true, answers('lint', '').ask)).toEqual({
    main: 'lint',
    change: 'lint',
  })
  expect(() => askTasks(undefined, true, answers('', '').ask)).toThrow(
    'vx dte init: name the tasks main runs, such as build test: a ci.yml that runs none fails',
  )
  expect(askTasks('build test', false, answers().ask)).toEqual({
    main: 'build test',
    change: 'build test',
  })
})

it('writes pipelines.main as the tasks outside a terminal', async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  const plugin = dte({ workers: sizes, adapter: github() })
  await plugin.config!({ pipelines: { main: { tasks: ['build', 'test'] } } }, {} as never)
  await plugin.commands!['dte']!.run(['init'], { workspaceRoot: root } as CommandContext)
  const ci = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  expect(ci).toContain("'build test --affected' || 'build test --all'")
})

it('vx dte --help prints the usage and exits 0', async () => {
  await mkdir(path.join(root, '.vx'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { linux: { machines: { small: { cpu: 2, memory: '8GB' } } } }, adapter: local() })] }
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
      'Usage: vx dte worker | vx dte init [--dry] [--force]\n\n' +
        "  vx dte init      Write the CI that spreads one vx run over this workspace's\n" +
        '                   workers.\n' +
        '      --dry        Print the files instead of writing them.\n' +
        '      --force      Overwrite files that exist.\n' +
        '  vx dte worker    Join the run VX_DTE_RUN names, over VX_DTE_RELAY or\n' +
        '                   dte({ relay }), and run the tasks it is handed. A CI job runs\n' +
        '                   it after install.\n',
    ])
    // Core help is written at 80 columns; this ran to 86.
    expect(
      r.stdout
        .toString()
        .split('\n')
        .filter((l) => l.length > 80),
    ).toEqual([])
  }
})

it('vx dte says what is wrong with the line typed', async () => {
  await mkdir(path.join(root, '.vx'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { linux: { machines: { small: { cpu: 2, memory: '8GB' } } } }, adapter: local() })] }
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
  // A subcommand's refusal is headed by it once: `✗ vx dte  vx dte worker …`
  // named the verb twice.
  expect([
    said([]),
    said(['bogus']),
    said(['worker', '--bogus']),
    said(['worker', 'extra']),
    said(['init', '--bogus']),
  ]).toEqual([
    '✗ vx dte  missing subcommand',
    '✗ vx dte  unknown subcommand: bogus',
    '✗ vx dte worker  unknown flag: --bogus',
    '✗ vx dte worker  unexpected argument: extra',
    '✗ vx dte init  unknown flag: --bogus',
  ])
  // Each is a usage refusal, as core's are, for a reader of the JSON.
  const code = (args: string[]) =>
    JSON.parse(
      Bun.spawnSync([process.execPath, CORE_BIN, 'dte', ...args, '--format=json'], {
        cwd: root,
        stderr: 'pipe',
      }).stdout.toString(),
    ).error.code
  expect([code(['bogus']), code(['worker', '--bogus']), code(['init', '--x'])]).toEqual([
    'VX_E_USAGE',
    'VX_E_USAGE',
    'VX_E_USAGE',
  ])
})

it('a relay URL with no http(s) scheme is refused, named', async () => {
  await mkdir(path.join(root, '.vx'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  const workspace = (relay: string) =>
    writeFile(
      path.join(root, '.vx/workspace.mjs'),
      `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ relay: ${JSON.stringify(relay)}, workers: { linux: { machines: { small: { cpu: 2, memory: '8GB' } } } }, adapter: local() })] }
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
    '✗ vx dte worker  VX_DTE_RELAY must be http(s), got relay.example.com\n',
  )
  // nx#37667: a refusal reaches the CI log, so a `user:pass@` prints as `***`.
  expect(said({ VX_DTE_RELAY: 'wss://u:s3cret@relay.example.com' })).toStartWith(
    '✗ vx dte worker  VX_DTE_RELAY must be http(s), got wss://***@relay.example.com\n',
  )
  await workspace('wss://u:s3cret@relay.example.com')
  expect(said({})).toContain(
    'dte() option "relay" must be an http(s) URL, got "wss://***@relay.example.com"',
  )
  // Each route is appended to the relay's url: past a `?` or `#` every
  // socket asked the relay's root, and one naming /v1 asked /v1/v1/….
  await workspace('https://relay.example.com/?k=1')
  expect(said({})).toContain(
    'dte() option "relay" takes no ?query or #fragment: each route is appended to it, got "https://relay.example.com/?k=1"',
  )
  await workspace('https://relay.example.com/v1/')
  expect(said({})).toContain(
    'dte() option "relay" is the relay\'s base, without /v1, got "https://relay.example.com/v1/"',
  )
  await workspace('https://relay.example.com')
  expect(said({ VX_DTE_RELAY: 'https://relay.example.com#x' })).toStartWith(
    '✗ vx dte worker  VX_DTE_RELAY takes no ?query or #fragment: each route is appended to it, got https://relay.example.com#x\n',
  )
  expect(said({ VX_DTE_RELAY: 'https://relay.example.com/v1' })).toStartWith(
    "✗ vx dte worker  VX_DTE_RELAY is the relay's base, without /v1, got https://relay.example.com/v1\n",
  )
})

it('vx dte worker names only what it lacks', async () => {
  await mkdir(path.join(root, '.vx'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { linux: { machines: { small: { cpu: 2, memory: '8GB' } } } }, adapter: local() })] }
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
    // Empty is unset, as for VX_DTE_SECRET and VX_DTE_WORKER.
    said({ VX_DTE_RUN: crypto.randomUUID(), VX_DTE_RELAY: '' }),
  ]).toEqual([
    '✗ vx dte worker  needs VX_DTE_RUN, and VX_DTE_RELAY or dte({ relay })',
    '✗ vx dte worker  needs VX_DTE_RELAY or dte({ relay })',
    '✗ vx dte worker  needs VX_DTE_RUN',
    '✗ vx dte worker  needs VX_DTE_RELAY or dte({ relay })',
  ])
  // A job without id-token: write has no ACTIONS_ID_TOKEN_REQUEST_TOKEN.
  expect(
    said({
      VX_DTE_SECRET: '',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
      VX_DTE_RUN: crypto.randomUUID(),
      VX_DTE_RELAY: 'http://127.0.0.1:9',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://127.0.0.1:9/token?v=1',
      GITHUB_REPOSITORY_ID: '1',
    }),
  ).toBe(
    '✗ vx dte worker  needs VX_DTE_SECRET, the run’s, or a GitHub Actions job with id-token: write',
  )
})

it('gitlab() runs a pnpm, npm or yarn workspace on an image with Node, adding Bun', async () => {
  // Before: every job ran on oven/bun, which has no Node, npm, pnpm or
  // corepack, so `pnpm install`, `npm ci` and `corepack enable` failed.
  const ciOf = async (manager: 'pnpm' | 'npm' | 'yarn') =>
    (
      await gitlab().init!({
        workspaceRoot: root,
        dir: '',
        relay: 'https://relay.example.com',
        sizes: [{ name: 'small', max: 4 }],
        manager,
        tasks: { main: '', change: '' },
      })
    ).files['.gitlab-ci.yml']!
  const pnpm = await ciOf('pnpm')
  expect(pnpm).toContain('  image: node:22.23.4@sha256:')
  expect(pnpm).toContain(
    '    - npm install -g --silent bun@1.4\n    - corepack enable\n    - pnpm install --frozen-lockfile\n',
  )
  expect(await ciOf('npm')).toContain('    - npm install -g --silent bun@1.4\n    - npm ci\n')
  expect(await ciOf('yarn')).toContain(
    '    - npm install -g --silent bun@1.4\n    - corepack enable\n    - yarn install --frozen-lockfile\n',
  )
})

interface Step {
  if?: string
  run?: string
  uses?: string
}
const workflowOf = async (
  file: string,
): Promise<{
  on: { workflow_dispatch?: { inputs: Record<string, unknown> } }
  permissions?: Record<string, string>
  jobs: Record<string, { steps: Step[]; permissions?: Record<string, string> }>
}> => Bun.YAML.parse(await readFile(path.join(root, file), 'utf8')) as never

// The worker is one command (2026-11-20): joining, leaving a run that is
// over and cancelling its queued fellows, the run's variables, all are
// `vx dte worker`'s. The job only checks out, sets up Bun and installs.
it("github()'s worker job is checkout, Bun, install and vx dte worker; the run's job cleans up nothing", async () => {
  await writeFile(path.join(root, 'bun.lock'), '')
  expect(await init({ workers: sizes, adapter: github() })).toBe(0)
  const wf = await workflowOf(WORKFLOW)
  expect(Object.keys(wf.on.workflow_dispatch!.inputs)).toEqual([
    'run',
    'relay',
    'sha',
    'size',
    'workers',
    'env',
  ])
  // Cancelling its own run: the job's write, never the workflow's.
  expect(wf.permissions?.['actions']).toBeUndefined()
  expect(wf.jobs['worker']!.permissions?.['actions']).toBe('write')
  expect(wf.jobs['worker']!.steps.map((s) => s.uses?.split('@')[0] ?? s.run)).toEqual([
    'actions/checkout',
    'oven-sh/setup-bun',
    'bun install --frozen-lockfile',
    'bun vx dte worker',
  ])
  const ci = await workflowOf('.github/workflows/ci.yml')
  expect(ci.jobs['vx']!.steps.some((s) => s.if !== undefined)).toBe(false)
  expect(ci.jobs['vx']!.steps.at(-1)!.run).toStartWith('bun vx run ')
})
