// The newest numbers Bench measured on main (bench.yml's `bench-data`
// artifact) → measured/live.json, which main's deploy builds the site
// from (deploy.pages). The deploy is a task of main's DTE run, and the
// committed src/data/bench.json is older than the live numbers
// (2026-11-01); none found fails the deploy, never ships the committed copy.

import { inflateRawSync } from 'node:zlib'

export interface LiveEnv {
  GITHUB_TOKEN: string
  GITHUB_REPOSITORY: string
  GITHUB_API_URL?: string
}

/** The one named file of a zip, by its central directory: upload-artifact's local headers carry no sizes. */
export function unzipOne(zip: Uint8Array, name: string): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let end = zip.length - 22
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0) throw new Error('live-bench: not a zip')
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('live-bench: bad zip directory')
    const method = view.getUint16(at + 10, true)
    const size = view.getUint32(at + 20, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const entry = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen))
    names.push(entry)
    if (entry === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      const data = zip.subarray(start, start + size)
      if (method === 0) return data
      if (method === 8) return new Uint8Array(inflateRawSync(data))
      throw new Error(`live-bench: ${name} is compressed by method ${method}`)
    }
    at += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`live-bench: no ${name} in the zip (${names.join(', ') || 'empty'})`)
}

interface Artifact {
  archive_download_url: string
  expired: boolean
  workflow_run?: { id: number; head_branch: string }
}

/** The newest unexpired `bench-data` a run on main uploaded, and the run that did. */
export async function newestBench(env: LiveEnv): Promise<{ run: number; json: string }> {
  const api = env.GITHUB_API_URL ?? 'https://api.github.com'
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
  }
  const res = await fetch(
    `${api}/repos/${env.GITHUB_REPOSITORY}/actions/artifacts?name=bench-data&per_page=30`,
    { headers },
  )
  if (!res.ok) throw new Error(`live-bench: list artifacts: ${res.status} ${await res.text()}`)
  // The API lists the newest first.
  const { artifacts } = (await res.json()) as { artifacts: Artifact[] }
  const found = artifacts.find((a) => a.workflow_run?.head_branch === 'main' && !a.expired)
  if (!found) throw new Error('live-bench: no bench-data artifact from main')
  const zip = await fetch(found.archive_download_url, { headers })
  if (!zip.ok) throw new Error(`live-bench: download: ${zip.status} ${await zip.text()}`)
  const json = new TextDecoder().decode(
    unzipOne(new Uint8Array(await zip.arrayBuffer()), 'bench.json'),
  )
  JSON.parse(json)
  return { run: found.workflow_run!.id, json }
}

if (import.meta.main) {
  const env = process.env
  const missing = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'].filter((k) => !env[k])
  if (missing.length > 0) throw new Error(`live-bench: ${missing.join(', ')} not set`)
  const { run, json } = await newestBench(env as unknown as LiveEnv)
  await Bun.write('measured/live.json', json)
  console.log(`live-bench: measured/live.json from Bench run ${run}`)
}
