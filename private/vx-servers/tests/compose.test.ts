// compose.yaml hands each server the settings its README names: a
// variable the file leaves out never reaches the container, whatever the
// shell or the .env beside it says.
import path from 'node:path'
import { expect, it } from 'bun:test'

interface Compose {
  services: Record<string, { environment?: string[]; ports?: string[]; volumes?: string[] }>
}

const compose = Bun.YAML.parse(
  await Bun.file(path.join(import.meta.dir, '..', 'compose.yaml')).text(),
) as Compose

// What Bun's S3 client reads, the cache's bucket settings (its README):
// temporary credentials carry a session token, refused without it.
it('hands the cache every S3 setting Bun’s client reads', () => {
  expect(compose.services['cache']!.environment).toEqual(
    expect.arrayContaining([
      'S3_BUCKET',
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_SESSION_TOKEN',
    ]),
  )
})

// Each setting a server's Bun entry reads (its usage and README), by the
// name inside the container: a probe ran each with these and nothing else.
it('hands each server every setting it reads, on its 8080, the timings on /data', () => {
  const names = (svc: string) =>
    compose.services[svc]!.environment!.map((e) => e.split('=')[0]!).toSorted((a, b) =>
      a.localeCompare(b),
    )
  expect(names('dte')).toEqual(['ALLOW', 'AUDIENCE'])
  expect(names('cache')).toEqual(
    expect.arrayContaining([
      'ALLOW',
      'AUDIENCE',
      'MAX_CHECK_HASHES',
      'MAX_UPLOAD_BYTES',
      'READ_ACCESS',
    ]),
  )
  expect(names('history')).toEqual(['ALLOW', 'AUDIENCE', 'READ_ACCESS', 'TIMING_DAYS'])
  for (const svc of ['dte', 'cache', 'history'])
    expect(compose.services[svc]!.ports!.map((p) => p.split(':').at(-1))).toEqual(['8080'])
  // The image's --db is /data/vx-history.sqlite.
  expect(compose.services['history']!.volumes).toEqual(['history:/data'])
})
