// scripts/deploy-pages.ts against a fake GitHub: the Results service, the
// blob store, the OIDC endpoint and the Pages API, in the order the Pages
// actions call them.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { backendIds, deploy, readEnv, zipStored } from '../scripts/deploy-pages.js'

const jwt = (claims: object): string =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')
const TOKEN = jwt({ scp: 'Actions.GenericRead:x Actions.Results:run-1:job-2' })

it('reads the run and job from the runtime token', () => {
  expect(backendIds(TOKEN)).toEqual({ run: 'run-1', job: 'job-2' })
  expect(() => backendIds(jwt({ scp: 'Actions.GenericRead:x' }))).toThrow('no Actions.Results')
})

it('zips one file that unzip reads back', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zip-'))
  const data = new TextEncoder().encode('hello pages\n'.repeat(100))
  writeFileSync(path.join(dir, 'a.zip'), zipStored('artifact.tar', data))
  const r = Bun.spawnSync(['unzip', '-o', '-q', 'a.zip'], { cwd: dir })
  expect(r.exitCode).toBe(0)
  expect(readFileSync(path.join(dir, 'artifact.tar'), 'utf8')).toBe('hello pages\n'.repeat(100))
})

it('names what the job did not give it', () => {
  expect(() => readEnv({ GITHUB_TOKEN: 't' })).toThrow('ACTIONS_RUNTIME_TOKEN')
})

function fake(statuses: string[]) {
  const calls: string[] = []
  let uploaded: Uint8Array | undefined
  let finalized: any
  let deployed: any
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      calls.push(`${req.method} ${url.pathname}`)
      const auth = req.headers.get('authorization')
      if (url.pathname.endsWith('/CreateArtifact')) {
        expect(auth).toBe(`Bearer ${TOKEN}`)
        const body = await req.json()
        expect(body).toMatchObject({
          workflowRunBackendId: 'run-1',
          workflowJobRunBackendId: 'job-2',
          name: 'github-pages',
        })
        return Response.json({ ok: true, signedUploadUrl: `${url.origin}/blob?sig=1` })
      }
      if (url.pathname === '/blob') {
        expect(req.headers.get('x-ms-blob-type')).toBe('BlockBlob')
        uploaded = new Uint8Array(await req.arrayBuffer())
        return new Response(null, { status: 201 })
      }
      if (url.pathname.endsWith('/FinalizeArtifact')) {
        finalized = await req.json()
        return Response.json({ ok: true, artifactId: '42' })
      }
      if (url.pathname === '/oidc') {
        expect(auth).toBe('Bearer id-req')
        return Response.json({ value: 'oidc-jwt' })
      }
      if (url.pathname === '/repos/o/r/pages/deployments' && req.method === 'POST') {
        expect(auth).toBe('Bearer gh')
        deployed = await req.json()
        return Response.json({ id: 'sha1', page_url: 'https://o.github.io/r/' })
      }
      if (url.pathname === '/repos/o/r/pages/deployments/sha1') {
        const status = statuses.shift()!
        return status === '502' ? new Response('bad', { status: 502 }) : Response.json({ status })
      }
      return new Response('no', { status: 404 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const env = readEnv({
    ACTIONS_RUNTIME_TOKEN: TOKEN,
    ACTIONS_RESULTS_URL: `${origin}/`,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/oidc`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'id-req',
    GITHUB_TOKEN: 'gh',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_SHA: 'sha1',
    GITHUB_API_URL: origin,
  })
  return {
    env,
    calls,
    server,
    got: () => ({ uploaded, finalized, deployed }),
  }
}

it('uploads the artifact, deploys it and waits for it to go live', async () => {
  const f = fake(['deployment_queued', '502', 'deployment_attempt_error', 'succeed'])
  const tar = new TextEncoder().encode('tar bytes')
  const lines: string[] = []
  await deploy(tar, f.env, { every: 1, log: (l) => lines.push(l) })
  const { uploaded, finalized, deployed } = f.got()
  expect(uploaded).toEqual(zipStored('artifact.tar', tar))
  expect(finalized).toMatchObject({ size: String(uploaded!.length), name: 'github-pages' })
  expect(finalized.hash).toBe(
    `sha256:${new Bun.CryptoHasher('sha256').update(uploaded!).digest('hex')}`,
  )
  expect(deployed).toEqual({ artifact_id: 42, pages_build_version: 'sha1', oidc_token: 'oidc-jwt' })
  expect(lines.at(-1)).toBe('deploy-pages: live at https://o.github.io/r/')
  await f.server.stop()
})

it('fails on a final deployment status, naming it', async () => {
  const f = fake(['deployment_queued', 'deployment_content_failed'])
  await expect(deploy(new Uint8Array(1), f.env, { every: 1, log: () => {} })).rejects.toThrow(
    'deployment deployment_content_failed',
  )
  await f.server.stop()
})
