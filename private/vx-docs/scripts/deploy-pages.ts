// Deploys dist/ to GitHub Pages from inside the run, as soon as the build
// is done: actions/upload-pages-artifact and actions/deploy-pages ran after
// the whole run, 33 s of main's workflow (2026-10-24). The same protocol
// they speak: dist as `artifact.tar`, zipped into the `github-pages`
// artifact of this job (the Results service, by the job's runtime token,
// which GitHub hands only to JavaScript actions: ci.yml exports it), then a
// Pages deployment of that artifact by the job's OIDC token, waited on.

import { createHash } from 'node:crypto'

/** A zip holding one file, stored: what upload-artifact makes of `artifact.tar`. */
export function zipStored(name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const file = new TextEncoder().encode(name)
  const crc = Bun.hash.crc32(data)
  const local = new DataView(new ArrayBuffer(30))
  local.setUint32(0, 0x04034b50, true)
  local.setUint16(4, 20, true)
  local.setUint32(14, crc, true)
  local.setUint32(18, data.length, true)
  local.setUint32(22, data.length, true)
  local.setUint16(26, file.length, true)
  const central = new DataView(new ArrayBuffer(46))
  central.setUint32(0, 0x02014b50, true)
  central.setUint16(4, 20, true)
  central.setUint16(6, 20, true)
  central.setUint32(16, crc, true)
  central.setUint32(20, data.length, true)
  central.setUint32(24, data.length, true)
  central.setUint16(28, file.length, true)
  const centralAt = 30 + file.length + data.length
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, 1, true)
  end.setUint16(10, 1, true)
  end.setUint32(12, 46 + file.length, true)
  end.setUint32(16, centralAt, true)
  const parts = [local, file, data, central, file, end].map((p) =>
    p instanceof DataView ? new Uint8Array(p.buffer) : p,
  )
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export interface DeployEnv {
  ACTIONS_RUNTIME_TOKEN: string
  ACTIONS_RESULTS_URL: string
  ACTIONS_ID_TOKEN_REQUEST_URL: string
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: string
  GITHUB_TOKEN: string
  GITHUB_REPOSITORY: string
  GITHUB_SHA: string
  GITHUB_API_URL?: string
}

const NEEDED = [
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RESULTS_URL',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_REPOSITORY',
  'GITHUB_SHA',
] as const

export function readEnv(env: Record<string, string | undefined>): DeployEnv {
  const missing = NEEDED.filter((k) => !env[k])
  if (missing.length > 0) throw new Error(`deploy-pages: ${missing.join(', ')} not set`)
  return env as unknown as DeployEnv
}

/** The run and job ids the Results service files an artifact under, from the token's scope. */
export function backendIds(token: string): { run: string; job: string } {
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
  for (const scope of String(claims.scp ?? '').split(' ')) {
    const [kind, run, job] = scope.split(':')
    if (kind === 'Actions.Results' && run && job) return { run, job }
  }
  throw new Error('deploy-pages: the runtime token names no Actions.Results scope')
}

/** The statuses deploy-pages gives up on; any other but `succeed` is asked again. */
const FINAL_ERRORS = new Set([
  'deployment_failed',
  'deployment_content_failed',
  'deployment_cancelled',
  'deployment_lost',
])

async function call(what: string, res: Response): Promise<any> {
  if (!res.ok) throw new Error(`deploy-pages: ${what}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? undefined : res.json()
}

export async function deploy(
  tar: Uint8Array,
  env: DeployEnv,
  opts: { every?: number; deadline?: number; log?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? ((l) => console.log(l))
  const api = env.GITHUB_API_URL ?? 'https://api.github.com'
  const { run, job } = backendIds(env.ACTIONS_RUNTIME_TOKEN)
  const ids = { workflowRunBackendId: run, workflowJobRunBackendId: job, name: 'github-pages' }
  const twirp = (method: string, body: unknown): Promise<any> =>
    fetch(
      new URL(
        `/twirp/github.actions.results.api.v1.ArtifactService/${method}`,
        env.ACTIONS_RESULTS_URL,
      ),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.ACTIONS_RUNTIME_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    ).then((r) => call(method, r))

  const zip = zipStored('artifact.tar', tar)
  const created = await twirp('CreateArtifact', {
    ...ids,
    mimeType: 'application/zip',
    version: 7,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  })
  await call(
    'upload',
    await fetch(created.signedUploadUrl, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/zip' },
      body: zip,
    }),
  )
  const sha256 = createHash('sha256').update(zip).digest('hex')
  const { artifactId } = await twirp('FinalizeArtifact', {
    ...ids,
    size: String(zip.length),
    hash: `sha256:${sha256}`,
  })
  log(`deploy-pages: artifact ${artifactId}, ${zip.length} bytes`)

  const oidc = await fetch(env.ACTIONS_ID_TOKEN_REQUEST_URL, {
    headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  }).then((r) => call('OIDC token', r))
  const gh = { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' }
  const deployment = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/pages/deployments`, {
    method: 'POST',
    headers: { ...gh, 'content-type': 'application/json' },
    body: JSON.stringify({
      artifact_id: Number(artifactId),
      pages_build_version: env.GITHUB_SHA,
      oidc_token: oidc.value,
    }),
  }).then((r) => call('create deployment', r))
  log(`deploy-pages: deployment ${deployment.id}`)

  const deadline = performance.now() + (opts.deadline ?? 600_000)
  for (let errors = 0; ;) {
    let status: string
    try {
      ;({ status } = await fetch(
        `${api}/repos/${env.GITHUB_REPOSITORY}/pages/deployments/${deployment.id}`,
        { headers: gh },
      ).then((r) => call('deployment status', r)))
    } catch (err) {
      // As deploy-pages: a status read may fail a few times; the tenth fails the deploy.
      if (++errors >= 10) throw err
      log(`${(err as Error).message}; asking again`)
      status = 'unknown'
    }
    if (status === 'succeed') return log(`deploy-pages: live at ${deployment.page_url}`)
    if (FINAL_ERRORS.has(status)) throw new Error(`deploy-pages: deployment ${status}`)
    if (performance.now() > deadline)
      throw new Error(`deploy-pages: still ${status} at the deadline`)
    await Bun.sleep(opts.every ?? 2_000)
  }
}

if (import.meta.main) {
  // As upload-pages-artifact makes it: links followed, `.git` left out.
  const tar = Bun.spawnSync(
    ['tar', '--dereference', '--hard-dereference', '--exclude=.git', '-C', 'dist', '-cf', '-', '.'],
    { stderr: 'inherit' },
  )
  if (tar.exitCode !== 0) process.exit(tar.exitCode ?? 1)
  await deploy(tar.stdout, readEnv(process.env))
}
