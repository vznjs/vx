// Every binary release.yml attaches to a release carries a build-provenance
// attestation of the same files (L-12). `vx upgrade` checks the SHA-256 the
// release API publishes, which comes from the same place as the asset, so
// it proves the transfer and not who built the bytes; a Sigstore-signed
// attestation (`gh attestation verify vx-<target> --repo vznjs/vx`) does.
//
// `.unsafe`: the workflows live at the repo root, which a sandboxed project
// task may not read (the cross-project law).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const file = path.resolve(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'release.yml')

interface Step {
  uses?: string
  with?: Record<string, string>
}
interface Workflow {
  permissions?: Record<string, string>
  jobs: Record<string, { permissions?: Record<string, string>; steps?: Step[] }>
}

const wf = Bun.YAML.parse(readFileSync(file, 'utf8')) as Workflow
const action = (s: Step): string => (s.uses ?? '').split('@')[0]!

describe('release.yml attests what it ships (L-12)', () => {
  it('each upload of files to a release follows an attestation of the same files', () => {
    const uploads: string[] = []
    const unattested: string[] = []
    for (const [name, job] of Object.entries(wf.jobs)) {
      const steps = job.steps ?? []
      steps.forEach((s, i) => {
        if (action(s) !== 'softprops/action-gh-release' || s.with?.['files'] === undefined) return
        const files = s.with['files']
        uploads.push(`${name}: ${files}`)
        const attested = steps
          .slice(0, i)
          .some(
            (p) =>
              action(p) === 'actions/attest-build-provenance' && p.with?.['subject-path'] === files,
          )
        if (!attested) unattested.push(`${name}: ${files}`)
      })
    }
    // The positive: the two uploads the release makes.
    expect(uploads).toEqual([
      'assets: packages/vx/dist/vx-linux-*',
      'sign-darwin: dist/vx-darwin-*',
    ])
    expect(unattested).toEqual([])
  })

  it('holds the permissions an attestation needs, the action pinned by commit', () => {
    const perms = wf.permissions ?? {}
    expect({ id: perms['id-token'], attestations: perms['attestations'] }).toEqual({
      id: 'write',
      attestations: 'write',
    })
    const pins = Object.values(wf.jobs)
      .flatMap((j) => j.steps ?? [])
      .filter((s) => action(s) === 'actions/attest-build-provenance')
      .map((s) => /@[0-9a-f]{40}$/.test(s.uses ?? ''))
    expect(pins).toEqual([true, true])
  })
})
