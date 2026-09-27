// auto-release.yml releases every green commit on main: it tags it, creates
// the GitHub release, and dispatches release.yml and npm.yml — a release made
// with the workflow token fires no `release` event, so without those
// dispatches the tag would exist and nothing would be built or published. The
// rows read the three workflow files, so a renamed input, a dropped trigger or
// a release.yml that only knows the release event fails here, not on the
// first merge after it.
//
// `.unsafe`: the workflows live at the repo root, which a sandboxed project
// task may not read (the cross-project law).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const workflowDir = path.resolve(import.meta.dir, '..', '..', '..', '.github', 'workflows')

interface Step {
  run?: string
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
const script = (job?.steps ?? []).map((s) => s.run ?? '').join('\n')

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

  it('skips a commit the last release is not behind, and one already tagged', () => {
    expect(script).toContain('git merge-base --is-ancestor "$last" "$SHA"')
    expect(script).toContain('git tag --points-at "$SHA"')
    expect(script).not.toContain('refs/heads/main')
  })

  it('holds only the two grants it uses, and none at the top', () => {
    expect(auto.permissions).toEqual({})
    expect(job?.permissions).toEqual({ contents: 'write', actions: 'write' })
  })

  it('dispatches release.yml and npm.yml with inputs each of them declares', () => {
    const dispatched = new Map<string, string[]>()
    for (const m of script.matchAll(/gh workflow run (\S+\.yml)([^\n]*)/g)) {
      dispatched.set(
        m[1]!,
        [...m[2]!.matchAll(/-f (\w+)=/g)].map((f) => f[1]!),
      )
    }
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

  it('release.yml reads its tag from a dispatch as well as a release event', () => {
    const release = text('release.yml')
    expect(release.match(/github\.event\.release\.tag_name(?! \|\| inputs\.tag)/g)).toBeNull()
    expect(release).toContain('github.event.release.tag_name || inputs.tag')
  })
})
