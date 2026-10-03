// auto-release.yml releases every green commit on main: its `release.auto`
// task (scripts/auto-release.ts) tags it, creates the GitHub release as a
// draft (release.yml's last upload publishes it), and
// dispatches release.yml and npm.yml — a release made with the workflow token
// fires no `release` event, so without those dispatches the tag would exist
// and nothing would be built or published. The rows read the three workflow
// files, so a renamed input, a dropped trigger or a release.yml that only
// knows the release event fails here, not on the first merge after it. Which
// commit is released is tests/release.test.ts's.
//
// `.unsafe`: the workflows live at the repo root, which a sandboxed project
// task may not read (the cross-project law).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { dispatches } from '../scripts/auto-release.js'

const workflowDir = path.resolve(import.meta.dir, '..', '..', '..', '.github', 'workflows')

interface Step {
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Job {
  if?: string
  permissions?: Record<string, string>
  steps?: Step[]
}
interface Workflow {
  name?: string
  permissions?: Record<string, string>
  jobs?: Record<string, Job>
  [trigger: string]: unknown
}

const text = (file: string): string => readFileSync(path.join(workflowDir, file), 'utf8')
const parse = (file: string): Workflow => Bun.YAML.parse(text(file)) as Workflow
// A YAML 1.1 reader turns the key `on` into `true`; take whichever came back.
const triggers = (wf: Workflow): Record<string, unknown> =>
  (wf['on'] ?? wf['true'] ?? {}) as Record<string, unknown>

const auto = parse('auto-release.yml')
const job = auto.jobs?.['release']
const runs = (job?.steps ?? []).filter((s) => s.run !== undefined)

describe('auto-release.yml', () => {
  it('fires when the workflow named by ci.yml completes on main', () => {
    const ciName = parse('ci.yml').name
    expect(ciName).toBeString()
    expect(triggers(auto)).toEqual({
      workflow_run: { workflows: [ciName], types: ['completed'], branches: ['main'] },
    })
  })

  it('releases only a green push, never a pull request or a failed run', () => {
    expect(job?.if).toBe(
      "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'",
    )
  })

  it('runs release.auto on the commit whose CI went green, with every tag checked out', () => {
    expect(runs.map((s) => [s.run, s.env])).toEqual([
      ['bun install --frozen-lockfile', undefined],
      [
        'bun packages/vx/src/bin.ts run release.auto --filter @vzn/vx',
        {
          VX_RELEASE_SHA: '${{ github.event.workflow_run.head_sha }}',
          GH_TOKEN: '${{ github.token }}',
        },
      ],
    ])
    const checkout = job?.steps?.find((s) => s.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with).toEqual({
      ref: '${{ github.event.workflow_run.head_sha }}',
      'fetch-depth': 0,
    })
  })

  it('holds only the two grants it uses, and none at the top', () => {
    expect(auto.permissions).toEqual({})
    expect(job?.permissions).toEqual({ contents: 'write', actions: 'write' })
  })

  it('dispatches release.yml and npm.yml with inputs each of them declares', () => {
    const dispatched = new Map(dispatches('1.2.3').map((d) => [d.workflow, Object.keys(d.inputs)]))
    expect([...dispatched.keys()].sort()).toEqual(['npm.yml', 'release.yml'])
    for (const [file, fields] of dispatched) {
      const inputs = Object.keys(
        (triggers(parse(file))['workflow_dispatch'] as { inputs?: object } | undefined)?.inputs ??
          {},
      )
      const undeclared = fields.filter((f) => !inputs.includes(f))
      expect({ file, undeclared }).toEqual({ file, undeclared: [] })
    }
  })

  // An immutable release takes assets only as a draft, so release.yml is
  // dispatched for one; a `release: published` run could attach nothing.
  it('release.yml runs on a dispatch alone and reads its tag from it', () => {
    expect(Object.keys(triggers(parse('release.yml')))).toEqual(['workflow_dispatch'])
    const release = text('release.yml')
    expect(release).not.toContain('github.event.release')
    expect(release).toContain('${{ inputs.tag }}')
  })
})
