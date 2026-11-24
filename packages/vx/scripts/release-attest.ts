// The `release.github.<os>.attest` tasks: a Sigstore-signed build-provenance
// attestation of the `vx-<os>-*` binaries, before release-assets.ts attaches
// them (L-12). `vx upgrade` checks the SHA-256 the release API publishes,
// which proves the transfer, not who built the bytes; this does
// (`gh attestation verify vx-<target> --repo vznjs/vx`). The release runs on
// DTE workers, so the attestation is a task, not the attest-build-provenance
// action: @actions/attest is that action's own library (dependency reason).
// The darwin one runs after its re-sign: the bytes that ship are attested.
//
//   GH_TOKEN=… bun scripts/release-attest.ts <linux|darwin>

import { readdirSync } from 'node:fs'
import path from 'node:path'

const DIST = path.join(import.meta.dir, '..', 'dist')

/** The binaries of `os` under `files`, sorted; none refuses. */
export function binariesOf(os: 'linux' | 'darwin', files: readonly string[]): string[] {
  const out = files.filter(
    (f) => /^vx-(linux|darwin)-(x64|arm64)$/.test(f) && f.startsWith(`vx-${os}-`),
  )
  if (out.length === 0) throw new Error(`no vx-${os}-* binary under ${DIST}`)
  return out.sort()
}

async function main(): Promise<void> {
  const os = process.argv[2]
  if (os !== 'linux' && os !== 'darwin') throw new Error('usage: release-attest.ts <linux|darwin>')
  const token = process.env['GH_TOKEN']
  if (!token) throw new Error('GH_TOKEN is not set')
  const subjects = await Promise.all(
    binariesOf(os, readdirSync(DIST)).map(async (name) => ({
      name,
      digest: {
        sha256: new Bun.CryptoHasher('sha256')
          .update(await Bun.file(path.join(DIST, name)).bytes())
          .digest('hex'),
      },
    })),
  )
  // By path, not by name: a Mac sandbox may not list the workspace root
  // (seatbelt.ts, darwinAncestorRules), so Bun's name lookup never found the
  // root's node_modules. The task reads that path, and @vzn/vx declares no
  // dependency for a release script.
  const { attestProvenance } = (await import(
    path.join(import.meta.dir, '..', '..', '..', 'node_modules', '@actions', 'attest')
  )) as typeof import('@actions/attest')
  const { attestationID } = await attestProvenance({ subjects, token, sigstore: 'public-good' })
  console.log(`attested ${subjects.map((s) => s.name).join(', ')} (attestation ${attestationID})`)
}

if (import.meta.main) await main()
