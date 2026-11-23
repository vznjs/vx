// Every binary a release attaches carries a build-provenance attestation of
// the same files (L-12). `vx upgrade` checks the SHA-256 the release API
// publishes, which comes from the same place as the asset, so it proves the
// transfer and not who built the bytes; a Sigstore-signed attestation
// (`gh attestation verify vx-<target> --repo vznjs/vx`) does. The release
// runs on DTE workers, so the attestation is a task (scripts/release-attest.ts)
// each upload depends on.
//
// `.unsafe`: the workflows live at the repo root, which a sandboxed project
// task may not read (the cross-project law).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import config from '../vx.config.ts'
import { binariesOf } from '../scripts/release-attest.ts'

const workflow = path.resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'release.yml',
)
const tasks = config.tasks ?? {}

describe('a release attests what it ships (L-12)', () => {
  it('each upload follows an attestation of the same binaries, darwin after its re-sign', () => {
    for (const os of ['linux', 'darwin']) {
      expect(tasks[`release.github.${os}.upload`]?.dependsOn).toContain(
        `release.github.${os}.attest`,
      )
      expect(tasks[`release.github.${os}.attest`]?.dependsOn).toContain(`release.npm.${os}.prove`)
      expect(tasks[`release.github.${os}.attest`]?.exec?.command).toBe(
        `bun scripts/release-attest.ts ${os}`,
      )
    }
  })

  it('attests the binaries of one platform, and refuses none', () => {
    const dist = [
      'vx-linux-x64',
      'vx-darwin-arm64',
      'vx-linux-arm64',
      'vx-darwin-x64.cstemp',
      'npm',
    ]
    expect(binariesOf('linux', dist)).toEqual(['vx-linux-arm64', 'vx-linux-x64'])
    expect(binariesOf('darwin', dist)).toEqual(['vx-darwin-arm64'])
    expect(() => binariesOf('linux', ['npm'])).toThrow('no vx-linux-* binary')
  })

  it('runs in a job that holds the permissions an attestation needs, the workflow none', () => {
    const wf = Bun.YAML.parse(readFileSync(workflow, 'utf8')) as {
      permissions?: object
      jobs: Record<string, { permissions?: Record<string, string> }>
    }
    expect(wf.permissions).toEqual({})
    const p = wf.jobs['release']?.permissions
    expect([p?.['id-token'], p?.['attestations']]).toEqual(['write', 'write'])
  })
})
