// auto-release.yml releases on demand a commit whose CI went green on main:
// its `release.github.tag` task (scripts/auto-release.ts) picks it, tags it, creates the GitHub release as a
// draft (npm.yml's last upload publishes it), and
// dispatches npm.yml on the tag — a release made with the workflow token
// fires no `release` event, so without that dispatch the tag would exist
// and nothing would be built or published. The rows read both workflow
// files, so a dropped trigger or an npm.yml that only knows the release
// event fails here, not on the first merge after it. Which commit is
// released is tests/release.test.ts's.
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
  environment?: string
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
  it('runs on a dispatch alone, with an optional commit', () => {
    expect(triggers(auto)).toEqual({
      workflow_dispatch: {
        inputs: {
          sha: {
            description:
              'Commit on main to release; empty releases the newest one whose CI went green.',
            required: false,
            default: '',
          },
        },
      },
    })
    expect(job?.if).toBeUndefined()
  })

  it('runs release.github.tag on main with every tag checked out, for the dispatched commit', () => {
    expect(runs.map((s) => [s.run, s.env])).toEqual([
      ['bun install --frozen-lockfile', undefined],
      ['bun packages/vx/src/bin.ts setup github', undefined],
      [
        'bun packages/vx/src/bin.ts run release.github.tag --filter @vzn/vx',
        {
          VX_RELEASE_SHA: '${{ inputs.sha }}',
          GH_TOKEN: '${{ github.token }}',
        },
      ],
    ])
    const checkout = job?.steps?.find((s) => s.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with).toEqual({ ref: 'main', 'fetch-depth': 0, 'persist-credentials': false })
  })

  it('holds only the grants it uses, and none at the top', () => {
    expect(auto.permissions).toEqual({})
    expect(job?.permissions).toEqual({
      contents: 'write',
      actions: 'write',
      'id-token': 'write',
    })
  })

  it('dispatches npm.yml on the tag, which names the version', () => {
    expect(dispatches('1.2.3')).toEqual([{ workflow: 'npm.yml', ref: 'v1.2.3' }])
  })

  // An immutable release takes assets only as a draft, so npm.yml is
  // dispatched for one; a `release: published` run could attach nothing.
  it('npm.yml runs on a dispatch alone and reads its version from the tag', () => {
    expect(triggers(parse('npm.yml'))).toEqual({ workflow_dispatch: null })
    const release = parse('npm.yml').jobs?.['release']
    expect(text('npm.yml')).not.toContain('github.event.release')
    expect((release as { env?: Record<string, string> }).env?.['VX_RELEASE_VERSION']).toBe(
      '${{ github.ref_name }}',
    )
  })
})

// A dispatch builds whatever `ref`/`tag` names: any token with
// `actions: write` (every pull request's DTE run holds one) could publish
// a branch's code to npm with provenance, or attest it as a release.
describe('the publishing workflow', () => {
  const release = (): Job => parse('npm.yml').jobs!['release']!

  // A dispatch on a branch checks the branch out: the job runs on a tag only.
  it('runs on a release tag only, checked out as dispatched', () => {
    expect(release().if).toBe("startsWith(github.ref, 'refs/tags/v')")
    const checkout = release().steps?.find((s) => s.uses?.startsWith('actions/checkout'))
    expect(checkout?.with).toEqual({ 'persist-credentials': false })
  })

  // npm's trusted publisher, bound to this environment, takes a token
  // only from a job the environment's rule admitted. The workers publish
  // with this job's OIDC token (a task runs with its run's environment).
  it('publishes to npm from the npm environment', () => {
    expect(release().environment).toBe('npm')
    expect(Object.keys(parse('npm.yml').jobs ?? {})).toEqual(['release'])
  })
})
