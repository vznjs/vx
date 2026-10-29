// compose.yaml hands each server the settings its README names: a
// variable the file leaves out never reaches the container, whatever the
// shell or the .env beside it says.
import path from 'node:path'
import { expect, it } from 'bun:test'

interface Compose {
  services: Record<string, { environment?: string[] }>
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
